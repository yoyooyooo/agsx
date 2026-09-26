import { Effect } from "effect";
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  attempt,
  invariant,
  positive,
  problem,
  record,
  repoPath,
  slug,
  text,
} from "../domain/errors.js";
import type { Input } from "../domain/commands.js";
import { hostname } from "../domain/model.js";
import { Settings, privateBytes, privateDirectory } from "../platform/store.js";
import { ProcessRunner } from "../platform/process.js";
import { HttpTransport, type HttpResponse } from "../platform/http.js";

const OVERRIDES = [
  "GH_HOST",
  "GH_REPO",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];
export function routingOverrides(env: Readonly<Record<string, string | undefined>>): string[] {
  return OVERRIDES.filter((key) => Boolean(env[key]));
}
export function checkedToken(value: string): string {
  const token = value.trim();
  invariant(
    token.length > 0 && token.length <= 16000 && !/[\r\n\u0000]/.test(token),
    "Credential is missing or malformed.",
    "unauthenticated",
  );
  return token;
}
export const runtime = (input: Input) =>
  Effect.gen(function* () {
    const { options } = yield* Settings;
    const gh = yield* attempt("gh_executable", () => {
      const explicit = typeof input.gh === "string" ? resolve(options.cwd, input.gh) : undefined;
      const candidates = explicit
        ? [explicit]
        : ["/usr/bin/gh", "/usr/local/bin/gh", "/opt/homebrew/bin/gh"];
      const selected = candidates.find((path) => {
        try {
          accessSync(path, constants.X_OK);
          return true;
        } catch {
          return false;
        }
      });
      invariant(
        selected,
        "Official gh must be installed; supply its absolute path with --gh when needed.",
        "unsupported",
      );
      return realpathSync(selected);
    });
    const ghConfig = yield* attempt("gh_config", () =>
      resolve(
        String(
          input.ghConfig ??
            options.env.GH_CONFIG_DIR ??
            join(
              options.env.XDG_CONFIG_HOME ?? join(options.env.HOME ?? homedir(), ".config"),
              "gh",
            ),
        ),
      ),
    );
    const caFile =
      typeof input.caFile === "string"
        ? resolve(options.cwd, input.caFile)
        : options.env.SSL_CERT_FILE;
    return { gh, ghConfig, ...(caFile ? { caFile } : {}), options };
  });
