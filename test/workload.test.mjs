import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fixture, configure, call, server, send, HEAD, BASE } from "./helpers.mjs";
const GRANT = "ags_grant_" + "g".repeat(40),
  SESSION = "ags_sess_" + "s".repeat(40),
  TASK = "mat_" + "t".repeat(40);
async function workload(t) {
  const f = fixture(t),
    state = {
      grantId: randomUUID(),
      revoked: false,
      wrongRepo: false,
      wrongScope: false,
      effects: 0,
      issues: 0,
    };
  const grant = () => ({
    schema: "ags.access-grant.v1",
    id: state.grantId,
    actor: { id: 7, login: "worker", user_kind: "agent" },
    executor: { id: 8, login: "executor", user_kind: "agent" },
    source: {
      instance_id: "issuer",
      workspace_id: "workspace",
      agent_id: "agent",
      task_id: "task",
      run_id: "run",
      context_digest: "sha256:" + "a".repeat(64),
    },
    repository: {
      id: 2,
      full_name: state.wrongRepo ? "other/project" : "team/project",
      target: "fixture",
    },
    effective_operations: [
      "repo.read",
      "pr.read",
      "pr.comment",
      "git.read",
      "git.push",
      "pr.merge",
    ],
    authority_revision: "sha256:" + "b".repeat(64),
    state: state.revoked ? "revoked" : "active",
    expires_at: new Date(Date.now() + 600000).toISOString(),
  });
  const pr = {
    id: 1,
    number: 1,
    title: "Workload",
    state: "open",
    head: { sha: HEAD, ref: "feature" },
    base: { sha: BASE, ref: "main" },
    external_projections: [
      { provider: "forgejo", external_repo: "team/project", external_number: 77 },
    ],
  };
  const s = await server(t, (r, res) => {
    if (r.path === "/api/v3/access-grants" && r.method === "POST") {
      assert.equal(r.body.source_token, TASK);
      assert.equal(r.body.runtime_endpoint_hint, "https://workload.example.test");
      assert.equal(r.body.repository, "team/project");
      state.issues++;
      return send(res, 201, {
        schema: "ags.access-grant.issue.v1",
        grant_token: GRANT,
        grant: grant(),
      });
    }
    if (
      r.path.startsWith("/api/v3/access-grants/") &&
      r.headers.authorization !== `Bearer ${GRANT}`
    )
      return send(res, 401, {});
    if (r.path === "/api/v3/access-grants/current")
      return state.revoked ? send(res, 401, {}) : send(res, 200, grant());
    if (r.path === "/api/v3/access-grants/renew")
      return send(res, 201, {
        schema: "ags.access-grant.issue.v1",
        grant_token: GRANT,
        grant: grant(),
      });
    if (r.path === "/api/v3/access-grants/revoke") {
      state.revoked = true;
      return send(res, 200, { revoked: true });
    }
    if (r.path === "/api/v3/access-grants/transport-sessions")
      return send(res, 201, {
        schema: "ags.access-grant-transport-session.v1",
        session_token: SESSION,
        session: {
          id: "22222222-2222-4222-8222-222222222222",
          contract_revision: "2026-07-24.team-authority-v4",
          credential_mode: "access_grant_transport",
          principal: { id: 8, login: "executor", user_kind: "agent" },
          target: { instance: "fixture", repository: "team/project" },
          resource: { service: "ags", repository: "team/project" },
          operation: {
            name: r.body.operation,
            ...(Object.keys(r.body.constraints).length ? { constraints: r.body.constraints } : {}),
          },
          authorization_basis: {
            trust_revision: grant().authority_revision,
            requested_operation_scope: r.body.operation + ":team/project",
          },
          workload_context: {
            correlation_id: state.grantId,
            issuer_instance_id: "issuer",
            workspace_id: "workspace",
            agent_id: "agent",
            task_id: "task",
            run_id: "run",
          },
          state: "active",
          expires_at: new Date(Date.now() + 60000).toISOString(),
        },
        invocation: {
          id: randomUUID(),
          grant_id: state.grantId,
          repository: "team/project",
          operation: state.wrongScope ? "pr.merge" : r.body.operation,
          constraints: r.body.constraints,
          actor_user_id: 7,
          executor_user_id: 8,
          authorization_outcome: "allowed",
          provider_attempt: "not_attempted",
          provider_outcome: "not_applicable",
        },
      });
    if (r.path === "/api/v3/access-grants/effects/pr.merge") {
      state.effects++;
      return send(res, 200, {
        schema: "ags.access-grant-invocation.v1",
        id: r.body.invocation_id,
        grant_id: state.grantId,
        repository: "team/project",
        operation: "pr.merge",
        expected_head_sha: r.body.expected_head_sha,
        authorization_outcome: "allowed",
        provider_outcome: "confirmed",
        provider_merged: true,
      });
    }
    if (r.headers.authorization !== `Bearer ${SESSION}`) return send(res, 401, {});
    if (r.path === "/api/v3/repos/team/project/pulls") return send(res, 200, [pr]);
    if (r.path === "/api/v3/repos/team/project/pulls/1") return send(res, 200, pr);
    return send(res, 404, {});
  });
  configure(f, s.endpoint, {
    auth: undefined,
    workload: {
      adapter: "multica",
      endpoint: "https://workload.example.test",
      issuerInstanceId: "issuer",
      workspaces: ["workspace"],
    },
  });
  f.env = {
    ...f.env,
    MULTICA_TOKEN: TASK,
    MULTICA_SERVER_URL: "https://workload.example.test",
    MULTICA_WORKSPACE_ID: "workspace",
    MULTICA_AGENT_ID: "agent",
    MULTICA_TASK_ID: "task",
  };
  return { ...f, ...s, state };
}
test("explicit workload grant lifecycle and request-scoped transport do not read Human credentials", async (t) => {
  const f = await workload(t);
  // The unused legacy-like token can be unreadable/unsafe without affecting the task.
  writeFileSync(join(f.home, "token"), "not a task credential", { mode: 0o644 });
  const issued = await call(f, "grant.issue", { repo: "team/project", apply: true });
  assert.equal(issued.result.data.grant.repository.full_name, "team/project");
  assert.equal(JSON.stringify(issued).includes(GRANT), false);
  assert.equal((await call(f, "grant.status", { repo: "team/project" })).result.data.reused, true);
  const pulls = await call(f, "pr.list", { repo: "team/project" });
  assert.equal(pulls.result.data.items[0].number, 1);
  await call(f, "grant.renew", { repo: "team/project", apply: true });
  assert.equal(f.state.issues, 1);
  assert.equal(
    f.requests.some((r) => r.path === "/api/v3/user"),
    false,
  );
  const revoked = await call(f, "grant.revoke", { repo: "team/project", apply: true });
  assert.equal(revoked.result.data.state, "revoked");
  assert.equal(readdirSync(join(f.home, "workloads")).length, 0);
});
test("workload merge uses a grant effect, never a broad session or guessed provider PR", async (t) => {
  const f = await workload(t),
    id = randomUUID();
  const result = await call(f, "pr.merge", {
    repo: "team/project",
    number: 1,
    expectedHead: HEAD,
    method: "fast-forward-only",
    invocation: id,
    apply: true,
  });
  assert.equal(result.result.data.result.provider_merged, true);
  assert.equal(f.state.effects, 1);
  const request = f.requests.find((r) => r.path.endsWith("effects/pr.merge"));
  assert.equal(request.headers.authorization, `Bearer ${GRANT}`);
  assert.equal(request.body.provider_pr_number, 77);
  assert.equal(
    f.requests.some(
      (r) => r.path.endsWith("transport-sessions") && r.body.operation === "pr.merge",
    ),
    false,
  );
});
test("wrong grant repository and wrong transport scope fail before the ordinary endpoint", async (t) => {
  const f = await workload(t);
  f.state.wrongRepo = true;
  await assert.rejects(call(f, "pr.list", { repo: "team/project" }), (e) => e.code === "denied");
  assert.equal(
    f.requests.some((r) => r.path.endsWith("/pulls")),
    false,
  );
  f.state.wrongRepo = false;
  f.state.wrongScope = true;
  await assert.rejects(call(f, "pr.list", { repo: "team/project" }), (e) => e.code === "denied");
  assert.equal(
    f.requests.some((r) => r.path.endsWith("/pulls")),
    false,
  );
});
test("a task cannot select an untrusted workspace or leak into the native identity route", async (t) => {
  const f = await workload(t);
  await assert.rejects(
    call({ ...f, env: { ...f.env, MULTICA_WORKSPACE_ID: "outside" } }, "pr.list", {
      repo: "team/project",
    }),
    (e) => e.code === "denied",
  );
  assert.equal(f.requests.length, 0);
  await assert.rejects(
    call(f, "pr.list", { repo: "team/project", identity: "human" }),
    (e) => e.code === "denied",
  );
  assert.equal(f.requests.length, 0);
});

