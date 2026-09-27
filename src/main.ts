import { Cause, Effect, Exit } from "effect";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { program } from "./application/app.js";
import { EXIT_CODES, problem, safeError } from "./domain/errors.js";
import { packageRoot } from "./platform/paths.js";

export function runCli(argv: readonly string[] = process.argv.slice(2)): void {
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    const metadata = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8"));
    process.stdout.write(metadata.version + "\n");
    return;
  }
  const options = {
    home: resolve(process.env.AGSX_HOME ?? join(homedir(), ".agsx")),
    cwd: process.cwd(),
    env: { ...process.env },
  };
  const effect = Effect.suspend(() => program(argv, options));
  NodeRuntime.runMain(effect, {
    disableErrorReporting: true,
    teardown(exit, onExit) {
      if (Exit.isSuccess(exit)) {
        const value = exit.value as { result: unknown; exitCode: number };
        process.stdout.write(JSON.stringify(value.result) + "\n", () => onExit(value.exitCode));
        return;
      }
      const error = Cause.hasInterruptsOnly(exit.cause)
        ? problem("cancelled", "Cancelled; scoped resources released.", "interrupt")
        : safeError(Cause.squash(exit.cause), "runtime");
      const result = {
        schema: "agsx.result.v1",
        command:
          argv
            .slice(0, 2)
            .filter((x) => /^[a-z.-]+$/.test(x))
            .join(" ") || "unknown",
        status: error.code === "outcome_unknown" ? "unknown" : "error",
        error: {
          code: error.code,
          stage: error.stage,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      };
      process.stdout.write(JSON.stringify(result) + "\n", () => onExit(EXIT_CODES[error.code]));
    },
  });
}
