import { Effect } from "effect";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  attempt,
  branch,
  invariant,
  positive,
  record,
  repoPath,
  sha,
  text,
} from "../domain/errors.js";
import type { Input } from "../domain/commands.js";
import type { Target } from "../domain/model.js";
import { Settings, fingerprint } from "../platform/store.js";
import { ProcessRunner } from "../platform/process.js";
import { obtainGrant } from "./identity.js";
import { mutate, paginate, prFacts, projectionBinding, readApi } from "./client.js";
import { rebasePull } from "./rebase.js";

export const inputBody = (input: Input) =>
  Effect.gen(function* () {
    const settings = yield* Settings;
    return yield* attempt("body_input", () => {
      invariant(
        !(input.body !== undefined && input.bodyFile !== undefined),
        "Choose body or bodyFile, not both.",
      );
      if (input.bodyFile !== undefined) {
        const file = resolve(settings.options.cwd, text(input.bodyFile));
        invariant(
          statSync(file).isFile() && statSync(file).size <= 1024 * 1024,
          "Body file must be a bounded regular file.",
        );
        return readFileSync(file, "utf8");
      }
      return input.body === undefined ? undefined : String(input.body);
    });
  });
function exactHead(input: unknown): string {
  const s = text(input, "head"),
    parts = s.split(":");
  invariant(parts.length <= 2, "head must be branch or owner:branch.");
  if (parts.length === 2) invariant(/^[A-Za-z0-9_.-]+$/.test(parts[0]!), "Invalid head owner.");
  branch(parts.at(-1));
  return s;
}

