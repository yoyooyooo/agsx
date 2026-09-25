import { Effect } from "effect";
import { mkdtempSync, unlinkSync, rmdirSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attempt, invariant, problem } from "../domain/errors.js";
import type { Input } from "../domain/commands.js";
import {
  Journal,
  Settings,
  fingerprint,
  privateDirectory,
  privateBytes,
  atomicPrivate,
} from "../platform/store.js";
import { ProcessRunner } from "../platform/process.js";
import { packageRoot } from "../platform/paths.js";
import { authenticate, connection } from "./identity.js";
import { contextForEndpoint, parseOrigin, publicTarget, resolveTarget } from "./routing.js";

const NETWORK = new Set(["clone", "fetch", "pull", "push", "ls-remote"]);
const READ = new Set([
  "status",
  "log",
  "diff",
  "show",
  "rev-parse",
  "merge-base",
  "ls-files",
  "ls-tree",
  "cat-file",
  "for-each-ref",
  "ls-remote",
]);
const LOCAL = new Set([
  ...READ,
  "init",
  "add",
  "commit",
  "branch",
  "switch",
  "checkout",
  "restore",
  "reset",
  "merge",
  "rebase",
  "tag",
  "cherry-pick",
  "revert",
  "fetch",
  "pull",
  "push",
  "clone",
]);
function validateArgs(value: unknown): string[] {
  invariant(
    Array.isArray(value) &&
      value.length > 0 &&
      value.length <= 128 &&
      value.every((x) => typeof x === "string" && x.length <= 16384 && !/[\r\n\u0000]/.test(x)),
    "Git args must be a bounded string array.",
  );
  const args = value as string[];
  invariant(
    LOCAL.has(args[0]!),
    "Unsupported Git subcommand; no shell aliases or external commands are executed.",
  );
  invariant(
    args.every(
      (x) =>
        (args[0] === "switch" && ["-c", "-C"].includes(x)) ||
        !/^(-c|--config|--exec-path|--git-dir|--work-tree|--upload-pack|--receive-pack|--exec)/.test(
          x,
        ),
    ),
    "Git configuration/remote executable overrides are forbidden.",
  );
  return args;
}
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
export const gitCommand = (input: Input) =>
  Effect.gen(function* () {
    const settings = yield* Settings,
      runner = yield* ProcessRunner;
    const args = yield* attempt("git_input", () => validateArgs(input.args));
    const command = args[0]!,
      network = NETWORK.has(command),
      writes = !READ.has(command);
    if (!network) {
      if (writes && !input.apply)
        return { planned: true, command: "git", args, cwd: settings.options.cwd };
      const result = yield* runner.run({
        command: "git",
        args,
        cwd: settings.options.cwd,
        timeoutMs: input.timeoutMs ?? 60_000,
      });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        local: true,
        pending: false,
      };
    }
    let remote: string;
    if (command === "clone" || command === "ls-remote") {
      remote = yield* attempt("git_remote", () => {
        invariant(args[1], "clone/ls-remote requires its canonical URL as the first operand.");
        if (command === "clone")
          invariant(
            args[2] && !args[2]!.startsWith("-"),
            "clone requires an explicit destination before options.",
          );
        return args[1]!;
      });
    } else {
      yield* attempt("git_remote", () =>
        invariant(
          args[1] === "origin",
          "Use the configured origin explicitly; arbitrary remote overrides are forbidden.",
        ),
      );
      const result = yield* runner.run({
        command: "git",
        args: ["remote", "get-url", ...(command === "push" ? ["--push"] : []), "--all", "origin"],
        cwd: settings.options.cwd,
        timeoutMs: 5000,
      });
      remote = yield* attempt("git_remote", () => {
        const lines = result.stdout.trim().split("\n");
        invariant(
          result.exitCode === 0 && lines.length === 1,
          "Exactly one origin URL is required.",
          "config_error",
        );
        return lines[0]!;
      });
    }
    const expanded = yield* runner.run({
      command: "git",
      args: ["ls-remote", "--get-url", remote],
      cwd: settings.options.cwd,
      timeoutMs: 5000,
    });
    yield* attempt("git_origin", () =>
      invariant(
        expanded.exitCode === 0 && expanded.stdout.trim() === remote,
        "Git URL rewrite changes the selected origin; correct the explicit route instead.",
        "conflict",
      ),
    );
    const origin = yield* attempt("git_origin", () => parseOrigin(remote));
    const config = yield* settings.read();
    const [context] = yield* attempt("git_origin", () =>
      contextForEndpoint(config, origin.endpoint),
    );
    yield* attempt("git_origin", () => {
      invariant(
        !input.context || input.context === context,
        "Git remote contradicts explicit Context.",
        "conflict",
      );
      invariant(
        !input.repo || input.repo === origin.repository,
        "Git remote contradicts explicit repository.",
        "conflict",
      );
    });
    const target = yield* resolveTarget({ ...input, context, repo: origin.repository });
    if (writes && !input.apply)
      return { planned: true, args, target: publicTarget(target), credentialRead: false };
    const auth = yield* authenticate(target, command === "push" ? "git.push" : "git.read");
    const helper = join(packageRoot(), "dist", "credential-helper.js");
    const temporary = yield* Effect.acquireRelease(
      attempt("git_credential", () => {
        const dir = mkdtempSync(join(tmpdir(), "agsx-git-"));
        chmodSync(dir, 0o700);
        const path = join(dir, "credential.json");
        writeFileSync(
          path,
          JSON.stringify({
            schema: "agsx.git-credential.v1",
            origin: origin.endpoint,
            repository: origin.repository,
            token: auth.bearer,
          }),
          { mode: 0o600, flag: "wx" },
        );
        return { dir, path };
      }),
      (value) =>
        Effect.sync(() => {
          if (existsSync(value.path)) unlinkSync(value.path);
          rmdirSync(value.dir);
        }),
    );
    const existing = yield* runner.run({
      command: "git",
      args: [
        "config",
        "--null",
        "--get-regexp",
        "^(credential(\\..*)?\\.(helper|username|usehttppath)|http(\\..*)?\\.(extraheader|cookiefile|savecookies|sslverify|proxy|sslcainfo|sslcapath))$",
      ],
      cwd: settings.options.cwd,
      timeoutMs: 5000,
    });
    const resets = yield* attempt("git_credentials", () => {
      invariant(
        [0, 1].includes(existing.exitCode),
        "Git credential configuration could not be safely inspected.",
        "config_error",
      );
      const keys = [
        ...new Set(
          existing.stdout
            .split("\0")
            .filter(Boolean)
            .map((s) => s.split("\n", 1)[0]!),
        ),
      ];
      invariant(
        keys.every((k) => !/[\r\n\0]/.test(k)),
        "Malformed Git configuration key.",
        "config_error",
      );
      return keys.flatMap((k) => [
        "-c",
        `${k}=${/\.(sslverify|usehttppath)$/i.test(k) ? "true" : /\.savecookies$/i.test(k) ? "false" : /\.username$/i.test(k) ? "token" : ""}`,
      ]);
    });
    const ownedArgs = [
      ...resets,
      "-c",
      "credential.helper=",
      "-c",
      `credential.helper=!${quote(process.execPath)} ${quote(helper)}`,
      "-c",
      "credential.useHttpPath=true",
      "-c",
      `http.proxy=${target.context.proxy ?? ""}`,
      ...(target.context.caFile ? ["-c", `http.sslCAInfo=${connection(target).caFile}`] : []),
      "-c",
      "http.extraHeader=",
      "-c",
      `http.${origin.endpoint}/.extraHeader=`,
      "-c",
      "http.followRedirects=false",
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.http.allow=always",
      "-c",
      "protocol.https.allow=always",
      ...args,
    ];
    const env = {
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_ASKPASS: "",
      SSH_ASKPASS: "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TRACE: undefined,
      GIT_TRACE_CURL: undefined,
      GIT_CURL_VERBOSE: undefined,
      GIT_EXEC_PATH: undefined,
      GIT_SSH_COMMAND: undefined,
      HTTP_PROXY: undefined,
      HTTPS_PROXY: undefined,
      ALL_PROXY: undefined,
      http_proxy: undefined,
      https_proxy: undefined,
      all_proxy: undefined,
      AGSX_GIT_CREDENTIAL_FILE: temporary.path,
    };
    const journal = yield* Journal;
    let sending = false,
      completed = false;
    if (command === "push") {
      const entry = yield* journal.begin(
        {
          id: input.invocation!,
          digest: fingerprint({ args, target: publicTarget(target) }),
          context: target.contextName,
          endpoint: target.context.endpoint,
          repository: origin.repository,
          operation: "git.push",
          method: "POST",
          path: `/${origin.repository}.git/git-receive-pack`,
          locator: { kind: "git-push", remote: origin.url },
        },
        config.journalLimit ?? 128,
      );
      if (!entry.fresh) {
        if (entry.entry.state === "complete")
          return { alreadyCompleted: true, invocation: input.invocation, receipt: entry.entry };
        return yield* Effect.fail(
          problem(
            "outcome_unknown",
            "This Git push invocation must be reconciled; it will not be replayed.",
            "git_push",
            { invocation: input.invocation },
          ),
        );
      }
      sending = true;
    }
    const execute = Effect.gen(function* () {
      const result = yield* runner.run({
        command: "git",
        args: ownedArgs,
        cwd: settings.options.cwd,
        env,
        timeoutMs: input.timeoutMs ?? 180_000,
        maxBytes: 8 * 1024 * 1024,
      });
      if (sending) {
        yield* journal.finish(input.invocation!, {
          state: result.exitCode === 0 ? "complete" : "unknown",
          resultDigest: fingerprint({ exit: result.exitCode, stdout: result.stdout }),
        });
        completed = true;
      }
      const clean = (s: string) => s.split(auth.bearer).join("[REDACTED]");
      return {
        exitCode: result.exitCode,
        stdout: clean(result.stdout),
        stderr: clean(result.stderr),
        target: publicTarget(target),
        ...(sending
          ? {
              invocation: input.invocation,
              outcome: result.exitCode === 0 ? "complete" : "unknown",
            }
          : {}),
      };
    });
    return yield* execute.pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          sending && !completed
            ? journal.finish(input.invocation!, { state: "unknown" }).pipe(Effect.ignore)
            : Effect.void,
        ),
      ),
    );
  });

export const bootstrapGit = (apply: boolean) =>
  Effect.gen(function* () {
    const settings = yield* Settings,
      home = settings.options.home,
      dir = join(home, "shims");
    const cli = join(packageRoot(), "dist", "cli.js");
    const specs = {
      agsx: `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`,
      git: `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(packageRoot(), "dist", "git-shim.js"))} "$@"\n`,
    };
    if (apply)
      yield* attempt("bootstrap", () => {
        privateDirectory(home, true);
        privateDirectory(dir, true);
        for (const [name, content] of Object.entries(specs)) {
          const path = join(dir, name);
          if (existsSync(path))
            invariant(
              privateBytes(path, 16_384).toString("utf8") === content,
              "Existing shim differs; inspect/remove it explicitly before replacement.",
              "conflict",
            );
          atomicPrivate(path, content);
          chmodSync(path, 0o700);
        }
      });
    return {
      planned: !apply,
      path: dir,
      commands: Object.keys(specs),
      globalPathChanged: false,
      gitConfigurationChanged: false,
      legacyGhAliasInstalled: false,
      note: "Explicitly prepend this directory only for the desired session; the explicit git shim preserves native stdout/stderr; agsx git.run returns structured JSON.",
    };
  });