test("device login is a bounded AGS-only flow and stores only an owned Human credential", async (t) => {
  const f = fixture(t);
  let polls = 0;
  let endpoint;
  const s = await server(t, (r, res) => {
    if (r.path === "/login/device/code")
      return send(res, 200, {
        device_code: "private-device-fixture",
        user_code: "ABCD-EFGH",
        verification_uri: endpoint + "/login/device",
        expires_in: 300,
        interval: 1,
      });
    if (r.path === "/login/oauth/access_token") {
      polls++;
      assert.equal(r.body.device_code, "private-device-fixture");
      return polls === 1
        ? send(res, 200, { error: "authorization_pending" })
        : send(res, 200, { access_token: "device-human-fixture" });
    }
    if (r.path === "/api/v3/user" && r.headers.authorization === "Bearer device-human-fixture")
      return send(res, 200, { id: 1, login: "device-user", user_kind: "human" });
    return send(res, 404, {});
  });
  endpoint = s.endpoint;
  configure(f, endpoint, { auth: undefined });
  const started = await call(f, "auth.device-start", { context: "test", apply: true });
  assert.equal(started.exitCode, 8);
  assert.equal(started.result.data.userCode, "ABCD-EFGH");
  assert.equal(JSON.stringify(started).includes("private-device-fixture"), false);
  const pending = await call(f, "auth.device-finish", { context: "test", apply: true });
  assert.equal(pending.exitCode, 8);
  const done = await call(f, "auth.device-finish", { context: "test", apply: true });
  assert.equal(done.result.data.authorized, true);
  assert.equal(JSON.stringify(done).includes("device-human-fixture"), false);
  assert.equal(readFileSync(join(f.home, "secrets/test.token"), "utf8"), "device-human-fixture");
  assert.equal(existsSync(join(f.home, "device/test.json")), false);
});
