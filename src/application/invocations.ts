import { Effect } from "effect";
import { attempt, invariant, positive, record, repoPath } from "../domain/errors.js";
import type { Input } from "../domain/commands.js";
import { Journal, fingerprint } from "../platform/store.js";
import { resolveTarget } from "./routing.js";
import { paginate, readApi } from "./client.js";
import { obtainGrant, connection } from "./identity.js";
import { HttpTransport, expectStatus } from "../platform/http.js";

/** A readback confirms current facts, not necessarily which client caused them.
 * Unknown operations that cannot be proven stay unknown and are never replayed.
 */
export const invocationCommand = (name: string, input: Input) =>
  Effect.gen(function* () {
    const journal = yield* Journal;
    if (name === "invocation.list")
      return { operations: yield* journal.list(), requestBodiesRetained: false };
    const id = String(input.id),
      entry = yield* journal.get(id);
    yield* attempt("invocation", () =>
      invariant(entry, "Invocation not found in this client home.", "config_error"),
    );
    if (name === "invocation.show") return entry;
    if (entry!.state === "complete" || entry!.state === "rejected")
      return { receipt: entry, needsReconciliation: false, replayed: false };
    if (entry!.context.startsWith("operator-"))
      return {
        receipt: entry,
        pending: true,
        replayed: false,
        nextCommand: "ops.verify",
        reason: "Operator state must be observed using its explicit manifest.",
      };
    const target = yield* resolveTarget(
      { context: entry!.context, repo: entry!.repository, identity: input.identity },
      Boolean(entry!.repository),
    );
    yield* attempt("invocation_target", () =>
      invariant(
        target.context.endpoint === entry!.endpoint,
        "Context endpoint changed since this operation; cannot reconcile against another service.",
        "conflict",
      ),
    );
    const loc = record(entry!.locator ?? {}),
      root = entry!.repository ? `/api/v3/repos/${repoPath(entry!.repository)}` : "";
    let confirmed = false;
    let observed: unknown = null;
    let attribution = "current_state_only";
    if (loc.kind === "repository") {
      const result = yield* readApi(target, root);
      const repository = record(result.response.body);
      confirmed = repository.full_name === entry!.repository && positive(repository.id) > 0;
      observed = {
        id: repository.id,
        full_name: repository.full_name,
        default_branch: repository.default_branch,
      };
    } else if (loc.kind === "pull") {
      const result = yield* paginate(
        target,
        `${root}/pulls?${new URLSearchParams({ state: "all", head: String(loc.head), base: String(loc.base) })}`,
        { limit: 100 },
        "pr.read",
      );
      const exact = result.items
        .map((p) => record(p))
        .filter(
          (p) =>
            record(p.head).sha === loc.expectedHead &&
            record(p.head).ref === String(loc.head).split(":").at(-1) &&
            record(p.base).ref === loc.base &&
            fingerprint(p.title) === loc.titleDigest,
        );
      yield* attempt("invocation_reconcile", () =>
        invariant(
          exact.length <= 1,
          "Multiple PRs match the prior request; no causal outcome can be inferred.",
          "conflict",
        ),
      );
      confirmed = exact.length === 1;
      observed = exact.map((p) => ({ number: p.number, head: record(p.head).sha, state: p.state }));
    } else if (loc.kind === "merge") {
      const number = positive(loc.number);
      if (target.identity === "workload") {
        const material = yield* obtainGrant(target),
          http = yield* HttpTransport;
        yield* attempt("invocation_grant", () =>
          invariant(
            material.grant.id === loc.grantId,
            "This merge belongs to a different grant; do not substitute a new principal.",
            "conflict",
          ),
        );
        const response = yield* http.request({
          ...connection(target),
          path: `/api/v3/access-grants/invocations/${encodeURIComponent(id)}`,
          method: "GET",
          credential: material.token,
        });
        const receipt = yield* attempt("invocation_receipt", () =>
          record(expectStatus(response).body),
        );
        yield* attempt("invocation_receipt", () =>
          invariant(
            receipt.id === id &&
              receipt.grant_id === loc.grantId &&
              receipt.repository === entry!.repository &&
              receipt.expected_head_sha === loc.expectedHead,
            "Server invocation receipt does not match the original operation.",
            "integrity_error",
          ),
        );
        confirmed =
          receipt.authorization_outcome === "allowed" &&
          receipt.provider_merged === true &&
          ["confirmed", "reconciled_after_error"].includes(String(receipt.provider_outcome));
        observed = receipt;
        attribution = "server_invocation";
      } else {
        const result = yield* readApi(
          target,
          `${root}/pulls/${number}/provider/merge?${new URLSearchParams({ expected_head_sha: String(loc.expectedHead) })}`,
          "pr.read",
          { pull_request_number: number },
        );
        const receipt = record(result.response.body);
        confirmed =
          receipt.provider_merged === true &&
          (receipt.expected_head_sha === undefined ||
            receipt.expected_head_sha === loc.expectedHead);
        observed = receipt;
      }
    } else if (loc.kind === "pull-patch") {
      const number = positive(loc.number),
        result = yield* readApi(target, `${root}/pulls/${number}`, "pr.read", {
          pull_request_number: number,
        });
      const pr = record(result.response.body),
        fields = record(loc.fieldDigests ?? {});
      confirmed =
        Object.keys(fields).length > 0 &&
        Object.entries(fields).every(
          ([key, digest]) => fingerprint(key === "base" ? record(pr.base).ref : pr[key]) === digest,
        );
      observed = { number: pr.number, head: record(pr.head).sha, state: pr.state };
    } else {
      return {
        receipt: entry,
        pending: true,
        replayed: false,
        reason:
          "This operation has no server receipt that proves its exact outcome. Inspect its Git ref/comment/review externally; the CLI will not resend it.",
      };
    }
    if (!confirmed)
      return { receipt: entry, pending: true, observed, replayed: false, attribution };
    const receipt = yield* journal.finish(id, {
      state: "complete",
      resultDigest: fingerprint(observed),
    });
    return { receipt, confirmed: true, observed, replayed: false, attribution };
  });