export const originTarget = (_input: Input) =>
  Effect.gen(function* () {
    const settings = yield* Settings,
      processes = yield* ProcessRunner;
    const result = yield* processes.run({
      command: "git",
      args: ["remote", "get-url", "origin"],
      cwd: settings.options.cwd,
      env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: 5000,
      maxBytes: 16384,
    });
    return yield* attempt("origin", () => {
      invariant(
        result.exitCode === 0,
        "This auxiliary command requires a repository with a canonical origin.",
        "config_error",
      );
      const raw = result.stdout.trim();
      let host: string, repository: string;
      if (/^(https?|ssh):\/\//.test(raw)) {
        const url = new URL(raw);
        invariant(
          !url.password && (url.protocol === "ssh:" || !url.username) && !url.search && !url.hash,
          "Origin must not contain credentials or selectors.",
        );
        host = hostname(url.hostname);
        repository = slug(url.pathname.replace(/^\//, "").replace(/\.git$/, ""));
      } else {
        const match = /^(?:git@)?([A-Za-z0-9.-]+):([^\s]+)$/.exec(raw);
        invariant(
          match,
          "Use a canonical Git host URL for auxiliary association queries; SSH aliases remain owned by gh.",
          "unsupported",
        );
        host = hostname(match[1]);
        repository = slug(match[2]!.replace(/\.git$/, ""));
      }
      return { host, repository, endpoint: "https://" + host, gitOrigin: raw };
    });
  });
export const requireApiHostSupport = (gh: string, cwd: string) =>
  Effect.gen(function* () {
    const processes = yield* ProcessRunner;
    const version = yield* processes.run({
      command: gh,
      args: ["--version"],
      cwd,
      timeoutMs: 5000,
      maxBytes: 16384,
    });
    yield* attempt("gh_api_host_support", () => {
      const found = /^gh version (\d+)\.(\d+)\./.exec(version.stdout);
      invariant(
        version.exitCode === 0 &&
          found &&
          (Number(found[1]) > 2 || (Number(found[1]) === 2 && Number(found[2]) >= 100)),
        "Explicit api_host routing requires official gh 2.100 or later.",
        "unsupported",
      );
    });
  });
export const target = (input: Input) =>
  Effect.gen(function* () {
    const selected =
      typeof input.host === "string"
        ? yield* attempt("host", () => {
            const host = hostname(input.host);
            return { host, repository: undefined as string | undefined };
          })
        : yield* originTarget(input);
    const rt = yield* runtime(input);
    const apiHost = yield* attempt("configured_api_host", () => {
      const hosts = ghHosts(rt.ghConfig).hosts;
      const entry = Object.hasOwn(hosts, selected.host) ? record(hosts[selected.host]) : {};
      return hostname(entry.api_host ?? selected.host);
    });
    if (apiHost !== selected.host) yield* requireApiHostSupport(rt.gh, rt.options.cwd);
    return { ...selected, apiHost, endpoint: "https://" + apiHost };
  });

export const credential = (input: Input, host: string) =>
  Effect.gen(function* () {
    const rt = yield* runtime(input),
      processes = yield* ProcessRunner;
    // Ask official gh for its configured credential, including its native keyring
    // integration. Never reinterpret an unrelated ambient token as this host.
    const result = yield* processes.run({
      command: rt.gh,
      args: ["auth", "token", "--hostname", host],
      cwd: rt.options.cwd,
      env: { GH_CONFIG_DIR: rt.ghConfig, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
      timeoutMs: 10000,
      maxBytes: 32768,
    });
    yield* attempt("credential", () =>
      invariant(
        result.exitCode === 0,
        "The selected gh host is not authenticated. Complete its native login or explicit setup first.",
        "unauthenticated",
      ),
    );
    const token = yield* attempt("credential", () => checkedToken(result.stdout));
    return { token, ...rt };
  });
export function responseBody(response: HttpResponse, accepted: readonly number[] = [200]): unknown {
  if (accepted.includes(response.status)) return response.body;
  const status = response.status;
  throw problem(
    status === 401
      ? "unauthenticated"
      : status === 403
        ? "denied"
        : status === 404 || status === 501
          ? "unsupported"
          : status === 409
            ? "conflict"
            : status === 422 || status === 400
              ? "invalid_input"
              : "unavailable",
    `Selected AGS returned HTTP ${status}. No alternate identity or route was attempted.`,
    "http_status",
  );
}
export const currentUser = (endpoint: string, token: string, caFile?: string) =>
  Effect.gen(function* () {
    const http = yield* HttpTransport;
    const response = yield* http.request({
      endpoint,
      path: "/api/v3/user",
      method: "GET",
      credential: token,
      ...(caFile ? { caFile } : {}),
    });
    return yield* attempt("native_identity", () => {
      const user = record(responseBody(response));
      const kind = text(user.user_kind);
      invariant(
        ["human", "agent", "service", "automation", "durable_agent", "temporary_agent"].includes(
          kind,
        ),
        "Endpoint did not return a native AGS identity.",
        "unsupported",
      );
      return { id: positive(user.id), login: text(user.login), kind };
    });
  });
export const inspectAssociation = (input: Input, ci: boolean) =>
  Effect.gen(function* () {
    const selected = yield* target(input),
      rt = yield* credential(input, selected.host),
      http = yield* HttpTransport;
    const path = ci
      ? `/api/ext/v1/repos/${repoPath(text(selected.repository))}/ci`
      : `/api/ext/v1/repos/${repoPath(text(selected.repository))}/pulls/${positive(input.number)}/context`;
    const response = yield* http.request({
      endpoint: selected.endpoint,
      path,
      method: "GET",
      credential: rt.token,
      ...(rt.caFile ? { caFile: rt.caFile } : {}),
    });
    return yield* attempt("association_read", () => responseBody(response));
  });
export function ghHosts(directory: string): { hosts: Record<string, unknown>; bytes: string } {
  if (!privateDirectory(directory, false, false)) return { hosts: Object.create(null), bytes: "" };
  const file = join(directory, "hosts.yml");
  if (!existsSync(file)) return { hosts: Object.create(null), bytes: "" };
  const bytes = privateBytes(file).toString("utf8");
  return { hosts: record(parseYaml(bytes, { maxAliasCount: 20, uniqueKeys: true }) ?? {}), bytes };
}
