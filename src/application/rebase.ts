import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attempt, branch, invariant, record, repoPath, sha, slug } from "../domain/errors.js";
import type { Input } from "../domain/commands.js";
import type { Target } from "../domain/model.js";
import { ProcessRunner } from "../platform/process.js";
import { Settings } from "../platform/store.js";
import { gitCommand } from "./git.js";
import { readApi } from "./client.js";

/** Rebase does not use the legacy GraphQL mutation that ignores expectedHead.
 * Git's exact force-with-lease provides the atomic ref precondition; the AGS
 * receive-pack endpoint still owns permission/protected-branch enforcement.
 */
export const rebasePull = (input: Input, target: Target, pr: Record<string, unknown>) =>
  Effect.gen(function* () {
    const settings = yield* Settings,
      runner = yield* ProcessRunner;
    const head = record(pr.head),
      base = record(pr.base);
    const headBranch = yield* attempt("rebase", () => branch(head.ref));
    const baseBranch = yield* attempt("rebase", () => branch(base.ref));
    const expected = yield* attempt("rebase", () => sha(input.expectedHead));
    const headRepo = yield* attempt("rebase", () =>
      slug(record(head.repo ?? { full_name: target.repository }).full_name),
    );
    const baseRepo = yield* attempt("rebase", () =>
      slug(record(base.repo ?? { full_name: target.repository }).full_name),
    );
    // PR snapshots can retain the base SHA observed at creation. Rebase must use
    // a fresh native branch observation, never that stale historical field.
    const observedBase = (yield* readApi(
      { ...target, repository: baseRepo },
      `/api/v3/repos/${repoPath(baseRepo)}/branches/${encodeURIComponent(baseBranch)}`,
    )).response.body;
    const baseSha = yield* attempt("rebase_base", () =>
      sha(record(record(observedBase).commit).sha ?? record(record(observedBase).commit).id),
    );
    const temp = yield* Effect.acquireRelease(
      attempt("rebase_fixture", () => mkdtempSync(join(tmpdir(), "agsx-rebase-"))),
      (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
    );
    const work = join(temp, "repository"),
      url = `${target.context.endpoint}/${repoPath(headRepo)}.git`;
    const clone = yield* gitCommand({
      ...input,
      repo: headRepo,
      args: ["clone", url, work, "--no-checkout", "--no-tags"],
      apply: true,
    });
    yield* attempt("rebase_clone", () =>
      invariant(
        (clone as { exitCode?: number }).exitCode === 0,
        "Could not materialize the exact PR repository.",
        "unavailable",
      ),
    );
    const local = (args: readonly string[]) =>
      runner.run({
        command: "git",
        args,
        cwd: work,
        env: {
          GIT_COMMITTER_NAME: "AGS CLI",
          GIT_COMMITTER_EMAIL: "ags-cli@users.noreply.invalid",
          GIT_EDITOR: "true",
          GIT_SEQUENCE_EDITOR: "true",
        },
        timeoutMs: 120000,
      });
    const actual = yield* local(["rev-parse", `refs/remotes/origin/${headBranch}`]);
    yield* attempt("rebase_head", () =>
      invariant(
        actual.exitCode === 0 && actual.stdout.trim() === expected,
        "Remote PR head changed before rebase.",
        "conflict",
      ),
    );
    let baseObject = yield* local(["cat-file", "-e", `${baseSha}^{commit}`]);
    if (baseObject.exitCode !== 0) {
      const source = join(temp, "base"),
        baseUrl = `${target.context.endpoint}/${repoPath(baseRepo)}.git`;
      const baseClone = yield* gitCommand({
        ...input,
        repo: baseRepo,
        args: ["clone", baseUrl, source, "--no-checkout", "--no-tags"],
        apply: true,
      });
      yield* attempt("rebase_base", () =>
        invariant(
          (baseClone as { exitCode?: number }).exitCode === 0,
          "Could not fetch the explicit PR base repository.",
          "unavailable",
        ),
      );
      const copied = yield* local(["fetch", "--no-tags", source, baseSha]);
      yield* attempt("rebase_base", () =>
        invariant(
          copied.exitCode === 0,
          "The exact observed base commit was not fetched.",
          "conflict",
        ),
      );
      baseObject = yield* local(["cat-file", "-e", `${baseSha}^{commit}`]);
    }
    yield* attempt("rebase_base", () =>
      invariant(baseObject.exitCode === 0, "Missing exact base commit.", "conflict"),
    );
    const checkout = yield* local(["checkout", "--detach", expected]);
    yield* attempt("rebase_checkout", () =>
      invariant(
        checkout.exitCode === 0,
        "Could not check out the exact original head.",
        "unavailable",
      ),
    );
    const rebased = yield* local(["rebase", baseSha]);
    yield* attempt("rebase", () =>
      invariant(
        rebased.exitCode === 0,
        "Rebase conflicted; temporary work was discarded and no push was attempted.",
        "conflict",
      ),
    );
    const headResult = yield* local(["rev-parse", "HEAD"]),
      newHead = yield* attempt("rebase_head", () => sha(headResult.stdout.trim()));
    if (newHead === expected)
      return { changed: false, head: newHead, base: baseSha, providerProjection: "unchanged" };
    const pushed = yield* gitCommand({
      ...input,
      repo: headRepo,
      args: [
        "push",
        "origin",
        `--force-with-lease=refs/heads/${headBranch}:${expected}`,
        `HEAD:refs/heads/${headBranch}`,
      ],
      apply: true,
    }).pipe(
      Effect.provideService(Settings, { ...settings, options: { ...settings.options, cwd: work } }),
    );
    yield* attempt("rebase_push", () =>
      invariant(
        (pushed as { exitCode?: number }).exitCode === 0,
        "Rebase push outcome is not confirmed; inspect its invocation, do not retry.",
        "outcome_unknown",
      ),
    );
    return {
      changed: true,
      previousHead: expected,
      head: newHead,
      base: baseSha,
      atomicRefPrecondition: "force-with-lease",
      invocation: input.invocation,
      providerProjection: "separate_observation",
      serverPermissionsBypassed: false,
    };
  });
