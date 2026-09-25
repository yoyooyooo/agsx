import { Effect } from "effect";
import { attempt, invariant, positive, problem, record, repoPath, sha } from "../domain/errors.js";
import type { Input } from "../domain/commands.js";
import type { Target } from "../domain/model.js";
import { HttpTransport, expectStatus } from "../platform/http.js";
import { authenticate, connection } from "./identity.js";
import {
  ciState,
  prFacts,
  projectionBinding,
  readApi,
  requiredChecks,
  validateProviderEvidence,
} from "./client.js";

export const ciSnapshot = (target: Target, number: number) =>
  Effect.gen(function* () {
    const root = `/api/v3/repos/${repoPath(target.repository!)}/pulls/${number}`;
    const pr = yield* attempt("ci_pr", () => (number > 0 ? number : positive(number)));
    const observed = (yield* readApi(target, root, "pr.read", { pull_request_number: pr })).response
      .body;
    const pull = yield* attempt("ci_pr", () => prFacts(observed, number));
    const binding = yield* attempt("ci_projection", () => projectionBinding(pull));
    if (!binding) {
      const job = pull.projection_job;
      if (job && typeof job === "object")
        return {
          pending: true as const,
          reason: "projection_pending",
          head: sha(record(pull.head).sha),
          runs: [] as Record<string, unknown>[],
          provider: null,
        };
      return yield* Effect.fail(
        problem(
          "unsupported",
          "No exact CI provider binding is exposed for this PR. A missing provider is not treated as a failing required check.",
          "ci_capability",
        ),
      );
    }
    const auth = yield* authenticate(target, "ci.read", {
        pull_request_number: number,
        forgejo_pull_request_number: binding.number,
        expected_head_sha: sha(record(pull.head).sha),
      }),
      http = yield* HttpTransport;
    const response = yield* http.request({
      ...connection(target),
      path: `${root}/provider/ci/runs`,
      method: "GET",
      credential: auth.bearer,
    });
    const facts = yield* attempt("ci_evidence", () =>
      validateProviderEvidence(expectStatus(response).body, target, pull, auth, "ci"),
    );
    const runs = yield* attempt("ci_evidence", () => {
      invariant(Array.isArray(facts.runs), "CI evidence is missing its runs.", "integrity_error");
      return facts.runs.map((row) => {
        const r = record(row);
        positive(r.id);
        invariant(
          r.head_sha === record(pull.head).sha,
          "A CI run is for a different head.",
          "conflict",
        );
        if (r.pull_request_number !== undefined)
          invariant(
            r.pull_request_number === binding.number,
            "CI run belongs to another provider PR.",
            "integrity_error",
          );
        return r;
      });
    });
    return {
      pending: false as const,
      reason: null,
      head: sha(record(pull.head).sha),
      runs,
      provider: binding,
    };
  });
