import { Effect } from "effect";
import {
  attempt,
  branch,
  invariant,
  positive,
  record,
  repoPath,
  sha,
  slug,
  text,
} from "../domain/errors.js";
import type { Input } from "../domain/commands.js";
import type { Target } from "../domain/model.js";
import { HttpTransport, expectStatus } from "../platform/http.js";
import { authenticate, authenticateNative, connection } from "./identity.js";
import { mutate, paginate, readApi } from "./client.js";

export const repositoryCommand = (name: string, input: Input, target: Target) =>
  Effect.gen(function* () {
    const root = target.repository ? `/api/v3/repos/${repoPath(target.repository)}` : "";
    if (name === "repo.list") {
      const owner =
        input.owner === undefined
          ? undefined
          : yield* attempt("repository", () => text(input.owner));
      const path = owner
        ? `/api/v3/users/${encodeURIComponent(owner)}/repos`
        : "/api/v3/user/repos";
      return yield* paginate(
        target,
        path,
        input as { limit?: number; page?: number; all?: boolean },
      );
    }
    if (name === "repo.view") return (yield* readApi(target, root)).response.body;
    if (name === "repo.refs") {
      const kind = String(input.kind ?? "heads");
      if (input.ref !== undefined) {
        const ref = yield* attempt("reference", () => branch(input.ref));
        return (yield* readApi(target, `${root}/git/ref/${kind}/${encodeURIComponent(ref)}`))
          .response.body;
      }
      return yield* paginate(
        target,
        `${root}/${kind === "tags" ? "tags" : "branches"}`,
        input as { limit?: number; page?: number; all?: boolean },
      );
    }
    if (name === "repo.verify") {
      const native = (yield* readApi(target, root)).response;
      const rep = yield* attempt("repository", () => record(native.body));
      yield* attempt("repository", () =>
        invariant(
          rep.full_name === target.repository,
          "Repository readback identity differs.",
          "integrity_error",
        ),
      );
      const ref = yield* attempt("reference", () => branch(input.branch ?? rep.default_branch));
      const head = (yield* readApi(target, `${root}/branches/${encodeURIComponent(ref)}`)).response
        .body;
      const snapshot = yield* attempt("reference", () => record(record(head).commit));
      const headSha = yield* attempt("reference", () => sha(snapshot.sha ?? snapshot.id));
      const http = yield* HttpTransport,
        auth = yield* authenticate(target, "repo.read");
      const projection = yield* http.request({
        ...connection(target),
        path: `${root}/projection/status`,
        method: "GET",
        credential: auth.bearer,
      });
      return {
        repository: rep,
        branch: ref,
        head: headSha,
        projection: {
          status:
            projection.status === 404
              ? "not_exposed"
              : projection.status === 200
                ? "observed"
                : "unavailable",
          httpStatus: projection.status,
          ...(projection.status === 200 ? { facts: projection.body } : {}),
        },
        claim: "Native identity/ref readback; provider policy is not reimplemented by the client.",
      };
    }
    // Creation remains a native AGS operation. A configured provider may be pending,
    // but absence of a particular provider is not a fabricated creation failure.
    yield* attempt("repository", () =>
      invariant(name === "repo.create", "Unknown repository operation."),
    );
    const auth = yield* authenticateNative(target),
      http = yield* HttpTransport;
    const repository = yield* attempt("repository", () => slug(target.repository)),
      [owner, shortName] = repository.split("/");
    const before = yield* http.request({
      ...connection(target),
      path: root,
      method: "GET",
      credential: auth.bearer,
    });
    if (before.status === 200) {
      yield* attempt("repository", () =>
        invariant(
          record(before.body).full_name === repository,
          "Existing repository identity differs.",
          "integrity_error",
        ),
      );
      return {
        created: false,
        existing: true,
        repository: before.body,
        invocation: input.invocation,
      };
    }
    yield* attempt("repository_preflight", () => expectStatus(before, [404]));
    const ref = yield* attempt("repository", () => branch(input.defaultBranch ?? "main"));
    const body = {
      name: shortName,
      description: input.description ?? "",
      private: (input.visibility ?? "private") === "private",
      visibility: input.visibility ?? "private",
      default_branch: ref,
      auto_init: input.readme ?? true,
    };
    return yield* mutate({
      target,
      operation: "repo.create",
      invocation: input.invocation!,
      method: "POST",
      path:
        owner === auth.principal.login
          ? "/api/v3/user/repos"
          : `/api/v3/orgs/${encodeURIComponent(owner!)}/repos`,
      body,
      credential: auth,
      locator: { kind: "repository", repository, defaultBranch: ref },
      validate: (r) => {
        const row = record(r.body);
        positive(row.id);
        invariant(
          row.full_name === repository,
          "Created repository identity differs.",
          "integrity_error",
        );
        return {
          created: true,
          repository: row,
          projection: { status: "separate_observation", command: "repo.verify" },
        };
      },
    });
  });
