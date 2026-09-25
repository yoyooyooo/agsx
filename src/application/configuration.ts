import { Effect } from "effect";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { attempt, invariant, problem, record, text } from "../domain/errors.js";
import type { Input } from "../domain/commands.js";
import { validateConfig, validateContext, type Config, type Target } from "../domain/model.js";
import {
  Settings,
  atomicPrivate,
  fingerprint,
  privateBytes,
  privateDirectory,
} from "../platform/store.js";
import { HttpTransport, expectStatus } from "../platform/http.js";
import { authenticateNative, connection, obtainGrant, publicCredential } from "./identity.js";
import { contextForEndpoint, parseOrigin, publicTarget, resolveTarget } from "./routing.js";
import { ProcessRunner } from "../platform/process.js";

export const configurationCommand = (name: string, input: Input) =>
  Effect.gen(function* () {
    const settings = yield* Settings,
      cfg = yield* settings.read();
    if (name === "context.list")
      return {
        contexts: cfg.contexts,
        defaultContext: cfg.defaultContext ?? null,
        configHash: fingerprint(cfg),
        credentialRead: false,
      };
    if (name === "context.export") {
      const contextName = String(input.name),
        c = cfg.contexts[contextName];
      yield* attempt("context", () => invariant(c, "Context not found.", "config_error"));
      return {
        schema: "agsx.context-export.v1",
        name: contextName,
        configuration: c,
        credentialRead: false,
      };
    }
    if (name === "context.show" || name === "context.doctor") {
      let routing = input;
      let source = "explicit_or_default";
      if (!input.repo) {
        const runner = yield* ProcessRunner;
        const origin = yield* runner.run({
          command: "git",
          args: ["remote", "get-url", "origin"],
          cwd: settings.options.cwd,
          timeoutMs: 5000,
        });
        if (origin.exitCode === 0) {
          const remote = yield* attempt("context_origin", () => parseOrigin(origin.stdout));
          const [name] = yield* attempt("context_origin", () =>
            contextForEndpoint(cfg, remote.endpoint),
          );
          yield* attempt("context_origin", () =>
            invariant(
              !input.context || input.context === name,
              "Explicit Context contradicts the current origin.",
              "conflict",
            ),
          );
          routing = { ...input, context: name, repo: remote.repository };
          source = "origin";
        }
      }
      const target = yield* resolveTarget(routing, Boolean(routing.repo));
      const result = {
        ...publicTarget(target),
        source,
        identity: target.identity,
        credentialRead: false,
        networkChecked: false,
      };
      if (name === "context.doctor" && input.network) {
        const http = yield* HttpTransport,
          response = yield* http.request({
            ...connection(target),
            method: "GET",
            path: "/readyz",
            timeoutMs: 5000,
          });
        const health = yield* attempt("readiness", () => record(expectStatus(response).body));
        if (health.instance_id !== undefined)
          yield* attempt("readiness", () =>
            invariant(
              health.instance_id === target.context.instanceId,
              "Server instance identity contradicts the configured Context.",
              "conflict",
            ),
          );
        return {
          ...result,
          networkChecked: true,
          ready: health.status === "ready",
          health,
          identityAttested: health.instance_id !== undefined,
        };
      }
      return result;
    }
    const contextName = input.name === undefined ? undefined : text(input.name);
    let next: Config;
    if (name === "context.add") {
      const c = yield* attempt("context", () => validateContext(input.configuration));
      yield* attempt("context", () =>
        invariant(
          !Object.hasOwn(cfg.contexts, contextName!),
          "Context already exists; use an exact configuration import to change it.",
          "conflict",
        ),
      );
      next = { ...cfg, contexts: { ...cfg.contexts, [contextName!]: c } };
    } else if (name === "context.use") {
      yield* attempt("context", () =>
        invariant(cfg.contexts[contextName!], "Context not found.", "config_error"),
      );
      next = { ...cfg, defaultContext: contextName! };
    } else if (name === "context.remove") {
      yield* attempt("context", () =>
        invariant(cfg.contexts[contextName!], "Context not found.", "config_error"),
      );
      const contexts = { ...cfg.contexts };
      delete contexts[contextName!];
      next = {
        schema: cfg.schema,
        contexts,
        ...(cfg.defaultContext && cfg.defaultContext !== contextName
          ? { defaultContext: cfg.defaultContext }
          : {}),
        ...(cfg.journalLimit ? { journalLimit: cfg.journalLimit } : {}),
      };
    } else next = yield* attempt("configuration", () => validateConfig(input.configuration));
    next = yield* attempt("configuration", () => validateConfig(next));
    const before = fingerprint(cfg),
      after = fingerprint(next);
    if (!input.apply)
      return {
        planned: true,
        beforeHash: before,
        afterHash: after,
        configuration: next,
        credentialsRead: false,
      };
    return yield* settings.update(
      () => next,
      input.expectedConfig === undefined ? before : String(input.expectedConfig),
    );
  });

