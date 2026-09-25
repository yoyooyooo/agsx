import { Data, Effect } from "effect";

export type ErrorCode =
  | "invalid_input"
  | "config_error"
  | "unsupported"
  | "unauthenticated"
  | "denied"
  | "conflict"
  | "outcome_unknown"
  | "unavailable"
  | "pending"
  | "cancelled"
  | "integrity_error";
export const EXIT_CODES: Readonly<Record<ErrorCode, number>> = {
  invalid_input: 2,
  config_error: 3,
  unsupported: 3,
  unauthenticated: 4,
  denied: 4,
  conflict: 5,
  outcome_unknown: 6,
  unavailable: 7,
  pending: 8,
  cancelled: 130,
  integrity_error: 5,
};

/** Only safe, deliberately authored fields belong in the public error channel. */
export class CliError extends Data.TaggedError("CliError")<{
  readonly code: ErrorCode;
  readonly message: string;
  readonly stage: string;
  readonly details?: Readonly<Record<string, unknown>>;
}> {}
export const problem = (
  code: ErrorCode,
  message: string,
  stage = "validation",
  details?: Readonly<Record<string, unknown>>,
) => new CliError({ code, message, stage, ...(details ? { details } : {}) });
export const safeError = (error: unknown, stage: string): CliError =>
  error instanceof CliError
    ? error
    : problem(
        "unavailable",
        "The operation could not be completed; no raw exception was exposed.",
        stage,
      );
export const attempt = <A>(stage: string, f: () => A): Effect.Effect<A, CliError> =>
  Effect.try({ try: f, catch: (e) => safeError(e, stage) });
export const promise = <A>(
  stage: string,
  f: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, CliError> => Effect.tryPromise({ try: f, catch: (e) => safeError(e, stage) });

export function invariant(
  condition: unknown,
  message: string,
  code: ErrorCode = "invalid_input",
  stage = "validation",
): asserts condition {
  if (!condition) throw problem(code, message, stage);
}
export function record(value: unknown, label = "value"): Record<string, unknown> {
  invariant(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object.`,
  );
  return value as Record<string, unknown>;
}
export function text(value: unknown, label = "value"): string {
  invariant(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 16_384 &&
      !/[\u0000]/.test(value),
    `${label} must be nonempty text.`,
  );
  return value;
}
export function positive(value: unknown, label = "id"): number {
  const n = typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? Number(value) : value;
  invariant(
    typeof n === "number" && Number.isSafeInteger(n) && n > 0,
    `${label} must be a positive integer.`,
  );
  return n;
}
export function sha(value: unknown): string {
  invariant(
    typeof value === "string" && /^[a-f0-9]{40}$/.test(value),
    "Expected an exact lowercase SHA-1 commit.",
  );
  return value;
}
export function slug(value: unknown): string {
  invariant(
    typeof value === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) &&
      !value.includes(".."),
    "Repository must be owner/name.",
  );
  return value;
}
export const repoPath = (value: string) => slug(value).split("/").map(encodeURIComponent).join("/");
export function branch(value: unknown): string {
  const s = text(value, "branch");
  invariant(
    !s.startsWith("-") &&
      !s.startsWith("/") &&
      !s.endsWith("/") &&
      !s.endsWith(".") &&
      !s.includes("..") &&
      !s.includes("@{") &&
      !s.includes("//") &&
      !/[\s~^:?*\[\]\\]/.test(s) &&
      s !== "@" &&
      s.split("/").every((x) => !x.startsWith(".") && !x.endsWith(".lock")),
    "Invalid Git branch name.",
  );
  return s;
}
export function onlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  invariant(
    Object.keys(value).every((k) => keys.includes(k)),
    `${label} contains an unknown field.`,
  );
}
