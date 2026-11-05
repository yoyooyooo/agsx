import { Effect } from "effect";
import { existsSync, mkdirSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { stringify as yamlStringify, parse as parseYaml } from "yaml";
import type { Input } from "../domain/commands.js";
import { association, hostname } from "../domain/model.js";
import { attempt, invariant, record, text } from "../domain/errors.js";
import {
  Settings,
  atomicPrivate,
  fingerprint,
  privateBytes,
  privateDirectory,
} from "../platform/store.js";
import { packageRoot } from "../platform/paths.js";
import { HttpTransport } from "../platform/http.js";
import {
  checkedToken,
  credential,
  currentUser,
  originTarget,
  responseBody,
  target,
} from "./connection.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const runToken = (value: unknown) => {
  const token = text(value);
  invariant(
    /^ags_run_[A-Za-z0-9_-]{43}$/.test(token),
    "Invalid AGS run credential.",
    "integrity_error",
  );
  return token;
};
export function loadSession(directory: string): Record<string, unknown> {
  privateDirectory(directory, false);
  const value = record(
    JSON.parse(privateBytes(join(directory, "session.json"), 65536).toString("utf8")),
  );
  invariant(
    value.schema === "agsx.session.v1" &&
      UUID.test(String(value.id)) &&
      value.directory === resolve(directory) &&
      ["starting", "unknown", "active", "ended"].includes(String(value.phase)),
    "Unknown or foreign session state.",
    "integrity_error",
  );
  hostname(value.host);
  hostname(value.apiHost ?? value.host);
  return value;
}
export function sessionCredential(directory: string, session: Record<string, unknown>): string {
  privateDirectory(join(directory, "gh"), false);
  const hosts = record(
    parseYaml(privateBytes(join(directory, "gh/hosts.yml")).toString("utf8"), {
      maxAliasCount: 0,
      uniqueKeys: true,
    }),
  );
  const token = runToken(record(hosts[String(session.host)]).oauth_token);
  invariant(
    fingerprint(token) === session.credentialDigest,
    "Session credential differs from its owned receipt.",
    "integrity_error",
  );
  return token;
}
function publicSession(session: Record<string, unknown>) {
  return {
    schema: session.schema,
    id: session.id,
    phase: session.phase,
    directory: session.directory,
    host: session.host,
    apiHost: session.apiHost ?? session.host,
    actor: session.actor,
    context: session.context,
    associationStatus: session.associationStatus,
    contextTrust: session.contextTrust,
    expiresAt: session.expiresAt,
    environmentFile:
      session.phase === "active" ? join(String(session.directory), "environment.json") : null,
    authorization: "native actor's existing permissions; context adds no rights",
    lastError: session.lastError,
  };
}
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
export const startSession = (input: Input) =>
  Effect.gen(function* () {
    const settings = yield* Settings,
      http = yield* HttpTransport;
    const selected = yield* target(input);
    const prepared = yield* attempt("session_input", () => {
      const directory = resolve(settings.options.cwd, String(input.directory));
      const context = association(input.context);
      const ttl = input.ttlSeconds === undefined ? 3600 : Number(input.ttlSeconds);
      invariant(
        Number.isInteger(ttl) && ttl >= 60 && ttl <= 28800,
        "Run lifetime must be 60–28800 seconds.",
      );
      if (existsSync(directory)) {
        privateDirectory(directory, false);
        invariant(
          readdirSync(directory).length === 0,
          "Session directory is already owned or nonempty; inspect/end it instead of repeating creation.",
          "conflict",
        );
      }
      return { directory, context, ttl };
    });
    if (!input.apply)
      return {
        planned: true,
        host: selected.host,
        apiHost: selected.apiHost,
        directory: prepared.directory,
        context: prepared.context,
        ttlSeconds: prepared.ttl,
        writes: "one native run identity and isolated gh configuration",
        shim: false,
      };
    const parent = yield* credential(input, selected.host),
      actor = yield* currentUser(selected.endpoint, parent.token, parent.caFile);
    const id = randomUUID();
    const initial = {
      schema: "agsx.session.v1",
      id,
      directory: prepared.directory,
      host: selected.host,
      apiHost: selected.apiHost,
      phase: "starting",
      actor,
      context: prepared.context,
      parentGhConfig: parent.ghConfig,
      gh: parent.gh,
      ...(parent.caFile ? { caFile: parent.caFile } : {}),
      createdAt: new Date().toISOString(),
    };
    yield* attempt("session_reserve", () => {
      privateDirectory(prepared.directory, true);
      invariant(
        readdirSync(prepared.directory).length === 0,
        "Directory changed before session reservation.",
        "conflict",
      );
      // mkdir is an atomic reservation shared by concurrent setup processes.
      mkdirSync(join(prepared.directory, ".reserved"), { mode: 0o700 });
      atomicPrivate(join(prepared.directory, "session.json"), initial);
    });
    let source: unknown;
    const warnings: string[] = [];
    if (input.source !== undefined) {
      const spec = record(input.source);
      const sourceCredential = yield* attempt("optional_source_credential", () =>
        checkedToken(
          privateBytes(resolve(settings.options.cwd, String(spec.tokenFile)), 16384).toString(
            "utf8",
          ),
        ),
      ).pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (sourceCredential)
        source = {
          instance: spec.instance,
          token: sourceCredential,
          ...(spec.endpointHint ? { endpoint_hint: spec.endpointHint } : {}),
          ...(spec.locator ? { locator: spec.locator } : {}),
        };
      else
        warnings.push(
          "optional_source_credential_unavailable; native identity remains authoritative",
        );
    }
    const operation = Effect.gen(function* () {
      const response = yield* http.request({
        endpoint: selected.endpoint,
        path: "/api/ext/v1/client-runs",
        method: "POST",
        credential: parent.token,
        body: {
          id,
          context: prepared.context,
          ttl_seconds: prepared.ttl,
          ...(source ? { source } : {}),
        },
        ...(parent.caFile ? { caFile: parent.caFile } : {}),
        timeoutMs: 15000,
      });
      const receipt = yield* attempt("session_receipt", () => {
        const body = record(responseBody(response, [201]));
        const token = runToken(body.token);
        invariant(
          body.schema === "ags.client-run.v1" &&
            body.id === id &&
            body.actor_id === actor.id &&
            body.actor_login === actor.login &&
            ["linked", "provisional", "unlinked", "conflict"].includes(
              String(body.association_status),
            ) &&
            Number.isFinite(Date.parse(String(body.expires_at))) &&
            Date.parse(String(body.expires_at)) > Date.now(),
          "Run receipt does not match the verified native actor/request.",
          "integrity_error",
        );
        return {
          token,
          expiresAt: body.expires_at,
          associationStatus: body.association_status,
          contextTrust: body.context_trust,
          context: association(body.context),
        };
      });
      const active = {
        ...initial,
        phase: "active",
        expiresAt: receipt.expiresAt,
        context: receipt.context,
        associationStatus: receipt.associationStatus,
        contextTrust: receipt.contextTrust,
        credentialDigest: fingerprint(receipt.token),
      };
      // Session helpers need only the actual repository/origin, not guessed CI or
      // provider identities. If setup occurs outside a repository, HTTPS host is
      // the scope; normal native permissions still decide each repository access.
      const origin = yield* originTarget(input).pipe(Effect.catch(() => Effect.succeed(undefined)));
      const allowed =
        origin && origin.host === selected.host
          ? [
              {
                origin: new URL(
                  origin.gitOrigin.startsWith("http") ? origin.gitOrigin : selected.endpoint,
                ).origin,
                repository: origin.repository,
              },
              { origin: selected.endpoint, repository: origin.repository },
            ]
          : [{ origin: selected.endpoint, repository: null }];
      const unique = [
        ...new Map(allowed.map((item) => [item.origin + "/" + item.repository, item])).values(),
      ];
      const helper = `!${quote(process.execPath)} ${quote(join(packageRoot(), "dist/credential-helper.js"))} ${quote(prepared.directory)}`;
      const set: Record<string, string> = {
        GH_CONFIG_DIR: join(prepared.directory, "gh"),
        GIT_TERMINAL_PROMPT: "0",
        ...(parent.caFile ? { SSL_CERT_FILE: parent.caFile, GIT_SSL_CAINFO: parent.caFile } : {}),
      };
      let count = 0;
      // Clear inherited helpers for every target, including unmatched URLs.
      // A refused credential must not fall through to an ambient prompt either.
      for (const key of ["credential.helper", "core.askPass"]) {
        set[`GIT_CONFIG_KEY_${count}`] = key;
        set[`GIT_CONFIG_VALUE_${count++}`] = "";
      }
      for (const scope of unique) {
        const scopeURL = scope.origin + (scope.repository ? "/" + scope.repository + ".git" : "");
        for (const value of ["", helper]) {
          set[`GIT_CONFIG_KEY_${count}`] = `credential.${scopeURL}.helper`;
          set[`GIT_CONFIG_VALUE_${count++}`] = value;
        }
      }
      set[`GIT_CONFIG_KEY_${count}`] = "credential.useHttpPath";
      set[`GIT_CONFIG_VALUE_${count++}`] = "true";
      set.GIT_CONFIG_COUNT = String(count);
      const unset = [
        ...new Set([
          "GH_HOST",
          "GH_REPO",
          "GH_TOKEN",
          "GITHUB_TOKEN",
          "GH_ENTERPRISE_TOKEN",
          "GITHUB_ENTERPRISE_TOKEN",
          "GIT_ASKPASS",
          "SSH_ASKPASS",
          ...Object.keys(settings.options.env).filter((key) =>
            /^(GIT_CONFIG_|GIT_TRACE|GIT_CURL_VERBOSE)/.test(key),
          ),
        ]),
      ].filter((key) => !Object.hasOwn(set, key));
      const environment = {
        schema: "agsx.task-environment.v1",
        set,
        unset,
        lifecycle: "apply once when launching a task; never before each gh command",
        changesPath: false,
        ghExecutable: parent.gh,
        ghIsWrapped: false,
      };
      yield* attempt("session_commit", () => {
        // This directory is a new owned credential boundary, not a merge target.
        mkdirSync(join(prepared.directory, "gh"), { mode: 0o700 });
        atomicPrivate(
          join(prepared.directory, "gh/hosts.yml"),
          yamlStringify({
            [selected.host]: {
              user: actor.login,
              api_host: selected.apiHost === selected.host ? undefined : selected.apiHost,
              oauth_token: receipt.token,
              git_protocol: "https",
            },
          }),
        );
        atomicPrivate(
          join(prepared.directory, "gh/config.yml"),
          "prompt: disabled\ntelemetry: disabled\n",
        );
        atomicPrivate(join(prepared.directory, "environment.json"), environment);
        atomicPrivate(join(prepared.directory, "session.json"), { ...active, gitScopes: unique });
        rmdirSync(join(prepared.directory, ".reserved"));
      });
      return {
        ...publicSession(active),
        warnings,
        environmentFile: join(prepared.directory, "environment.json"),
        commands:
          "Run the installed official gh and system Git normally. No PATH or binary replacement.",
      };
    });
    return yield* operation.pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* attempt("session_failure_record", () =>
            atomicPrivate(join(prepared.directory, "session.json"), {
              ...initial,
              phase: "unknown",
              lastError: error.code,
            }),
          ).pipe(Effect.catch(() => Effect.void));
          return yield* Effect.fail(error);
        }),
      ),
    );
  });
