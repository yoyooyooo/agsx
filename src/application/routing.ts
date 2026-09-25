import { Effect } from "effect";
import { attempt, invariant, problem, slug } from "../domain/errors.js";
import type { Config, ContextConfig, IdentityKind, Target } from "../domain/model.js";
import { Settings } from "../platform/store.js";
import { ProcessRunner } from "../platform/process.js";

export interface RouteInput {
  readonly context?: string;
  readonly repo?: string;
  readonly identity?: IdentityKind;
}
export interface Origin {
  readonly endpoint: string;
  readonly repository: string;
  readonly url: string;
}
export function parseOrigin(value: string): Origin {
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    throw problem("config_error", "Git remote must be a canonical HTTP(S) AGS URL.", "origin");
  }
  invariant(
    ["http:", "https:"].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash,
    "Git remote must be credential-free with no query or fragment.",
    "config_error",
    "origin",
  );
  const repository = slug(decodeURIComponent(u.pathname.replace(/^\//, "").replace(/\.git$/, "")));
  return { endpoint: u.origin, repository, url: `${u.origin}/${repository}.git` };
}
export function contextForEndpoint(cfg: Config, endpoint: string): [string, ContextConfig] {
  const found = Object.entries(cfg.contexts).filter(([, c]) =>
    [c.endpoint, ...(c.aliases ?? [])].includes(endpoint),
  );
  invariant(
    found.length === 1,
    "The Git remote must match exactly one configured AGS Context.",
    "config_error",
    "routing",
  );
  return found[0]!;
}
export const resolveTarget = (input: RouteInput, requireRepository = true) =>
  Effect.gen(function* () {
    const settings = yield* Settings;
    const runner = yield* ProcessRunner;
    const cfg = yield* settings.read();
    let name = input.context;
    let repository = input.repo;
    let c: ContextConfig | undefined;
    if (name) {
      c = cfg.contexts[name];
      yield* attempt("routing", () =>
        invariant(c, "The named Context is not configured.", "config_error"),
      );
    }
    if (!repository && requireRepository) {
      const found = yield* runner.run({
        command: "git",
        args: ["remote", "get-url", "origin"],
        cwd: settings.options.cwd,
        timeoutMs: 5000,
      });
      yield* attempt("origin", () =>
        invariant(
          found.exitCode === 0,
          "No AGS origin was found; provide --repo and a Context.",
          "config_error",
        ),
      );
      const origin = yield* attempt("origin", () => parseOrigin(found.stdout));
      const pair = yield* attempt("routing", () => contextForEndpoint(cfg, origin.endpoint));
      yield* attempt("routing", () =>
        invariant(
          !name || name === pair[0],
          "Explicit Context contradicts this repository's origin.",
          "conflict",
        ),
      );
      [name, c] = pair;
      repository = origin.repository;
    }
    if (!c) {
      name = cfg.defaultContext;
      c = name ? cfg.contexts[name] : undefined;
      yield* attempt("routing", () =>
        invariant(
          c && name,
          "Select a Context explicitly or configure defaultContext.",
          "config_error",
        ),
      );
    }
    if (repository) repository = yield* attempt("routing", () => slug(repository));
    const hasWorkload = Boolean(
      settings.options.env.MULTICA_TOKEN || settings.options.env.MULTICA_TASK_TOKEN,
    );
    const choice = input.identity ?? (hasWorkload ? "workload" : (c!.auth?.kind ?? "human"));
    yield* attempt("identity", () => {
      invariant(
        !(hasWorkload && choice !== "workload"),
        "A workload credential cannot be mixed with Human/service mode.",
        "denied",
      );
      if (choice === "workload") {
        invariant(
          c!.workload,
          "This Context has no explicit workload trust adapter.",
          "config_error",
        );
        const nativeRef = c!.auth?.credential;
        invariant(
          !(nativeRef && "env" in nativeRef && settings.options.env[nativeRef.env]),
          "Native and workload credentials may not be mixed.",
          "denied",
        );
        invariant(
          !settings.options.env.AGS_CLI_PROFILE && !settings.options.env.AGS_PROFILE,
          "Legacy Human profile selection is forbidden for workloads.",
          "denied",
        );
      } else if (c!.auth)
        invariant(
          c!.auth.kind === choice,
          "The Context declares a different credential kind.",
          "config_error",
        );
    });
    return {
      contextName: name!,
      context: c!,
      ...(repository ? { repository } : {}),
      identity: choice,
      home: settings.options.home,
    } satisfies Target;
  });
export function publicTarget(target: Target) {
  return {
    context: target.contextName,
    endpoint: target.context.endpoint,
    ...(target.repository ? { repository: target.repository } : {}),
  };
}