export const pullCommand = (name: string, input: Input, target: Target) =>
  Effect.gen(function* () {
    const root = `/api/v3/repos/${repoPath(target.repository!)}`;
    if (name === "pr.list" || name === "pr.status") {
      const params = new URLSearchParams({ state: String(input.state ?? "open") });
      for (const k of ["head", "base", "author"])
        if (input[k] !== undefined) params.set(k, String(input[k]));
      if (input.labels) params.set("labels", (input.labels as string[]).join(","));
      const result = yield* paginate(
        target,
        `${root}/pulls?${params}`,
        input as { limit?: number; page?: number; all?: boolean },
        "pr.read",
      );
      const items = result.items.map((x) => record(x));
      const filtered =
        input.draft === undefined ? items : items.filter((x) => x.draft === input.draft);
      if (name === "pr.list") return { ...result, items: filtered };
      return {
        ...result,
        items: undefined,
        createdByMe: filtered.filter(
          (x) => record(x.user ?? x.author ?? {}).login === result.principal.login,
        ),
        other: filtered.filter(
          (x) => record(x.user ?? x.author ?? {}).login !== result.principal.login,
        ),
      };
    }
    if (name === "pr.create") {
      const head = yield* attempt("pr_input", () => exactHead(input.head)),
        base = yield* attempt("pr_input", () => branch(input.base));
      let title = input.title === undefined ? undefined : String(input.title),
        body = yield* inputBody(input);
      if (input.fill) {
        const runner = yield* ProcessRunner,
          settings = yield* Settings;
        const gitHead = head.split(":").at(-1)!;
        const log = yield* runner.run({
          command: "git",
          args: ["log", "--format=%s%n%b", `${base}..${gitHead}`, "--"],
          cwd: settings.options.cwd,
          timeoutMs: 5000,
        });
        yield* attempt("pr_fill", () =>
          invariant(
            log.exitCode === 0 && log.stdout.trim(),
            "Cannot fill a PR from the selected local branch range.",
            "config_error",
          ),
        );
        title ??= log.stdout.trim().split("\n")[0];
        body ??= log.stdout.trim();
      }
      yield* attempt("pr_input", () =>
        invariant(title && title.length <= 500, "PR title is required (or use fill)."),
      );
      const localHead = head.split(":").at(-1)!;
      const branchRepo = head.includes(":")
        ? `${head.split(":")[0]}/${target.repository!.split("/")[1]}`
        : target.repository!;
      const ref = (yield* readApi(
        { ...target, repository: branchRepo },
        `/api/v3/repos/${repoPath(branchRepo)}/git/ref/heads/${encodeURIComponent(localHead)}`,
        "pr.read",
        { head_ref: localHead },
      )).response.body;
      const headSha = yield* attempt("pr_head", () => sha(record(record(ref).object).sha));
      if (input.expectedHead !== undefined)
        yield* attempt("pr_head", () =>
          invariant(
            headSha === sha(input.expectedHead),
            "Remote head changed since the request was planned.",
            "conflict",
          ),
        );
      const before = yield* paginate(
        target,
        `${root}/pulls?${new URLSearchParams({ state: "open", head, base })}`,
        { limit: 100 },
        "pr.read",
      );
      const exact = before.items
        .map((x) => record(x))
        .filter(
          (p) =>
            record(p.head).ref === localHead &&
            record(p.base).ref === base &&
            record(p.head).sha === headSha,
        );
      yield* attempt("pr_preflight", () =>
        invariant(
          exact.length <= 1,
          "Multiple matching PRs exist; choose one explicitly.",
          "conflict",
        ),
      );
      if (exact.length === 1) return { created: false, existing: true, pull: exact[0] };
      return yield* mutate({
        target,
        operation: "pr.create",
        invocation: input.invocation!,
        method: "POST",
        path: `${root}/pulls`,
        body: { head, base, title, body: body ?? "", draft: input.draft ?? false },
        constraints: { head_ref: head, base_ref: base },
        locator: {
          kind: "pull",
          head,
          base,
          expectedHead: headSha,
          titleDigest: fingerprint(title),
        },
        validate: (r) => {
          const p = record(r.body);
          positive(p.number ?? p.index);
          invariant(
            sha(record(p.head).sha) === headSha,
            "Created PR head differs from the observed source.",
            "integrity_error",
          );
          return {
            created: true,
            pull: p,
            projection: { status: "separate_observation", command: "pr.view" },
          };
        },
      });
    }
    const number = yield* attempt("pr_input", () => positive(input.number, "PR number"));
    const path = `${root}/pulls/${number}`,
      read = (yield* readApi(target, path, "pr.read", { pull_request_number: number })).response;
    const pr = yield* attempt("pr_read", () => prFacts(read.body, number));
    if (name === "pr.view") {
      if (!input.comments) return pr;
      const comments = yield* paginate(
        target,
        `${root}/issues/${number}/comments`,
        { limit: 100 },
        "pr.read",
        { pull_request_number: number },
      );
      return { pull: pr, comments };
    }
    if (name === "pr.reviews")
      return yield* paginate(
        target,
        `${path}/reviews`,
        input as { limit?: number; page?: number; all?: boolean },
        "review.read",
        { pull_request_number: number },
      );
    if (input.expectedHead !== undefined)
      yield* attempt("pr_precondition", () =>
        invariant(
          sha(record(pr.head).sha) === sha(input.expectedHead),
          "PR head changed; this request must be replanned.",
          "conflict",
        ),
      );
    if (name === "pr.merge") {
      const binding = yield* attempt("merge_policy", () => projectionBinding(pr));
      yield* attempt("merge_policy", () =>
        invariant(
          binding,
          "This server has no bound exact-head merge provider. Native merge without an atomic head condition is deliberately unsupported.",
          "unsupported",
        ),
      );
      const expected = sha(input.expectedHead),
        method = String(input.method);
      if (target.identity === "workload") {
        const material = yield* obtainGrant(target);
        yield* attempt("merge_authority", () =>
          invariant(
            (material.grant.effective_operations as string[]).includes("pr.merge"),
            "The workload grant does not include the merge effect.",
            "denied",
          ),
        );
        return yield* mutate({
          target,
          operation: "pr.merge",
          invocation: input.invocation!,
          method: "POST",
          path: "/api/v3/access-grants/effects/pr.merge",
          bearer: material.token,
          body: {
            invocation_id: input.invocation,
            ags_pr_number: number,
            provider_pr_number: binding!.number,
            expected_head_sha: expected,
            merge_method: method,
          },
          locator: {
            kind: "merge",
            number,
            expectedHead: expected,
            provider: binding!.provider,
            providerNumber: binding!.number,
            grantId: material.grant.id,
          },
          validate: (r) => {
            const result = record(r.body);
            invariant(
              result.schema === "ags.access-grant-invocation.v1" &&
                result.id === input.invocation &&
                result.repository === target.repository &&
                result.operation === "pr.merge" &&
                result.expected_head_sha === expected &&
                result.grant_id === material.grant.id,
              "Merge effect receipt does not match its invocation.",
              "integrity_error",
            );
            invariant(
              result.authorization_outcome === "allowed",
              "Merge authority was denied.",
              "denied",
            );
            invariant(
              ["confirmed", "reconciled_after_error"].includes(String(result.provider_outcome)) &&
                result.provider_merged === true,
              "Merge completion is not confirmed; reconcile its invocation.",
              "outcome_unknown",
            );
            return result;
          },
        });
      }
      return yield* mutate({
        target,
        operation: "pr.merge",
        invocation: input.invocation!,
        method: "POST",
        path: `${path}/provider/merge`,
        body: { expected_head_sha: expected, merge_method: method },
        locator: {
          kind: "merge",
          number,
          expectedHead: expected,
          provider: binding!.provider,
          providerNumber: binding!.number,
        },
        validate: (r) => {
          const result = record(r.body);
          invariant(
            result.provider_merged === true,
            "Provider merge is not confirmed; observe before retrying.",
            "outcome_unknown",
          );
          if (result.expected_head_sha !== undefined)
            invariant(
              result.expected_head_sha === expected,
              "Merge receipt refers to another head.",
              "integrity_error",
            );
          return result;
        },
      });
    }
    if (name === "pr.update-branch") {
      if (input.rebase) return yield* rebasePull(input, target, pr);
      const expected = sha(input.expectedHead);
      return yield* mutate({
        target,
        operation: "pr.rebase",
        invocation: input.invocation!,
        method: "PUT",
        path: `${path}/update-branch`,
        body: { expected_head_sha: expected },
        constraints: { pull_request_number: number, expected_head_sha: expected },
        locator: { kind: "pull-number", number, expectedHead: expected },
      });
    }
    if (name === "pr.comment" || name === "pr.review") {
      const body = (yield* inputBody(input)) ?? "";
      yield* attempt("pr_input", () =>
        invariant(
          name !== "pr.comment" || body.trim().length > 0,
          "A comment needs nonempty text.",
        ),
      );
      const review = name === "pr.review",
        operation = review ? "review.write" : "pr.comment";
      return yield* mutate({
        target,
        operation,
        invocation: input.invocation!,
        method: "POST",
        path: review ? `${path}/reviews` : `${root}/issues/${number}/comments`,
        body: review ? { event: input.event, body, commit_id: sha(input.expectedHead) } : { body },
        constraints: {
          pull_request_number: number,
          ...(review ? { review_action: String(input.event).toLowerCase() } : {}),
        },
        locator: {
          kind: review ? "review" : "comment",
          number,
          bodyDigest: fingerprint(body),
          ...(review ? { expectedHead: input.expectedHead, event: input.event } : {}),
        },
        validate: (r) => {
          const row = record(r.body);
          positive(row.id);
          return row;
        },
      });
    }
    const body = yield* inputBody(input);
    const patch =
      name === "pr.close"
        ? { state: "closed" }
        : name === "pr.reopen"
          ? { state: "open" }
          : {
              ...(input.title !== undefined ? { title: input.title } : {}),
              ...(body !== undefined ? { body } : {}),
              ...(input.base !== undefined ? { base: branch(input.base) } : {}),
            };
    yield* attempt("pr_input", () =>
      invariant(Object.keys(patch).length > 0, "No PR change was requested."),
    );
    return yield* mutate({
      target,
      operation: name,
      invocation: input.invocation!,
      method: "PATCH",
      path,
      body: patch,
      constraints: { pull_request_number: number },
      locator: {
        kind: "pull-patch",
        number,
        expectedHead: input.expectedHead,
        fieldDigests: Object.fromEntries(
          Object.entries(patch).map(([k, v]) => [k, fingerprint(v)]),
        ),
        patchDigest: fingerprint(patch),
      },
      validate: (r) => prFacts(r.body, number),
    });
  });