export const authenticationCommand = (name: string, input: Input, target: Target) =>
  Effect.gen(function* () {
    const settings = yield* Settings,
      http = yield* HttpTransport;
    if (name === "auth.status") {
      if (target.identity === "workload") {
        const material = yield* obtainGrant(target, "observe");
        return { kind: "workload", grant: material.grant, reused: material.reused };
      }
      return publicCredential(yield* authenticateNative(target));
    }
    if (name === "auth.import") {
      if (!input.apply)
        return {
          planned: true,
          context: target.contextName,
          sourceFile: input.file,
          credentialRead: false,
        };
      const source = resolve(settings.options.cwd, String(input.file)),
        kind = input.kind as "human" | "service";
      const temp = {
        ...target,
        identity: kind,
        context: { ...target.context, auth: { kind, credential: { file: source } } },
      };
      const auth = yield* authenticateNative(temp);
      const cfg = yield* settings.read(),
        before = fingerprint(cfg);
      const ref = yield* settings.importSecret(target.contextName, source);
      let committed = false;
      return yield* Effect.gen(function* () {
        yield* settings.update(
          (c) => ({
            ...c,
            contexts: {
              ...c.contexts,
              [target.contextName]: { ...target.context, auth: { kind, credential: ref } },
            },
          }),
          before,
        );
        committed = true;
        return { imported: true, identity: publicCredential(auth), context: target.contextName };
      }).pipe(
        Effect.ensuring(
          Effect.suspend(() =>
            committed ? Effect.void : settings.eraseSecret(ref).pipe(Effect.ignore),
          ),
        ),
      );
    }
    if (name === "auth.logout") {
      const cfg = yield* settings.read(),
        context = cfg.contexts[target.contextName]!;
      if (!input.apply)
        return { planned: true, context: target.contextName, serverCredentialRevoked: false };
      const next = { ...context };
      delete next.auth;
      yield* settings.update(
        (c) => ({ ...c, contexts: { ...c.contexts, [target.contextName]: next } }),
        fingerprint(cfg),
      );
      const removed = context.auth ? yield* settings.eraseSecret(context.auth.credential) : false;
      return { loggedOut: true, ownedCredentialRemoved: removed, serverCredentialRevoked: false };
    }
    const directory = join(settings.options.home, "device"),
      path = join(directory, `${target.contextName}.json`);
    if (!input.apply)
      return { planned: true, context: target.contextName, flow: name, networkRequested: false };
    if (name === "auth.device-start") {
      yield* attempt("device", () => {
        if (existsSync(path)) {
          const old = record(JSON.parse(privateBytes(path, 16_384).toString("utf8")));
          invariant(
            Number(old.expiresAt) < Date.now(),
            "A device authorization is already pending for this Context.",
            "conflict",
          );
        }
      });
      const clientId = String(input.clientId ?? "agsx");
      const response = yield* http.request({
        ...connection(target),
        path: "/login/device/code",
        method: "POST",
        format: "form",
        body: { client_id: clientId, scope: input.scope ?? "repo" },
      });
      const b = yield* attempt("device", () => {
        const row = record(expectStatus(response, [200, 201]).body);
        text(row.device_code);
        text(row.user_code);
        const verification = new URL(text(row.verification_uri ?? row.verification_url));
        invariant(
          verification.origin === target.context.endpoint,
          "Device verification URL escaped the selected AGS origin.",
          "integrity_error",
        );
        const seconds = Number(row.expires_in);
        invariant(
          Number.isFinite(seconds) && seconds > 0 && seconds <= 3600,
          "Invalid device-code lifetime.",
          "integrity_error",
        );
        return {
          device_code: text(row.device_code),
          user_code: text(row.user_code),
          verification_uri: verification.href,
          expiresAt: Date.now() + seconds * 1000,
          interval: Math.min(30, Math.max(1, Number(row.interval ?? 5))),
        };
      });
      yield* attempt("device", () => {
        privateDirectory(settings.options.home, true);
        privateDirectory(directory, true);
        atomicPrivate(path, {
          schema: "agsx.device.v1",
          endpoint: target.context.endpoint,
          clientId,
          deviceCode: b.device_code,
          expiresAt: b.expiresAt,
          interval: b.interval,
        });
      });
      return {
        userCode: b.user_code,
        verificationUri: b.verification_uri,
        expiresAt: b.expiresAt,
        intervalSeconds: b.interval,
        pending: true,
        nextCommand: "auth.device-finish",
      };
    }
    const pending = yield* attempt("device", () => {
      invariant(existsSync(path), "No device authorization is pending.", "config_error");
      const p = record(JSON.parse(privateBytes(path, 16_384).toString("utf8")));
      invariant(
        p.schema === "agsx.device.v1" &&
          p.endpoint === target.context.endpoint &&
          Number(p.expiresAt) > Date.now(),
        "Device authorization expired or belongs to another endpoint.",
        "conflict",
      );
      return p;
    });
    const stop = Math.min(Number(pending.expiresAt), Date.now() + 60_000);
    while (true) {
      const response = yield* http.request({
        ...connection(target),
        path: "/login/oauth/access_token",
        method: "POST",
        format: "form",
        body: {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: pending.clientId,
          device_code: pending.deviceCode,
        },
      });
      const body = yield* attempt("device", () => record(response.body));
      if (typeof body.access_token === "string") {
        const user = yield* http.request({
          ...connection(target),
          path: "/api/v3/user",
          method: "GET",
          credential: body.access_token,
        });
        yield* attempt("device", () =>
          invariant(
            record(expectStatus(user).body).user_kind === "human",
            "Device authorization did not yield a Human identity.",
            "denied",
          ),
        );
        const temp = join(directory, `${target.contextName}.token`);
        yield* attempt("device", () => {
          invariant(
            !existsSync(temp),
            "Device credential staging file already exists.",
            "conflict",
          );
          writeFileSync(temp, body.access_token as string, { flag: "wx", mode: 0o600 });
        });
        let attached = false;
        let reference: { file: string } | undefined;
        return yield* Effect.gen(function* () {
          reference = yield* settings.importSecret(target.contextName, temp);
          const cfg = yield* settings.read();
          yield* settings.update(
            (c) => ({
              ...c,
              contexts: {
                ...c.contexts,
                [target.contextName]: {
                  ...target.context,
                  auth: { kind: "human", credential: reference! },
                },
              },
            }),
            fingerprint(cfg),
          );
          attached = true;
          yield* attempt("device", () => unlinkSync(path));
          return { authorized: true, context: target.contextName, user: user.body };
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* attempt("device_cleanup", () => {
                if (existsSync(temp)) unlinkSync(temp);
              });
              if (reference && !attached) yield* settings.eraseSecret(reference);
            }).pipe(Effect.ignore),
          ),
        );
      }
      if (!["authorization_pending", "slow_down"].includes(String(body.error)))
        return yield* Effect.fail(
          problem("denied", "Device authorization was denied or expired.", "device"),
        );
      if (!input.wait || Date.now() >= stop)
        return { pending: true, nextCommand: "auth.device-finish" };
      yield* Effect.sleep(
        Math.min(
          Number(pending.interval) * 1000 + (body.error === "slow_down" ? 5000 : 0),
          Math.max(0, stop - Date.now()),
        ),
      );
    }
  });
