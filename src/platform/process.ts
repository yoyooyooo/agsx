import { Context, Effect, Layer } from "effect";
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { CliError, invariant, problem, safeError } from "../domain/errors.js";

export interface ProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdin?: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}
export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}
export class ProcessRunner extends Context.Service<
  ProcessRunner,
  {
    readonly run: (request: ProcessRequest) => Effect.Effect<ProcessResult, CliError>;
  }
>()("agsx/ProcessRunner") {}

/** No shell, no detached background tasks, and no inherited caller credentials. */
export function processLayer(
  baseEnv: Readonly<Record<string, string | undefined>>,
): Layer.Layer<ProcessRunner> {
  return Layer.succeed(ProcessRunner, {
    run: (input) =>
      Effect.callback<ProcessResult, CliError>((resume) => {
        let child: ReturnType<typeof spawn> | undefined;
        let timer: NodeJS.Timeout | undefined;
        let killTimer: NodeJS.Timeout | undefined;
        let done = false;
        let failure: CliError | undefined;
        const stdout: Buffer[] = [],
          stderr: Buffer[] = [];
        let size = 0;
        const stop = () => {
          if (!child || child.exitCode !== null || child.signalCode !== null || killTimer) return;
          try {
            if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
            else child.kill("SIGTERM");
          } catch {
            /* Already exited. */
          }
          killTimer = setTimeout(() => {
            if (!child || child.exitCode !== null || child.signalCode !== null) return;
            try {
              if (process.platform !== "win32" && child?.pid) process.kill(-child.pid, "SIGKILL");
              else child?.kill("SIGKILL");
            } catch {
              /* Already exited. */
            }
          }, 750);
        };
        try {
          invariant(
            input.command.length > 0 &&
              !input.command.includes("\u0000") &&
              input.args.every((a) => !a.includes("\u0000")),
            "Invalid process arguments.",
          );
          const timeout = input.timeoutMs ?? 60_000,
            max = input.maxBytes ?? 2 * 1024 * 1024;
          invariant(
            timeout >= 50 && timeout <= 900_000 && max >= 1024 && max <= 32 * 1024 * 1024,
            "Invalid process limits.",
          );
          const env: Record<string, string> = {};
          for (const [k, v] of Object.entries(baseEnv)) {
            if (
              v !== undefined &&
              !/(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|COOKIE)/i.test(k) &&
              !/^(?:GIT_TRACE|GIT_CONFIG_|GH_|GITHUB_|MULTICA_|AGS_|AGSX_)/.test(k)
            )
              env[k] = v;
          }
          for (const [k, v] of Object.entries(input.env ?? {})) {
            if (v === undefined) delete env[k];
            else env[k] = v;
          }
          for (const key of [
            "NODE_OPTIONS",
            "NODE_PATH",
            "GIT_EXEC_PATH",
            "GIT_SSH_COMMAND",
            "GIT_SSH",
            "GIT_PROXY_COMMAND",
          ])
            delete env[key];
          let executable = input.command;
          if (input.command === "git") {
            const candidates =
              process.platform === "win32"
                ? (env.PATH ?? "")
                    .split(delimiter)
                    .filter((p) => !/[\\/]shims$/.test(p))
                    .map((p) => join(p, "git.exe"))
                : ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"];
            executable =
              candidates.find((p) => {
                try {
                  accessSync(p, constants.X_OK);
                  return true;
                } catch {
                  return false;
                }
              }) ?? "";
            invariant(
              executable,
              "Native Git is not installed; no shim fallback will be attempted.",
              "unsupported",
            );
          }
          child = spawn(executable, [...input.args], {
            cwd: input.cwd,
            env,
            shell: false,
            windowsHide: true,
            detached: process.platform !== "win32",
            stdio: ["pipe", "pipe", "pipe"],
          });
          const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
            size += chunk.length;
            if (size > max) {
              failure = problem(
                "unavailable",
                "Process output exceeded its bound.",
                "process_output",
              );
              stop();
              return;
            }
            chunks.push(Buffer.from(chunk));
          };
          child.stdout!.on("data", collect(stdout));
          child.stderr!.on("data", collect(stderr));
          child.stdin!.on("error", () => {
            /* Early child exit is handled by close. */
          });
          child.on("error", () => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            resume(
              Effect.fail(
                problem(
                  "unavailable",
                  "Required executable could not be started.",
                  "process_spawn",
                ),
              ),
            );
          });
          child.on("close", (code, signal) => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            if (killTimer) clearTimeout(killTimer);
            if (failure) resume(Effect.fail(failure));
            else
              resume(
                Effect.succeed({
                  exitCode: code ?? (signal ? 130 : 1),
                  stdout: Buffer.concat(stdout).toString("utf8"),
                  stderr: Buffer.concat(stderr).toString("utf8"),
                }),
              );
          });
          timer = setTimeout(() => {
            failure = problem(
              "unavailable",
              "The subprocess timed out and was terminated.",
              "process_timeout",
            );
            stop();
          }, timeout);
          child.stdin!.end(input.stdin);
        } catch (e) {
          done = true;
          resume(Effect.fail(safeError(e, "process_setup")));
        }
        return Effect.callback<void>((complete) => {
          if (timer) clearTimeout(timer);
          if (!child || child.exitCode !== null || child.signalCode !== null) {
            if (killTimer) clearTimeout(killTimer);
            complete(Effect.void);
            return;
          }
          child.once("close", () => {
            if (killTimer) clearTimeout(killTimer);
            complete(Effect.void);
          });
          stop();
        });
      }),
  });
}
