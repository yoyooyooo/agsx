import { Effect } from "effect";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { attempt, invariant, positive, record, text } from "../domain/errors.js";
import type { Target } from "../domain/model.js";
import { HttpTransport, expectStatus, type HttpRequest } from "../platform/http.js";
import {
  Settings,
  atomicPrivate,
  fingerprint,
  privateBytes,
  privateDirectory,
} from "../platform/store.js";

export interface Credential {
  readonly bearer: string;
  readonly kind: "human" | "service" | "workload";
  readonly principal: { readonly id: number; readonly login: string; readonly kind: string };
  readonly session?: {
    readonly id: string;
    readonly grantId: string;
    readonly source: Readonly<Record<string, unknown>>;
  };
}
export interface GrantMaterial {
  readonly token: string;
  readonly grant: Record<string, unknown>;
  readonly cacheFile: string;
  readonly reused: boolean;
}
export const connection = (target: Target): Pick<HttpRequest, "endpoint" | "caFile" | "proxy"> => ({
  endpoint: target.context.endpoint,
  ...(target.context.caFile
    ? { caFile: resolve(target.home ?? process.cwd(), target.context.caFile) }
    : {}),
  ...(target.context.proxy ? { proxy: target.context.proxy } : {}),
});
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function validateGrant(
  value: unknown,
  target: Target,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, unknown> {
  const g = record(value, "grant"),
    repo = record(g.repository, "grant repository"),
    source = record(g.source, "grant source");
  invariant(
    g.schema === "ags.access-grant.v1" && typeof g.id === "string" && UUID.test(g.id),
    "Invalid grant identity.",
    "integrity_error",
  );
  invariant(
    repo.full_name === target.repository && repo.target === target.context.instanceId,
    "Grant belongs to a different AGS repository/instance.",
    "denied",
  );
  positive(repo.id);
  positive(record(g.actor).id);
  positive(record(g.executor).id);
  invariant(
    g.state === "active" &&
      typeof g.expires_at === "string" &&
      Number.isFinite(Date.parse(g.expires_at)) &&
      Date.parse(g.expires_at) > Date.now(),
    "The grant is no longer active.",
    "denied",
  );
  invariant(
    target.context.workload?.workspaces.includes(String(source.workspace_id)),
    "Grant workspace is not trusted by this Context.",
    "denied",
  );
  invariant(
    source.instance_id === target.context.workload?.issuerInstanceId,
    "Grant issuer instance differs from the configured workload trust.",
    "denied",
  );
  for (const [field, key] of [
    ["workspace_id", "MULTICA_WORKSPACE_ID"],
    ["agent_id", "MULTICA_AGENT_ID"],
    ["task_id", "MULTICA_TASK_ID"],
  ]) {
    if (env[key!])
      invariant(
        source[field!] === env[key!],
        "Grant source coordinates do not match this workload.",
        "denied",
      );
  }
  invariant(
    Array.isArray(g.effective_operations) &&
      g.effective_operations.every((x) => typeof x === "string"),
    "Grant operations are malformed.",
    "integrity_error",
  );
  invariant(
    typeof g.authority_revision === "string" && /^sha256:[a-f0-9]{64}$/.test(g.authority_revision),
    "Grant authority revision is malformed.",
    "integrity_error",
  );
  return g;
}
export const authenticateNative = (target: Target) =>
  Effect.gen(function* () {
    const settings = yield* Settings,
      http = yield* HttpTransport;
    yield* attempt("identity", () =>
      invariant(
        target.identity !== "workload" && target.context.auth,
        "This operation needs an explicitly configured native identity.",
        "config_error",
      ),
    );
    const bearer = yield* settings.secret(target.context.auth!.credential);
    const response = yield* http.request({
      ...connection(target),
      path: "/api/v3/user",
      method: "GET",
      credential: bearer,
    });
    const user = yield* attempt("identity", () => record(expectStatus(response).body, "AGS user"));
    const principal = yield* attempt("identity", () => {
      const kind = text(user.user_kind, "user kind");
      invariant(
        target.identity === "human"
          ? kind === "human"
          : ["agent", "service", "automation", "durable_agent", "temporary_agent"].includes(kind),
        "Selected credential kind does not match the AGS identity.",
        "denied",
      );
      return { id: positive(user.id), login: text(user.login), kind };
    });
    return { bearer, kind: target.identity as "human" | "service", principal } satisfies Credential;
  });

/** Workload exchange is optional and only visits the chosen AGS. Never contact
 * Multica directly or use a Human/provider token as an exchange fallback. */
export const obtainGrant = (
  target: Target,
  action: "ensure" | "issue" | "renew" | "observe" = "ensure",
) =>
  Effect.gen(function* () {
    const settings = yield* Settings,
      http = yield* HttpTransport;
    const env = settings.options.env;
    const locator = yield* attempt("workload", () => {
      invariant(
        target.identity === "workload" && target.context.workload && target.repository,
        "An explicit workload Context and repository are required.",
        "config_error",
      );
      const sourceToken = env.MULTICA_TOKEN ?? env.MULTICA_TASK_TOKEN ?? "";
      invariant(
        /^mat_[A-Za-z0-9_.-]{16,}$/.test(sourceToken),
        "A valid task-scoped source credential is required.",
        "unauthenticated",
      );
      const configuredEndpoint = target.context.workload.endpoint;
      invariant(
        !env.MULTICA_SERVER_URL ||
          env.MULTICA_SERVER_URL.replace(/\/$/, "") === configuredEndpoint.replace(/\/$/, ""),
        "Runtime endpoint contradicts configured workload trust.",
        "denied",
      );
      if (env.MULTICA_WORKSPACE_ID)
        invariant(
          target.context.workload.workspaces.includes(env.MULTICA_WORKSPACE_ID),
          "Workload workspace is outside the Context allowlist.",
          "denied",
        );
      const coordinates = Object.fromEntries(
        [
          ["workspace_id", env.MULTICA_WORKSPACE_ID],
          ["agent_id", env.MULTICA_AGENT_ID],
          ["task_id", env.MULTICA_TASK_ID],
        ].filter(([, v]) => Boolean(v)),
      );
      const role = env.AGSX_ACCESS_ROLE;
      invariant(
        !role || ["maintainer", "admin"].includes(role),
        "Invalid explicit workload access role.",
      );
      return { sourceToken, coordinates, endpoint: configuredEndpoint, role };
    });
    const dir = join(settings.options.home, "workloads");
    const key = fingerprint({
      endpoint: target.context.endpoint,
      instance: target.context.instanceId,
      repository: target.repository,
      trust: target.context.workload,
      locator: locator.coordinates,
      role: locator.role,
      sourceTokenHash: fingerprint(locator.sourceToken),
    });
    const cacheFile = join(dir, `${key}.json`);
    const cached = yield* attempt("grant_cache", () => {
      if (
        !privateDirectory(settings.options.home, false) ||
        !privateDirectory(dir, false) ||
        !existsSync(cacheFile)
      )
        return undefined;
      const cache = record(JSON.parse(privateBytes(cacheFile, 64 * 1024).toString("utf8")));
      invariant(
        cache.schema === "agsx.workload-cache.v1" &&
          cache.key === key &&
          typeof cache.token === "string" &&
          /^ags_grant_[A-Za-z0-9_-]{32,240}$/.test(cache.token),
        "Invalid workload cache.",
        "integrity_error",
      );
      return cache;
    });
    yield* attempt("grant_observe", () =>
      invariant(
        action !== "observe" || cached,
        "No exact grant is cached; use grant.issue explicitly before observing it.",
        "config_error",
      ),
    );
    if (cached && (action === "ensure" || action === "observe")) {
      const response = yield* http.request({
        ...connection(target),
        path: "/api/v3/access-grants/current",
        method: "GET",
        credential: String(cached.token),
      });
      const grant = yield* attempt("grant_current", () =>
        validateGrant(expectStatus(response).body, target, env),
      );
      return {
        token: String(cached.token),
        grant,
        cacheFile,
        reused: true,
      } satisfies GrantMaterial;
    }
    yield* attempt("grant_renew", () =>
      invariant(
        action !== "renew" || cached,
        "Renew requires an existing exact workload grant.",
        "config_error",
      ),
    );
    const response = yield* http.request({
      ...connection(target),
      method: "POST",
      path: action === "renew" ? "/api/v3/access-grants/renew" : "/api/v3/access-grants",
      ...(action === "renew" ? { credential: String(cached!.token) } : {}),
      body: {
        runtime_endpoint_hint: locator.endpoint,
        locator: locator.coordinates,
        source_token: locator.sourceToken,
        ...(action !== "renew"
          ? {
              repository: target.repository,
              ...(locator.role ? { access_role: locator.role } : {}),
            }
          : {}),
      },
    });
    const issued = yield* attempt("grant_issue", () => {
      const body = record(expectStatus(response, [200, 201]).body);
      invariant(
        body.schema === "ags.access-grant.issue.v1" &&
          typeof body.grant_token === "string" &&
          /^ags_grant_[A-Za-z0-9_-]{32,240}$/.test(body.grant_token),
        "Invalid grant exchange response.",
        "integrity_error",
      );
      return { token: body.grant_token, grant: validateGrant(body.grant, target, env) };
    });
    yield* attempt("grant_cache", () => {
      privateDirectory(settings.options.home, true);
      privateDirectory(dir, true);
      // Only expired, owned records are garbage-collected. Unknown cache contents fail closed.
      const names = readdirSync(dir).filter((x) => /^[a-f0-9]{64}\.json$/.test(x));
      for (const name of names) {
        const p = join(dir, name),
          row = record(JSON.parse(privateBytes(p, 64 * 1024).toString("utf8")));
        if (
          row.schema === "agsx.workload-cache.v1" &&
          typeof record(row.grant).expires_at === "string" &&
          Date.parse(String(record(row.grant).expires_at)) < Date.now()
        )
          unlinkSync(p);
      }
      invariant(
        existsSync(cacheFile) || readdirSync(dir).filter((x) => x.endsWith(".json")).length < 32,
        "Workload cache capacity reached; revoke unused grants.",
        "conflict",
      );
      atomicPrivate(cacheFile, {
        schema: "agsx.workload-cache.v1",
        key,
        token: issued.token,
        grant: issued.grant,
      });
    });
    return { ...issued, cacheFile, reused: false } satisfies GrantMaterial;
  });

export const authenticate = (
  target: Target,
  operation: string,
  constraints: Readonly<Record<string, unknown>> = {},
) =>
  Effect.gen(function* () {
    if (target.identity !== "workload") return yield* authenticateNative(target);
    const http = yield* HttpTransport;
    const material = yield* obtainGrant(target);
    yield* attempt("workload_scope", () =>
      invariant(
        operation !== "pr.merge",
        "Workload merges require the exact effect endpoint, not a transport session.",
        "denied",
      ),
    );
    const wireConstraints = yield* attempt("transport_constraints", () =>
      Object.fromEntries(
        Object.entries(constraints).map(([key, value]) => {
          invariant(
            /^[a-z_]+$/.test(key) && ["string", "number", "boolean"].includes(typeof value),
            "Transport constraints must be named scalar values.",
          );
          return [key, String(value)];
        }),
      ),
    );
    const response = yield* http.request({
      ...connection(target),
      method: "POST",
      path: "/api/v3/access-grants/transport-sessions",
      credential: material.token,
      body: { operation, constraints: wireConstraints },
    });
    return yield* attempt("transport_session", () => {
      const b = record(expectStatus(response, [200, 201]).body),
        session = record(b.session),
        inv = record(b.invocation);
      invariant(
        b.schema === "ags.access-grant-transport-session.v1" &&
          typeof b.session_token === "string" &&
          /^ags_sess_[A-Za-z0-9_-]{32,240}$/.test(b.session_token),
        "Invalid transport session response.",
        "integrity_error",
      );
      invariant(
        inv.grant_id === material.grant.id &&
          inv.repository === target.repository &&
          inv.operation === operation &&
          inv.authorization_outcome === "allowed" &&
          inv.provider_attempt === "not_attempted" &&
          inv.provider_outcome === "not_applicable",
        "Session invocation is not bound to the requested operation.",
        "denied",
      );
      invariant(
        inv.actor_user_id === record(material.grant.actor).id &&
          inv.executor_user_id === record(material.grant.executor).id,
        "Session principal does not match its grant.",
        "denied",
      );
      for (const [k, v] of Object.entries(wireConstraints))
        invariant(
          String(record(inv.constraints ?? {})[k]) === v,
          "Session constraints differ from the request.",
          "denied",
        );
      invariant(
        typeof session.id === "string" && UUID.test(session.id),
        "Invalid session identity.",
        "integrity_error",
      );
      invariant(
        session.contract_revision === "2026-07-24.team-authority-v4" &&
          session.credential_mode === "access_grant_transport" &&
          !Object.hasOwn(session, "merge_delegation"),
        "Unsupported or legacy transport session contract.",
        "integrity_error",
      );
      invariant(
        session.state === "active" &&
          typeof session.expires_at === "string" &&
          Date.parse(session.expires_at) > Date.now(),
        "Transport session is expired or revoked.",
        "denied",
      );
      const scope = record(session.target),
        resource = record(session.resource),
        op = record(session.operation),
        basis = record(session.authorization_basis),
        source = record(material.grant.source),
        workload = record(session.workload_context);
      invariant(
        scope.instance === target.context.instanceId &&
          scope.repository === target.repository &&
          resource.service === "ags" &&
          resource.repository === target.repository &&
          op.name === operation,
        "Transport session has a different target or operation.",
        "denied",
      );
      invariant(
        fingerprint(record(op.constraints ?? {})) === fingerprint(wireConstraints),
        "Transport session constraints are not exact.",
        "denied",
      );
      invariant(
        basis.trust_revision === material.grant.authority_revision &&
          basis.requested_operation_scope === `${operation}:${target.repository}` &&
          workload.correlation_id === material.grant.id &&
          workload.issuer_instance_id === source.instance_id,
        "Transport authority is not bound to its parent grant.",
        "denied",
      );
      for (const key of ["workspace_id", "agent_id", "task_id", "run_id", "issue_id", "runtime_id"])
        invariant(
          workload[key] === source[key],
          "Transport workload provenance differs from its parent grant.",
          "denied",
        );
      const principal = record(session.principal),
        executor = record(material.grant.executor);
      invariant(
        principal.id === executor.id && principal.login === executor.login,
        "Transport session principal differs from the exact grant executor.",
        "denied",
      );
      return {
        bearer: b.session_token,
        kind: "workload" as const,
        principal: { id: positive(principal.id), login: text(principal.login), kind: "workload" },
        session: {
          id: session.id,
          grantId: String(material.grant.id),
          source: record(material.grant.source),
        },
      } satisfies Credential;
    });
  });

export const revokeGrant = (target: Target) =>
  Effect.gen(function* () {
    const material = yield* obtainGrant(target),
      http = yield* HttpTransport;
    const response = yield* http.request({
      ...connection(target),
      path: "/api/v3/access-grants/revoke",
      method: "POST",
      credential: material.token,
      body: { reason: "client_request" },
    });
    yield* attempt("grant_revoke", () => expectStatus(response, [200, 204]));
    yield* attempt("grant_cache", () => {
      privateBytes(material.cacheFile, 64 * 1024);
      unlinkSync(material.cacheFile);
    });
    return { id: material.grant.id, state: "revoked" };
  });
export function publicCredential(c: Credential) {
  return {
    kind: c.kind,
    principal: c.principal,
    ...(c.session ? { sessionId: c.session.id, grantId: c.session.grantId } : {}),
  };
}
