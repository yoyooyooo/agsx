import { Effect } from "effect";
import { join, resolve } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { attempt, invariant, record } from "../domain/errors.js";
import { hostname } from "../domain/model.js";
import type { Input } from "../domain/commands.js";
import {
  atomicPrivate,
  fingerprint,
  privateBytes,
  privateDirectory,
  withLock,
} from "../platform/store.js";
import { checkedToken, currentUser, ghHosts, runtime } from "./connection.js";

export const setup = (input: Input, apply: boolean) =>
  Effect.gen(function* () {
    const rt = yield* runtime(input);
    const target = yield* attempt("setup_input", () => {
      const host = hostname(input.host);
      invariant(
        host !== "github.com" && !host.endsWith(".ghe.com"),
        "GitHub account setup remains owned by gh auth login; this setup is for AGS hosts.",
      );
      return { host, tokenFile: resolve(rt.options.cwd, String(input.tokenFile)) };
    });
    const observed = yield* attempt("setup_observe", () => {
      const current = ghHosts(rt.ghConfig),
        entry = Object.hasOwn(current.hosts, target.host) ? record(current.hosts[target.host]) : {};
      invariant(
        !entry.api_host || entry.api_host === target.host,
        "Existing gh api_host differs from this origin; reconcile it explicitly before importing a credential.",
        "config_error",
      );
      const token = checkedToken(privateBytes(target.tokenFile, 16384).toString("utf8"));
      const hash = fingerprint({
        host: target.host,
        directory: rt.ghConfig,
        previous: current.bytes,
        credential: fingerprint(token),
      });
      return {
        ...current,
        token,
        hash,
        previousUser: typeof entry.user === "string" ? entry.user : null,
      };
    });
    const plan = {
      host: target.host,
      ghConfig: rt.ghConfig,
      credentialFile: target.tokenFile,
      previousUser: observed.previousUser,
      expectedPlan: observed.hash,
      modifies: ["this host's gh authentication entry"],
      modifiesGitRemote: false,
      modifiesPath: false,
      installsShim: false,
      changesRoutingVariables: false,
    };
    if (!apply || !input.apply) return { planned: true, ...plan };
    yield* attempt("setup_plan", () =>
      invariant(
        input.expectedPlan === observed.hash,
        "Setup inputs changed since the plan was observed.",
        "conflict",
      ),
    );
    const user = yield* currentUser("https://" + target.host, observed.token, rt.caFile);
    yield* attempt("setup_commit", () => {
      privateDirectory(rt.ghConfig, true, false);
      withLock(join(rt.ghConfig, ".agsx-setup.lock"), () => {
        const now = ghHosts(rt.ghConfig),
          tokenNow = checkedToken(privateBytes(target.tokenFile, 16384).toString("utf8"));
        invariant(
          now.bytes === observed.bytes && tokenNow === observed.token,
          "Official gh configuration or input credential changed; no write performed.",
          "conflict",
        );
        const existing = Object.hasOwn(now.hosts, target.host)
          ? record(now.hosts[target.host])
          : {};
        const users = existing.users === undefined ? {} : record(existing.users);
        const prior = Object.hasOwn(users, user.login) ? record(users[user.login]) : {};
        const entry = {
          ...existing,
          user: user.login,
          oauth_token: observed.token,
          git_protocol: existing.git_protocol ?? "https",
          users: { ...users, [user.login]: { ...prior, oauth_token: observed.token } },
        };
        atomicPrivate(
          join(rt.ghConfig, "hosts.yml"),
          yamlStringify({ ...now.hosts, [target.host]: entry }),
          false,
        );
      });
    });
    return {
      ...plan,
      configured: true,
      principal: user,
      concurrency:
        "companion lock plus immediate stale check; do not run other gh configuration writers concurrently",
      next: "Use official git/gh in the repository. Multi-remote repositories may explicitly select gh repo set-default origin.",
    };
  });
