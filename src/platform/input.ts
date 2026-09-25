import { Effect } from "effect";
import { CliError, problem } from "../domain/errors.js";

/** Finite, cancellable stdin consumption for agent-supplied JSON. */
export const readStandardInput = Effect.callback<Buffer, CliError>((resume) => {
  const chunks: Buffer[] = [];
  let size = 0;
  let finished = false;
  const complete = (effect: Effect.Effect<Buffer, CliError>) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    resume(effect);
  };
  const onData = (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 1024 * 1024) {
      complete(Effect.fail(problem("invalid_input", "Input exceeds 1 MiB.", "stdin")));
      process.stdin.pause();
      return;
    }
    chunks.push(bytes);
  };
  const onEnd = () => complete(Effect.succeed(Buffer.concat(chunks)));
  const onError = () =>
    complete(
      Effect.fail(problem("invalid_input", "Could not read the JSON input stream.", "stdin")),
    );
  const timer = setTimeout(
    () =>
      complete(
        Effect.fail(
          problem(
            "invalid_input",
            "JSON stdin was not completed within 30 seconds.",
            "stdin_timeout",
          ),
        ),
      ),
    30_000,
  );
  process.stdin.on("data", onData);
  process.stdin.once("end", onEnd);
  process.stdin.once("error", onError);
  if (process.stdin.readableEnded) onEnd();
  else process.stdin.resume();
  return Effect.sync(() => {
    clearTimeout(timer);
    process.stdin.removeListener("data", onData);
    process.stdin.removeListener("end", onEnd);
    process.stdin.removeListener("error", onError);
    process.stdin.pause();
  });
});
