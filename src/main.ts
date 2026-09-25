import { Cause, Effect, Exit } from "effect";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { program } from "./application/app.js";
import { EXIT_CODES, problem, safeError } from "./domain/errors.js";
import { packageRoot } from "./platform/paths.js";

export function runCli(
  argv: readonly string[] = process.argv.slice(2),
  mode: "json" | "git" = "json",
): void {
  let completed = false;
  const options = {
    home: resolve(process.env.AGSX_HOME ?? join(homedir(), ".agsx")),
    cwd: process.cwd(),
    env: { ...process.env },
  };
  const effect = Effect.suspend(() => {
    if (existsSync(join(packageRoot(), ".installing.json")))
      return Effect.fail(
        problem(
          "integrity_error",
          "Installation is incomplete; resume its exact verified candidate before using this CLI.",
          "startup",
        ),
      );
    return program(argv, options);
  });
  NodeRuntime.runMain(effect, {
    disableErrorReporting: true,
    teardown(exit, onExit) {
      if (completed) return;
      completed = true;
      if (Exit.isSuccess(exit)) {
        const value = exit.value as { result: { data?: unknown }; exitCode: number };
        if (mode === "git") {
          const data = value.result.data as
            { stdout?: string; stderr?: string; alreadyCompleted?: boolean } | undefined;
          if (data?.stderr) process.stderr.write(data.stderr);
          process.stdout.write(data?.stdout ?? "", () => onExit(value.exitCode));
        } else
          process.stdout.write(`${JSON.stringify(value.result)}\n`, () => onExit(value.exitCode));
      } else {
        const error = Cause.hasInterruptsOnly(exit.cause)
          ? problem(
              "cancelled",
              "Operation cancelled; scoped resources were released.",
              "interrupt",
            )
          : safeError(Cause.squash(exit.cause), "runtime");
        const result = {
          schema: "agsx.result.v1",
          command:
            argv
              .slice(0, 2)
              .filter((s) => /^[a-z.-]+$/.test(s))
              .join(" ") || "unknown",
          status: error.code === "outcome_unknown" ? "unknown" : "error",
          error: {
            code: error.code,
            message: error.message,
            stage: error.stage,
            ...(error.details ? { details: error.details } : {}),
          },
        };
        (mode === "git" ? process.stderr : process.stdout).write(
          `${JSON.stringify(result)}\n`,
          () => onExit(EXIT_CODES[error.code]),
        );
      }
    },
  });
}
