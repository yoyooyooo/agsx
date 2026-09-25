import { Effect } from "effect";
import {
  attempt,
  CliError,
  invariant,
  positive,
  problem,
  record,
  sha,
  text,
} from "../domain/errors.js";
import type { Target } from "../domain/model.js";
import {
  HttpTransport,
  expectStatus,
  type HttpRequest,
  type HttpResponse,
} from "../platform/http.js";
import { Journal, Settings, fingerprint } from "../platform/store.js";
import { authenticate, connection, type Credential } from "./identity.js";

export const readApi = (
  target: Target,
  path: string,
  operation = "repo.read",
  constraints: Readonly<Record<string, unknown>> = {},
  credential?: Credential,
) =>
  Effect.gen(function* () {
    const http = yield* HttpTransport;
    const auth = credential ?? (yield* authenticate(target, operation, constraints));
    const response = yield* http.request({
      ...connection(target),
      method: "GET",
      path,
      credential: auth.bearer,
    });
    yield* attempt("api_read", () => expectStatus(response));
    return { response, auth };
  });

export const paginate = (
  target: Target,
  path: string,
  options: { limit?: number; page?: number; all?: boolean },
  operation = "repo.read",
  constraints: Readonly<Record<string, unknown>> = {},
) =>
  Effect.gen(function* () {
    const auth = yield* authenticate(target, operation, constraints),
      http = yield* HttpTransport;
    const count = options.limit ?? 30,
      start = options.page ?? 1;
    yield* attempt("pagination", () => {
      invariant(
        Number.isInteger(count) && count >= 1 && count <= 100,
        "limit must be between 1 and 100.",
      );
      invariant(
        Number.isInteger(start) && start >= 1 && start <= 10000,
        "page must be a positive bounded integer.",
      );
    });
    const items: unknown[] = [];
    let page = start;
    let more = false;
    for (let n = 0; n < (options.all ? 20 : 1); n++) {
      const url = new URL(path, "http://example.test");
      url.searchParams.set("per_page", String(count));
      url.searchParams.set("page", String(page));
      const response = yield* http.request({
        ...connection(target),
        method: "GET",
        path: url.pathname + url.search,
        credential: auth.bearer,
      });
      const rows = yield* attempt("pagination", () => {
        expectStatus(response);
        invariant(
          Array.isArray(response.body),
          "Expected a paginated array from AGS.",
          "integrity_error",
        );
        return response.body;
      });
      items.push(...rows);
      more = rows.length >= count;
      page++;
      if (!more) break;
    }
    return {
      items,
      page: start,
      nextPage: more ? page : null,
      truncated: more,
      limit: count,
      principal: auth.principal,
    };
  });

export interface Mutation {
  readonly target: Target;
  readonly operation: string;
  readonly invocation: string;
  readonly method: Exclude<HttpRequest["method"], "GET">;
  readonly path: string;
  readonly body: unknown;
  readonly constraints?: Readonly<Record<string, unknown>>;
  readonly credential?: Credential;
  readonly bearer?: string;
  readonly validate?: (response: HttpResponse) => unknown;
  readonly locator?: Readonly<Record<string, unknown>>;
}
/** Durable local deduplication is not a server-wide exactly-once guarantee. */
export const mutate = (input: Mutation) =>
  Effect.gen(function* () {
    const journal = yield* Journal,
      settings = yield* Settings,
      http = yield* HttpTransport;
    const cfg = yield* settings.read();
    const digest = fingerprint({
      context: input.target.contextName,
      endpoint: input.target.context.endpoint,
      identity: input.target.identity,
      repo: input.target.repository,
      operation: input.operation,
      method: input.method,
      path: input.path,
      body: input.body,
    });
    const begun = yield* journal.begin(
      {
        id: input.invocation,
        digest,
        context: input.target.contextName,
        endpoint: input.target.context.endpoint,
        ...(input.target.repository ? { repository: input.target.repository } : {}),
        operation: input.operation,
        method: input.method,
        path: input.path,
        ...(input.locator ? { locator: input.locator } : {}),
      },
      cfg.journalLimit ?? 128,
    );
    if (!begun.fresh) {
      if (begun.entry.state === "complete")
        return {
          replayed: false,
          alreadyCompleted: true,
          invocation: input.invocation,
          receipt: begun.entry,
        };
      return yield* Effect.fail(
        problem(
          begun.entry.state === "rejected" ? "conflict" : "outcome_unknown",
          "This invocation already has an outcome; inspect/reconcile it rather than replaying the write.",
          "journal",
          { invocation: input.invocation, state: begun.entry.state },
        ),
      );
    }
    let settled = false,
      attempted = false;
    const execute = Effect.gen(function* () {
      const bearer =
        input.bearer ??
        (
          input.credential ??
          (yield* authenticate(input.target, input.operation, input.constraints))
        ).bearer;
      attempted = true;
      const response = yield* http.request({
        ...connection(input.target),
        method: input.method,
        path: input.path,
        body: input.body,
        credential: bearer,
        headers: { "X-AGS-Invocation-Id": input.invocation },
      });
      if (response.status >= 500 || response.status === 429) {
        yield* journal.finish(input.invocation, { state: "unknown", status: response.status });
        settled = true;
        return yield* Effect.fail(
          problem(
            "outcome_unknown",
            "The server returned an uncertain write result. Do not repeat the POST/PUT/PATCH/DELETE.",
            "write_status",
            { invocation: input.invocation, status: response.status },
          ),
        );
      }
      if (response.status < 200 || response.status >= 300) {
        yield* journal.finish(input.invocation, { state: "rejected", status: response.status });
        settled = true;
        yield* attempt("write_rejected", () => expectStatus(response));
      }
      const data = yield* attempt("write_readback", () =>
        input.validate ? input.validate(response) : (response.body ?? { status: response.status }),
      );
      yield* journal.finish(input.invocation, {
        state: "complete",
        status: response.status,
        resultDigest: fingerprint(data),
      });
      settled = true;
      return {
        replayed: false,
        alreadyCompleted: false,
        invocation: input.invocation,
        result: data,
      };
    });
    return yield* execute.pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          settled
            ? Effect.void
            : journal
                .finish(input.invocation, { state: attempted ? "unknown" : "rejected" })
                .pipe(Effect.ignore),
        ),
      ),
      Effect.catch((error) =>
        Effect.fail(
          new CliError({
            code: error.code,
            message: error.message,
            stage: error.stage,
            details: { ...error.details, invocation: input.invocation },
          }),
        ),
      ),
    );
  });

