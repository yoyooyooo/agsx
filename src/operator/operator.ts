import { Effect, Schema } from "effect";
import YAML from "yaml";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { attempt, invariant, positive, record, repoPath, slug } from "../domain/errors.js";
import type { Input } from "../domain/commands.js";
import {
  CredentialSchema,
  decode,
  normalizeEndpoint,
  validateCredential,
  type CredentialRef,
  type Target,
} from "../domain/model.js";
import {
  Settings,
  atomicPrivate,
  fingerprint,
  privateBytes,
  privateDirectory,
} from "../platform/store.js";
import { HttpTransport, expectStatus } from "../platform/http.js";
import { ProcessRunner } from "../platform/process.js";
import { readApi, mutate } from "../application/client.js";
import { resolveTarget } from "../application/routing.js";

const S = Schema.String,
  B = Schema.Boolean,
  O = Schema.optionalKey;
const ManifestSchema = Schema.Struct({
  schema: Schema.Literal("agsx.operator.v1"),
  context: S,
  repository: S,
  forgejo: Schema.Struct({
    endpoint: S,
    credential: CredentialSchema,
    allowHttp: O(B),
    repository: S,
  }),
  desired: Schema.Struct({
    branch: S,
    private: O(B),
    createIfMissing: O(B),
    protection: O(Schema.Record(S, Schema.Unknown)),
    labels: O(Schema.Array(Schema.Struct({ name: S, color: S, description: O(S) }))),
    webhook: O(Schema.Struct({ url: S, secret: CredentialSchema, events: Schema.Array(S) })),
  }),
  runtime: O(
    Schema.Struct({
      root: S,
      autoPr: O(B),
      mergeMethod: O(
        Schema.Literals(["merge", "rebase", "rebase-merge", "squash", "fast-forward-only"]),
      ),
      restart: O(Schema.Struct({ manager: Schema.Literals(["systemd", "launchd"]), service: S })),
    }),
  ),
  gitlab: O(
    Schema.Struct({
      endpoint: S,
      credential: CredentialSchema,
      allowHttp: O(B),
      project: S,
      defaultBranch: S,
    }),
  ),
});
interface Step {
  readonly key: string;
  readonly service: "forgejo" | "gitlab" | "runtime";
  readonly method: "POST" | "PATCH" | "PUT" | "LOCAL";
  readonly path: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly secret?: CredentialRef;
}
const PROTECTION_FIELDS = new Set([
  "enable_push",
  "enable_push_whitelist",
  "push_whitelist_usernames",
  "push_whitelist_teams",
  "enable_merge_whitelist",
  "merge_whitelist_usernames",
  "merge_whitelist_teams",
  "enable_force_push",
  "required_approvals",
  "enable_status_check",
  "status_check_contexts",
  "block_on_rejected_reviews",
  "block_on_outdated_branch",
  "block_on_official_review_requests",
  "dismiss_stale_approvals",
  "require_signed_commits",
  "apply_to_admins",
]);
const compare = (a: unknown, b: unknown) => fingerprint(a) === fingerprint(b);
const stepId = (id: string, key: string) => {
  const h = fingerprint({ id, key });
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
function secretRef(ref: CredentialRef, base: string): CredentialRef {
  return "file" in ref ? { file: isAbsolute(ref.file) ? ref.file : resolve(base, ref.file) } : ref;
}

export const observeOperator = (input: Input) =>
  Effect.gen(function* () {
    const settings = yield* Settings,
      http = yield* HttpTransport;
    const file = resolve(settings.options.cwd, String(input.manifest));
    const manifest = yield* attempt("operator_manifest", () => {
      const m = decode(
        ManifestSchema,
        JSON.parse(privateBytes(file, 256 * 1024).toString("utf8")),
        "Operator manifest",
      );
      slug(m.repository);
      slug(m.forgejo.repository);
      normalizeEndpoint(m.forgejo.endpoint, m.forgejo.allowHttp);
      validateCredential(m.forgejo.credential);
      if (m.desired.webhook) validateCredential(m.desired.webhook.secret);
      if (m.gitlab) validateCredential(m.gitlab.credential);
      invariant(
        /^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(m.desired.branch) && !m.desired.branch.includes(".."),
        "Invalid operator branch.",
      );
      for (const [k, v] of Object.entries(m.desired.protection ?? {})) {
        invariant(PROTECTION_FIELDS.has(k), "Unknown provider protection field.");
        if (k === "enable_force_push")
          invariant(v === false, "Operator recipes never enable force push.", "denied");
      }
      for (const label of m.desired.labels ?? [])
        invariant(
          /^[0-9a-fA-F]{6}$/.test(label.color) && label.name.length <= 100,
          "Invalid provider label.",
        );
      if (m.desired.webhook) {
        const url = new URL(m.desired.webhook.url);
        invariant(
          !url.username && !url.password && !url.search && !url.hash,
          "Webhook URL must be secret-free.",
        );
        invariant(["http:", "https:"].includes(url.protocol), "Webhook must use HTTP(S).");
      }
      if (m.gitlab) {
        normalizeEndpoint(m.gitlab.endpoint, m.gitlab.allowHttp);
        slug(m.gitlab.project);
      }
      return m;
    });
    const target = yield* resolveTarget({ context: manifest.context, repo: manifest.repository });
    yield* attempt("operator_identity", () =>
      invariant(
        target.identity !== "workload",
        "Machine/provider administration never consumes task credentials.",
        "denied",
      ),
    );
    const native = record(
      (yield* readApi(target, `/api/v3/repos/${repoPath(manifest.repository)}`)).response.body,
    );
    yield* attempt("operator_identity", () =>
      invariant(
        native.full_name === manifest.repository,
        "AGS repository identity changed.",
        "integrity_error",
      ),
    );
    const token = yield* settings.secret(secretRef(manifest.forgejo.credential, dirname(file)));
    const provider = normalizeEndpoint(manifest.forgejo.endpoint, manifest.forgejo.allowHttp);
    const get = (path: string) =>
      http.request({ endpoint: provider, path, method: "GET", credential: token });
    const path = `/api/v1/repos/${repoPath(manifest.forgejo.repository)}`;
    const remote = yield* get(path);
    yield* attempt("operator_provider", () => expectStatus(remote, [200, 404]));
    const steps: Step[] = [];
    let repo: Record<string, unknown> | null = remote.status === 200 ? record(remote.body) : null;
    let protection: unknown = null,
      hooks: unknown[] = [],
      labels: unknown[] = [],
      branchHead: unknown = null;
    if (!repo) {
      yield* attempt("operator_provider", () =>
        invariant(
          manifest.desired.createIfMissing,
          "Provider repository is absent and creation was not authorized by the manifest.",
          "conflict",
        ),
      );
      const me = yield* get("/api/v1/user");
      yield* attempt("operator_provider", () => expectStatus(me));
      const [owner, name] = manifest.forgejo.repository.split("/");
      steps.push({
        key: "forgejo.repository",
        service: "forgejo",
        method: "POST",
        path:
          record(me.body).login === owner
            ? "/api/v1/user/repos"
            : `/api/v1/orgs/${encodeURIComponent(owner!)}/repos`,
        body: {
          name,
          private: manifest.desired.private ?? true,
          default_branch: manifest.desired.branch,
          auto_init: false,
        },
      });
    } else {
      yield* attempt("operator_provider", () =>
        invariant(
          repo!.full_name === manifest.forgejo.repository,
          "Provider repository identity differs.",
          "integrity_error",
        ),
      );
      const patch: Record<string, unknown> = {};
      if (manifest.desired.private !== undefined && repo.private !== manifest.desired.private)
        patch.private = manifest.desired.private;
      if (repo.default_branch !== manifest.desired.branch)
        patch.default_branch = manifest.desired.branch;
      if (Object.keys(patch).length)
        steps.push({
          key: "forgejo.repository",
          service: "forgejo",
          method: "PATCH",
          path,
          body: patch,
        });
      const branch = yield* get(`${path}/branches/${encodeURIComponent(manifest.desired.branch)}`);
      yield* attempt("operator_provider", () => expectStatus(branch, [200, 404]));
      branchHead = branch.status === 200 ? record(record(branch.body).commit).id : null;
      const p = yield* get(
        `${path}/branch_protections/${encodeURIComponent(manifest.desired.branch)}`,
      );
      yield* attempt("operator_provider", () => expectStatus(p, [200, 404]));
      protection = p.status === 200 ? p.body : null;
      const h = yield* get(`${path}/hooks?limit=100`),
        l = yield* get(`${path}/labels?limit=100`);
      hooks = yield* attempt("operator_provider", () => {
        expectStatus(h);
        invariant(
          Array.isArray(h.body) && h.body.length < 100,
          "Hook observation is incomplete.",
          "conflict",
        );
        return h.body;
      });
      labels = yield* attempt("operator_provider", () => {
        expectStatus(l);
        invariant(
          Array.isArray(l.body) && l.body.length < 100,
          "Label observation is incomplete.",
          "conflict",
        );
        return l.body;
      });
    }
    if (manifest.desired.protection) {
      const existing = protection ? record(protection) : {};
      if (
        Object.entries(manifest.desired.protection).some(([k, v]) => !compare(existing[k], v)) ||
        !protection
      ) {
        // Send only explicit desired fields. Never invent a review/CI default.
        steps.push({
          key: "forgejo.protection",
          service: "forgejo",
          method: protection ? "PATCH" : "POST",
          path: protection
            ? `${path}/branch_protections/${encodeURIComponent(manifest.desired.branch)}`
            : `${path}/branch_protections`,
          body: {
            ...(protection ? {} : { branch_name: manifest.desired.branch }),
            ...manifest.desired.protection,
          },
        });
      }
    }
    if (manifest.desired.webhook) {
      const desired = manifest.desired.webhook;
      const matches = hooks
        .map((h) => record(h))
        .filter((h) => record(h.config ?? {}).url === desired.url);
      yield* attempt("operator_hooks", () =>
        invariant(matches.length <= 1, "Multiple hooks match the desired URL.", "conflict"),
      );
      const existing = matches[0];
      if (
        !existing ||
        existing.active !== true ||
        !compare([...((existing.events as string[]) ?? [])].sort(), [...desired.events].sort())
      )
        steps.push({
          key: "forgejo.webhook",
          service: "forgejo",
          method: existing ? "PATCH" : "POST",
          path: existing ? `${path}/hooks/${positive(existing.id)}` : `${path}/hooks`,
          body: {
            ...(existing ? {} : { type: "gitea" }),
            active: true,
            events: desired.events,
            config: { url: desired.url, content_type: "json" },
          },
          secret: secretRef(desired.secret, dirname(file)),
        });
    }
    for (const desired of manifest.desired.labels ?? []) {
      const matches = labels.map((x) => record(x)).filter((x) => x.name === desired.name);
      yield* attempt("operator_labels", () =>
        invariant(matches.length <= 1, "Provider has duplicate label names.", "conflict"),
      );
      const existing = matches[0];
      if (
        !existing ||
        String(existing.color).toLowerCase() !== desired.color.toLowerCase() ||
        String(existing.description ?? "") !== String(desired.description ?? "")
      )
        steps.push({
          key: `forgejo.label.${desired.name}`,
          service: "forgejo",
          method: existing ? "PATCH" : "POST",
          path: existing ? `${path}/labels/${positive(existing.id)}` : `${path}/labels`,
          body: { ...desired, color: desired.color.toLowerCase() },
        });
    }
    let runtime:
      | {
          path: string;
          hash: string;
          current: Record<string, unknown>;
          next: Record<string, unknown>;
        }
      | undefined;
    if (manifest.runtime) {
      runtime = yield* attempt("operator_runtime", () => {
        const root = resolve(manifest.runtime!.root);
        privateDirectory(root, false);
        const config = join(root, "config", "integrations.yaml");
        invariant(
          existsSync(config),
          "The explicit runtime has no canonical config/integrations.yaml.",
          "config_error",
        );
        const bytes = privateBytes(config),
          current = record(YAML.parse(bytes.toString("utf8")) ?? {}),
          next = structuredClone(current);
        const forgejo = record(next.forgejo ?? {}),
          repos = record(forgejo.repos ?? {}),
          old = record(repos[manifest.repository] ?? {});
        const [owner, name] = manifest.forgejo.repository.split("/");
        repos[manifest.repository] = {
          ...old,
          owner,
          repo: name,
          base_branch: manifest.desired.branch,
          auto_pr: manifest.runtime!.autoPr ?? true,
          ...(manifest.runtime!.mergeMethod
            ? { delegated_merge_method: manifest.runtime!.mergeMethod }
            : {}),
        };
        forgejo.repos = repos;
        next.forgejo = forgejo;
        if (manifest.gitlab) {
          const g = record(next.gitlab ?? {}),
            r = record(g.repos ?? {});
          r[manifest.repository] = {
            ...record(r[manifest.repository] ?? {}),
            project_path: manifest.gitlab.project,
            target_branch: manifest.gitlab.defaultBranch,
          };
          g.repos = r;
          next.gitlab = g;
        }
        return { path: config, hash: fingerprint(bytes.toString("utf8")), current, next };
      });
      if (!compare(runtime.current, runtime.next))
        steps.push({
          key: "runtime.mapping",
          service: "runtime",
          method: "LOCAL",
          path: runtime.path,
          body: { beforeHash: runtime.hash, afterHash: fingerprint(runtime.next) },
        });
    }
    let gitlabObservation: unknown = null;
    if (manifest.gitlab) {
      const g = manifest.gitlab,
        gt = yield* settings.secret(secretRef(g.credential, dirname(file)));
      const response = yield* http.request({
        endpoint: normalizeEndpoint(g.endpoint, g.allowHttp),
        path: `/api/v4/projects/${encodeURIComponent(g.project)}`,
        method: "GET",
        credential: gt,
      });
      yield* attempt("gitlab", () => expectStatus(response));
      const remote = record(response.body);
      yield* attempt("gitlab", () =>
        invariant(
          remote.path_with_namespace === g.project,
          "GitLab project identity differs.",
          "integrity_error",
        ),
      );
      gitlabObservation = {
        id: remote.id,
        path: remote.path_with_namespace,
        defaultBranch: remote.default_branch,
      };
      if (remote.default_branch !== g.defaultBranch)
        steps.push({
          key: "gitlab.default-branch",
          service: "gitlab",
          method: "PUT",
          path: `/api/v4/projects/${positive(remote.id)}`,
          body: { default_branch: g.defaultBranch },
        });
    }
    const observation = {
      ags: { id: native.id, fullName: native.full_name, defaultBranch: native.default_branch },
      forgejo: {
        id: repo?.id ?? null,
        fullName: repo?.full_name ?? null,
        private: repo?.private ?? null,
        defaultBranch: repo?.default_branch ?? null,
        branchHead,
        protection,
        hooks: hooks.map((h) => {
          const r = record(h);
          return { id: r.id, active: r.active, events: r.events, url: record(r.config ?? {}).url };
        }),
        labels: labels.map((l) => {
          const r = record(l);
          return { id: r.id, name: r.name, color: r.color, description: r.description };
        }),
      },
      gitlab: gitlabObservation,
      runtimeHash: runtime?.hash ?? null,
    };
    const safeSteps = steps.map(({ secret, ...s }) => ({
      ...s,
      ...(secret ? { secretReferenceConfigured: true } : {}),
    }));
    const plan = {
      schema: "agsx.operator-plan.v1",
      repository: manifest.repository,
      providerRepository: manifest.forgejo.repository,
      observation,
      steps: safeSteps,
      converged: steps.length === 0,
      atomicAcrossServices: false,
    };
    return {
      manifest,
      manifestFile: file,
      target,
      token,
      steps,
      runtime,
      plan,
      planHash: fingerprint({ manifest, plan }),
    };
  });

export const operatorCommand = (name: string, input: Input) =>
  Effect.gen(function* () {
    const observed = yield* observeOperator(input),
      settings = yield* Settings;
    if (name !== "ops.apply" || !input.apply)
      return {
        ...observed.plan,
        planHash: observed.planHash,
        planned: name !== "ops.verify",
        credentialsExposed: false,
      };
    yield* attempt("operator_plan", () =>
      invariant(
        input.expectedPlan === observed.planHash,
        "Observed state changed; inspect a fresh operator plan.",
        "conflict",
      ),
    );
    const applied: unknown[] = [];
    for (const step of observed.steps) {
      if (step.service === "runtime") {
        yield* attempt("operator_runtime", () => {
          const runtime = observed.runtime!;
          invariant(
            fingerprint(privateBytes(runtime.path).toString("utf8")) === runtime.hash,
            "Runtime configuration changed during provider convergence.",
            "conflict",
          );
          atomicPrivate(runtime.path, YAML.stringify(runtime.next));
        });
        applied.push({ step: step.key, changed: true });
        continue;
      }
      const m = observed.manifest,
        endpoint = step.service === "forgejo" ? m.forgejo.endpoint : m.gitlab!.endpoint;
      const token =
        step.service === "forgejo"
          ? observed.token
          : yield* settings.secret(secretRef(m.gitlab!.credential, dirname(observed.manifestFile)));
      let body: Record<string, unknown> = { ...step.body };
      if (step.secret) {
        const secret = yield* settings.secret(step.secret);
        body = { ...body, config: { ...record(body.config), secret } };
      }
      const target: Target = {
        contextName: `operator-${observed.target.contextName}-${step.service}`,
        context: {
          endpoint: normalizeEndpoint(endpoint, true),
          instanceId: `operator-${step.service}`,
          allowHttp: true,
        },
        identity: "service",
        repository: step.service === "forgejo" ? m.forgejo.repository : m.gitlab!.project,
      };
      const result = yield* mutate({
        target,
        operation: `ops.${step.key}`,
        invocation: stepId(input.invocation!, step.key),
        method: step.method as "POST" | "PATCH" | "PUT",
        path: step.path,
        body,
        bearer: token,
        locator: { kind: "operator-step", planHash: observed.planHash, step: step.key },
        validate: (r) => {
          expectStatus(r, [200, 201, 204]);
          return { changed: true, status: r.status };
        },
      });
      applied.push({ step: step.key, ...result });
    }
    if (observed.steps.some((s) => s.service === "runtime") && observed.manifest.runtime?.restart) {
      const r = observed.manifest.runtime.restart,
        runner = yield* ProcessRunner;
      yield* attempt("operator_restart", () =>
        invariant(
          /^[A-Za-z0-9_.@/-]+$/.test(r.service) && !r.service.startsWith("-"),
          "Invalid service identifier.",
        ),
      );
      const execution = yield* runner.run({
        command: r.manager === "systemd" ? "systemctl" : "launchctl",
        args: r.manager === "systemd" ? ["restart", r.service] : ["kickstart", "-k", r.service],
        cwd: observed.manifest.runtime.root,
        timeoutMs: 90_000,
      });
      yield* attempt("operator_restart", () =>
        invariant(
          execution.exitCode === 0,
          "Service manager did not confirm restart; inspect the partial operator result.",
          "unavailable",
        ),
      );
      applied.push({ step: "runtime.restart", exitCode: 0 });
    }
    return {
      applied,
      planHash: observed.planHash,
      serverProjectionAccepted: false,
      nextCommand: "ops.verify",
      note: "Provider/local changes are not one atomic transaction. No provider error was hidden and no unknown write was replayed.",
    };
  });
