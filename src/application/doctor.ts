import { Effect } from "effect";
import type { Input } from "../domain/commands.js";
import { attempt, record } from "../domain/errors.js";
import { ProcessRunner } from "../platform/process.js";
import { ghHosts, originTarget, routingOverrides, runtime } from "./connection.js";

export const doctor = (input: Input) =>
  Effect.gen(function* () {
    const rt = yield* runtime(input),
      processes = yield* ProcessRunner;
    const selected = yield* originTarget(input).pipe(
      Effect.catch((error) => Effect.succeed({ error: error.code })),
    );
    const version = yield* processes.run({
      command: rt.gh,
      args: ["--version"],
      cwd: rt.options.cwd,
      timeoutMs: 5000,
      maxBytes: 16384,
    });
    const config = yield* attempt("gh_config_observe", () => {
      const current = ghHosts(rt.ghConfig);
      return Object.fromEntries(
        Object.entries(current.hosts).map(([host, value]) => {
          const entry = record(value);
          return [
            host,
            {
              user: typeof entry.user === "string" ? entry.user : null,
              credentialConfiguredInFile:
                typeof entry.oauth_token === "string" || Boolean(entry.users),
              apiHost: typeof entry.api_host === "string" ? entry.api_host : null,
            },
          ];
        }),
      );
    });
    const defaults = yield* processes.run({
      command: "git",
      args: ["config", "--get-regexp", "^remote\\..*\\.gh-resolved$"],
      cwd: rt.options.cwd,
      env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      timeoutMs: 5000,
      maxBytes: 16384,
    });
    const overrides = routingOverrides(rt.options.env);
    let network: unknown = { checked: false };
    if (input.network && overrides.length === 0) {
      const result = yield* processes.run({
        command: rt.gh,
        args: ["repo", "view", "--json", "nameWithOwner,url"],
        cwd: rt.options.cwd,
        env: {
          GH_CONFIG_DIR: rt.ghConfig,
          GH_PROMPT_DISABLED: "1",
          GH_NO_UPDATE_NOTIFIER: "1",
          ...(rt.caFile ? { SSL_CERT_FILE: rt.caFile } : {}),
        },
        timeoutMs: 15000,
        maxBytes: 65536,
      });
      network =
        result.exitCode === 0
          ? yield* attempt("gh_repository", () => ({
              checked: true,
              officialGhExit: 0,
              repository: record(JSON.parse(result.stdout)),
            }))
          : {
              checked: true,
              officialGhExit: result.exitCode,
              error:
                "Official gh did not resolve/read the repository; run its own auth/status diagnostics. Raw subprocess errors are not copied.",
            };
    }
    return {
      officialGh: {
        path: rt.gh,
        version: version.stdout.split("\n")[0],
        byteProvenanceVerified: false,
      },
      origin: selected,
      ghConfig: rt.ghConfig,
      configuredHosts: config,
      repositoryDefaults: defaults.exitCode === 0 ? defaults.stdout.trim().split("\n") : [],
      routingOrCredentialOverrides: overrides,
      network,
      recommendation: overrides.length
        ? "Do not globally pin GH_HOST/GH_REPO or broad token variables when expecting origin-based switching."
        : "Use ordinary gh commands. In intentional multi-remote layouts, gh repo set-default origin is a one-time repository choice.",
      shimInstalled: false,
      noSourceCheckoutRequired: true,
    };
  });