export function safeResponse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeResponse);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([k]) =>
            !/^(?:token|source_token|grant_token|session_token|access_token|refresh_token|password|secret|private_key|authorization|cookie)$/i.test(
              k,
            ),
        )
        .map(([k, v]) => [k, safeResponse(v)]),
    );
  if (typeof value === "string")
    return value
      .replace(/\b(?:ags_grant_|ags_sess_|mat_)[A-Za-z0-9_.-]{16,}\b/g, "[REDACTED]")
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[REDACTED]@");
  return value;
}
export function prFacts(value: unknown, number: number): Record<string, unknown> {
  const pr = record(value, "PR");
  invariant(
    positive(pr.number ?? pr.index) === number,
    "AGS returned a different PR.",
    "integrity_error",
  );
  sha(record(pr.head).sha);
  return pr;
}
export function projectionBinding(
  pr: Record<string, unknown>,
  provider = "forgejo",
): { provider: string; repository: string; number: number } | undefined {
  const rows = pr.external_projections;
  if (rows === undefined) return undefined;
  invariant(Array.isArray(rows), "Projection list is malformed.", "integrity_error");
  const found = rows.map((r) => record(r)).filter((r) => r.provider === provider);
  invariant(
    found.length <= 1,
    "Multiple provider mappings exist; caller must not guess a PR number.",
    "conflict",
  );
  if (found.length === 0) return undefined;
  return {
    provider,
    repository: text(found[0]!.external_repo),
    number: positive(found[0]!.external_number),
  };
}
export function validateProviderEvidence(
  body: unknown,
  target: Target,
  pr: Record<string, unknown>,
  auth: Credential,
  kind: "ci" | "projection",
) {
  const b = record(body, "provider evidence"),
    binding = projectionBinding(pr),
    p = record(b.provider),
    receipt = record(b.correlation_receipt),
    identity = record(receipt.authentication);
  invariant(binding, "No exact provider mapping is available.", "unsupported");
  invariant(
    b.schema === `ags.provider-${kind === "ci" ? "ci" : "projection"}-evidence.v1` &&
      b.repository === target.repository &&
      positive(b.ags_pr) === positive(pr.number),
    "Provider evidence is not bound to this AGS PR.",
    "integrity_error",
  );
  invariant(
    p.kind === binding.provider &&
      p.external_repo === binding.repository &&
      positive(p.external_number) === binding.number,
    "Provider coordinates differ from the AGS mapping.",
    "integrity_error",
  );
  if (kind === "ci")
    invariant(
      sha(b.head_sha) === sha(record(pr.head).sha),
      "CI evidence belongs to a different head.",
      "conflict",
    );
  invariant(
    receipt.schema === "ags.provider-observation-receipt.v1" &&
      receipt.repository === target.repository &&
      receipt.ags_pr === pr.number &&
      receipt.authorization === "allowed" &&
      receipt.provider_attempt === "attempted" &&
      receipt.provider_outcome === "observed",
    "Missing successful, target-bound provider observation receipt.",
    "integrity_error",
  );
  invariant(
    positive(identity.principal_id) === auth.principal.id &&
      identity.principal_login === auth.principal.login,
    "Provider evidence was authorized for a different principal.",
    "integrity_error",
  );
  invariant(
    auth.kind === "workload"
      ? identity.mode === "access_grant_transport" && identity.session_id === auth.session?.id
      : identity.mode === "durable" && identity.session_id === undefined,
    "Provider evidence uses an unexpected credential mode.",
    "integrity_error",
  );
  if (auth.session) {
    const source = record(receipt.workload);
    for (const field of ["workspace_id", "agent_id", "task_id"])
      invariant(
        source[field] === auth.session.source[field],
        "Provider workload binding differs.",
        "integrity_error",
      );
  }
  return b;
}
export function requiredChecks(
  runs: readonly Record<string, unknown>[],
  onlyRequired: boolean,
): readonly Record<string, unknown>[] {
  if (!onlyRequired) return runs;
  invariant(
    runs.length > 0 && runs.every((r) => typeof r.required === "boolean"),
    "AGS did not provide complete required-check policy facts; no client-side policy was invented.",
    "unsupported",
    "ci_policy",
  );
  return runs.filter((r) => r.required === true);
}
export function ciState(
  run: Record<string, unknown>,
): "pass" | "fail" | "cancelled" | "skipped" | "pending" | "unknown" {
  const state = String(run.conclusion ?? run.status ?? "").toLowerCase();
  if (["success", "passed", "pass", "neutral"].includes(state)) return "pass";
  if (["failure", "failed", "error", "timed_out", "action_required"].includes(state)) return "fail";
  if (["cancelled", "canceled"].includes(state)) return "cancelled";
  if (["skipped", "stale"].includes(state)) return "skipped";
  if (["queued", "waiting", "requested", "pending", "in_progress", "running"].includes(state))
    return "pending";
  return "unknown";
}