export const ciCommand = (name: string, input: Input, target: Target) =>
  Effect.gen(function* () {
    const number = yield* attempt("ci_input", () => positive(input.number, "PR number"));
    const wait = input.waitMs === undefined ? 60_000 : Number(input.waitMs),
      interval = input.intervalMs === undefined ? 1000 : Number(input.intervalMs);
    yield* attempt("ci_input", () =>
      invariant(
        Number.isInteger(wait) &&
          wait >= 0 &&
          wait <= 300_000 &&
          Number.isInteger(interval) &&
          interval >= 100 &&
          interval <= 30_000,
        "Invalid watch bounds.",
      ),
    );
    const end = Date.now() + wait;
    while (true) {
      const snapshot = yield* ciSnapshot(target, number);
      if (name === "ci.checks") {
        const selected = yield* attempt("ci_required", () =>
          snapshot.pending ? snapshot.runs : requiredChecks(snapshot.runs, input.required === true),
        );
        const checks = selected.map((run) => ({
          ...run,
          bucket: ciState(run),
          required: typeof run.required === "boolean" ? run.required : null,
          requirementSource: run.requirement_source ?? null,
        }));
        const pending =
          snapshot.pending ||
          checks.length === 0 ||
          checks.some((c) => c.bucket === "pending" || c.bucket === "unknown");
        const failed = checks.some((c) => c.bucket === "fail" || c.bucket === "cancelled");
        if (!input.watch || !pending || Date.now() >= end || (input.failFast && failed))
          return {
            head: snapshot.head,
            provider: snapshot.provider,
            checks,
            pending,
            failed,
            reason: snapshot.reason,
            waitExpired: Boolean(input.watch && pending && Date.now() >= end),
          };
        yield* Effect.sleep(Math.min(interval, Math.max(0, end - Date.now())));
        continue;
      }
      if (snapshot.pending) return { pending: true, reason: snapshot.reason, runs: [] };
      const limit = Number(input.limit ?? 30);
      yield* attempt("run_input", () =>
        invariant(
          Number.isInteger(limit) && limit >= 1 && limit <= 100,
          "Run limit must be 1..100.",
        ),
      );
      let runs = snapshot.runs;
      for (const [key, field] of [
        ["branch", "head_branch"],
        ["commit", "head_sha"],
        ["event", "event"],
        ["state", "status"],
        ["workflow", "workflow_id"],
      ])
        if (input[key!] !== undefined)
          runs = runs.filter((r) => String(r[field!]) === String(input[key!]));
      if (name === "run.list")
        return {
          head: snapshot.head,
          provider: snapshot.provider,
          runs: runs.slice(0, limit),
          truncated: runs.length > limit,
          claim:
            "The server limits provider run observation; this is not unlimited historical enumeration.",
        };
      const runId = yield* attempt("run_input", () => positive(input.runId, "runId"));
      const run = runs.find((r) => r.id === runId);
      yield* attempt("run_binding", () =>
        invariant(run, "Run ID does not belong to this exact-head PR observation.", "conflict"),
      );
      if (name === "run.view") return { head: snapshot.head, provider: snapshot.provider, run };
      if (input.failedOnly && !["fail", "cancelled"].includes(ciState(run!)))
        return { runId, text: "", skipped: true, reason: "run_not_failed" };
      const auth = yield* authenticate(target, "ci.read", {
          pull_request_number: number,
          forgejo_pull_request_number: snapshot.provider!.number,
          run_id: runId,
        }),
        http = yield* HttpTransport;
      const response = yield* http.request({
        ...connection(target),
        path: `/api/v3/repos/${repoPath(target.repository!)}/pulls/${number}/provider/ci/runs/${runId}/logs`,
        method: "GET",
        credential: auth.bearer,
        maxBytes: 8 * 1024 * 1024,
      });
      const body = yield* attempt("run_logs", () => {
        const b = record(expectStatus(response).body);
        invariant(
          b.schema === "ags.provider-ci-run-logs.v1" &&
            b.repository === target.repository &&
            b.ags_pr === number &&
            b.run_id === runId &&
            typeof b.text === "string",
          "Run log receipt does not match its requested run.",
          "integrity_error",
        );
        const receipt = record(b.correlation_receipt),
          principal = record(receipt.authentication),
          provider = record(receipt.provider);
        invariant(
          receipt.schema === "ags.provider-observation-receipt.v1" &&
            receipt.repository === target.repository &&
            receipt.ags_pr === number &&
            receipt.operation === "ci.read" &&
            receipt.authorization === "allowed" &&
            receipt.provider_attempt === "attempted" &&
            receipt.provider_outcome === "observed",
          "Run log observation is not an authorized exact PR read.",
          "integrity_error",
        );
        invariant(
          principal.principal_id === auth.principal.id &&
            principal.principal_login === auth.principal.login,
          "Run logs were authorized for another principal.",
          "integrity_error",
        );
        invariant(
          provider.kind === snapshot.provider!.provider &&
            provider.external_repo === snapshot.provider!.repository &&
            provider.external_number === snapshot.provider!.number,
          "Run logs belong to a different provider mapping.",
          "integrity_error",
        );
        invariant(
          auth.kind === "workload"
            ? principal.mode === "access_grant_transport" &&
                principal.session_id === auth.session?.id
            : principal.mode === "durable" && principal.session_id === undefined,
          "Run logs use an unexpected authentication mode.",
          "integrity_error",
        );
        if (auth.kind === "workload")
          for (const key of ["workspace_id", "agent_id", "task_id"])
            invariant(
              record(receipt.workload)[key] === auth.session.source[key],
              "Run log workload source does not match the current request.",
              "integrity_error",
            );
        return b;
      });
      return { runId, head: snapshot.head, text: body.text, observedAt: body.observed_at };
    }
  });