export const showSession = (input: Input) =>
  Effect.gen(function* () {
    const settings = yield* Settings;
    return yield* attempt("session_show", () =>
      publicSession(loadSession(resolve(settings.options.cwd, String(input.directory)))),
    );
  });
export const endSession = (input: Input) =>
  Effect.gen(function* () {
    const settings = yield* Settings,
      http = yield* HttpTransport;
    const directory = resolve(settings.options.cwd, String(input.directory));
    const saved = yield* attempt("session_read", () => loadSession(directory));
    if (saved.phase === "ended") return { ...publicSession(saved), alreadyEnded: true };
    if (!input.apply)
      return {
        planned: true,
        session: publicSession(saved),
        action: "revoke only this run; remove only its exact owned credential files",
      };
    let token: string;
    if (saved.phase === "active")
      token = yield* attempt("session_credential", () => sessionCredential(directory, saved));
    else {
      // The caller-generated UUID makes an unknown issue result revocable without
      // replaying creation. The original actor's configured login is used only here.
      const parent = yield* credential(
        { gh: saved.gh, ghConfig: saved.parentGhConfig, caFile: saved.caFile },
        String(saved.host),
      );
      const actor = yield* currentUser(
        "https://" + (saved.apiHost ?? saved.host),
        parent.token,
        parent.caFile,
      );
      yield* attempt("session_cleanup_actor", () =>
        invariant(
          actor.id === record(saved.actor).id,
          "The parent gh login changed; do not revoke through another identity.",
          "denied",
        ),
      );
      token = parent.token;
    }
    const response = yield* http.request({
      endpoint: "https://" + (saved.apiHost ?? saved.host),
      path: "/api/ext/v1/client-runs/" + saved.id,
      method: "DELETE",
      credential: token,
      ...(input.caFile || saved.caFile ? { caFile: String(input.caFile ?? saved.caFile) } : {}),
    });
    yield* attempt("session_revoke", () => {
      const valid =
        response.status === 204 ||
        response.status === 404 ||
        (response.status === 401 && saved.phase === "active");
      invariant(
        valid,
        "Run revocation was not confirmed; local credentials were retained for reconciliation.",
        response.status === 403 ? "denied" : "outcome_unknown",
      );
    });
    yield* attempt("session_forget", () => {
      for (const file of ["gh/hosts.yml", "gh/config.yml", "environment.json"]) {
        const path = join(directory, file);
        if (existsSync(path)) {
          privateBytes(path);
          rmSync(path);
        }
      }
      if (
        existsSync(join(directory, ".reserved")) &&
        readdirSync(join(directory, ".reserved")).length === 0
      )
        rmdirSync(join(directory, ".reserved"));
      atomicPrivate(join(directory, "session.json"), {
        ...saved,
        phase: "ended",
        endedAt: new Date().toISOString(),
        revocationStatus: response.status,
      });
    });
    return {
      ...publicSession({ ...saved, phase: "ended" }),
      serverRevoked: response.status === 204,
      serverStatus: response.status,
      nativeParentRevoked: false,
    };
  });
