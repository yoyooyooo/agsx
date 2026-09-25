import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  agsFixture,
  fixture,
  configure,
  call,
  cli,
  server,
  send,
  TOKEN,
  HEAD,
  BASE,
} from "./helpers.mjs";
const code = (value) => (error) => error?.code === value;

test("Human and native service identities operate without Multica and never need provider secrets", async (t) => {
  const f = await agsFixture(t, { provider: false });
  assert.equal((await call(f, "auth.status")).result.data.kind, "human");
  const repo = await call(f, "repo.view", { repo: "team/project" });
  assert.equal(repo.result.data.full_name, "team/project");
  const result = await call(f, "pr.list", { repo: "team/project" });
  assert.equal(result.result.data.items.length, 1);
  const before = f.requests.length;
  await assert.rejects(
    call({ ...f, env: { ...f.env, MULTICA_TOKEN: "mat_" + "x".repeat(32) } }, "pr.list", {
      repo: "team/project",
    }),
    code("config_error"),
  );
  assert.equal(f.requests.length, before);
  const service = await agsFixture(t, { userKind: "agent" });
  assert.equal((await call(service, "auth.status")).result.data.kind, "service");
});
test("normal PR create, read, edit, comment, review, close/reopen, update and merge use native APIs", async (t) => {
  const f = await agsFixture(t);
  const created = await call(f, "pr.create", {
    repo: "team/project",
    head: "feature-two",
    base: "main",
    title: "New change",
    expectedHead: HEAD,
    apply: true,
  });
  const number = created.result.data.result.pull.number;
  assert.equal(number, 2);
  const viewed = await call(f, "pr.view", { repo: "team/project", number });
  assert.equal(viewed.result.data.number, 2);
  const edit = await call(f, "pr.edit", {
    repo: "team/project",
    number,
    title: "Updated",
    expectedHead: HEAD,
    apply: true,
  });
  assert.equal(edit.result.data.result.title, "Updated");
  await call(f, "pr.comment", { repo: "team/project", number, body: "Comment", apply: true });
  await call(f, "pr.review", {
    repo: "team/project",
    number,
    expectedHead: HEAD,
    event: "APPROVE",
    body: "Looks good",
    apply: true,
  });
  assert.equal(
    (await call(f, "pr.reviews", { repo: "team/project", number })).result.data.items.length,
    1,
  );
  await call(f, "pr.close", { repo: "team/project", number, expectedHead: HEAD, apply: true });
  assert.equal(f.state.prs[1].state, "closed");
  await call(f, "pr.reopen", { repo: "team/project", number, expectedHead: HEAD, apply: true });
  assert.equal(f.state.prs[1].state, "open");
  await call(f, "pr.update-branch", {
    repo: "team/project",
    number,
    expectedHead: HEAD,
    apply: true,
  });
  const merged = await call(f, "pr.merge", {
    repo: "team/project",
    number,
    expectedHead: HEAD,
    method: "fast-forward-only",
    apply: true,
  });
  assert.equal(merged.result.data.result.provider_merged, true);
  assert.equal(
    f.requests.some((r) => r.path.includes("/api/graphql")),
    false,
  );
  assert.equal(
    f.requests.some((r) => r.method === "PUT" && r.path.endsWith("/merge")),
    false,
  );
});
test("native repository creation does not wait for a nonexistent Forgejo deployment", async (t) => {
  const f = await agsFixture(t, { provider: false });
  f.state.repoExists = false;
  const created = await call(f, "repo.create", {
    repo: "team/project",
    visibility: "public",
    defaultBranch: "trunk",
    readme: true,
    apply: true,
  });
  assert.equal(created.result.status, "ok");
  assert.equal(created.result.data.result.repository.private, false);
  assert.equal(created.result.data.result.projection.status, "separate_observation");
  const existing = await call(f, "repo.create", { repo: "team/project", apply: true });
  assert.equal(existing.result.data.existing, true);
  assert.equal(f.state.writes, 1);
});
test("atomic-head merge is never silently substituted by a native endpoint without that condition", async (t) => {
  const f = await agsFixture(t, { provider: false });
  await assert.rejects(
    call(f, "pr.merge", {
      repo: "team/project",
      number: 1,
      expectedHead: HEAD,
      method: "merge",
      apply: true,
    }),
    code("unsupported"),
  );
  assert.equal(f.state.writes, 0);
  f.state.prs[0].external_projections = [
    { provider: "forgejo", external_repo: "team/project", external_number: 77 },
    { provider: "forgejo", external_repo: "team/project", external_number: 78 },
  ];
  await assert.rejects(
    call(f, "pr.merge", {
      repo: "team/project",
      number: 1,
      expectedHead: HEAD,
      method: "merge",
      apply: true,
    }),
    code("conflict"),
  );
  assert.equal(f.state.writes, 0);
});
test("head drift refuses writes and successful invocation IDs do not repeat comment POSTs", async (t) => {
  const f = await agsFixture(t),
    invocation = randomUUID();
  await assert.rejects(
    call(f, "pr.edit", {
      repo: "team/project",
      number: 1,
      title: "Must not happen",
      expectedHead: BASE,
      apply: true,
    }),
    code("conflict"),
  );
  assert.equal(f.state.writes, 0);
  const request = { repo: "team/project", number: 1, body: "Exactly one", invocation, apply: true };
  await call(f, "pr.comment", request);
  const second = await call(f, "pr.comment", request);
  assert.equal(second.result.data.alreadyCompleted, true);
  assert.equal(f.state.comments.length, 1);
  await assert.rejects(
    call(f, "pr.comment", { ...request, body: "Different intent" }),
    code("conflict"),
  );
  assert.equal(f.state.comments.length, 1);
  const disk = readdirSync(join(f.home, "operations"))
    .filter((x) => x.endsWith(".json"))
    .map((x) => readFileSync(join(f.home, "operations", x), "utf8"))
    .join("\n");
  assert.equal(disk.includes(TOKEN), false);
  assert.equal(disk.includes("Exactly one"), false);
});
test("lost write reply is outcome_unknown and does not replay; exact PR readback reconciles it", async (t) => {
  const f = await agsFixture(t),
    id = randomUUID();
  f.state.loseNextWrite = true;
  await assert.rejects(
    call(f, "pr.create", {
      repo: "team/project",
      head: "new-branch",
      base: "main",
      title: "Unknown result",
      invocation: id,
      apply: true,
    }),
    (e) => e.code === "outcome_unknown" && e.details.invocation === id,
  );
  assert.equal(f.state.writes, 1);
  const row = await call(f, "invocation.show", { id });
  assert.equal(row.result.data.state, "unknown");
  const result = await call(f, "invocation.reconcile", { id });
  assert.equal(result.result.data.confirmed, true);
  assert.equal(result.result.data.replayed, false);
  assert.equal(result.result.data.attribution, "current_state_only");
  assert.equal(f.state.writes, 1);
});
test("CI required facts, exact head and bounded pending watch are distinct outcomes", async (t) => {
  const f = await agsFixture(t);
  let result = await call(f, "ci.checks", { repo: "team/project", number: 1, required: true });
  assert.equal(result.exitCode, 0);
  assert.equal(result.result.data.checks[0].bucket, "pass");
  f.state.requiredFacts = false;
  await assert.rejects(
    call(f, "ci.checks", { repo: "team/project", number: 1, required: true }),
    code("unsupported"),
  );
  f.state.ciState = "in_progress";
  result = await call(f, "ci.checks", {
    repo: "team/project",
    number: 1,
    watch: true,
    waitMs: 150,
    intervalMs: 100,
  });
  assert.equal(result.exitCode, 8);
  assert.equal(result.result.data.waitExpired, true);
  f.state.ciState = "failure";
  result = await call(f, "ci.checks", { repo: "team/project", number: 1 });
  assert.equal(result.exitCode, 1);
  const run = await call(f, "run.view", { repo: "team/project", number: 1, runId: 9 });
  assert.equal(run.result.data.run.id, 9);
  const logs = await call(f, "run.logs", {
    repo: "team/project",
    number: 1,
    runId: 9,
    failedOnly: true,
  });
  assert.equal(logs.result.data.text, "test output\n");
  await assert.rejects(
    call(f, "run.view", { repo: "team/project", number: 1, runId: 999 }),
    code("conflict"),
  );
});
test("auth import verifies before committing, supports no old profile, and logout never revokes a server token implicitly", async (t) => {
  const f = await agsFixture(t),
    old = JSON.parse(readFileSync(join(f.home, "config.json"), "utf8"));
  delete old.contexts.test.auth;
  writeFileSync(join(f.home, "config.json"), JSON.stringify(old), { mode: 0o600 });
  const result = await call(f, "auth.import", {
    context: "test",
    kind: "human",
    file: join(f.home, "token"),
    apply: true,
  });
  assert.equal(result.result.data.imported, true);
  assert.equal(existsSync(join(f.home, "secrets/test.token")), true);
  const logout = await call(f, "auth.logout", { context: "test", apply: true });
  assert.equal(logout.result.data.serverCredentialRevoked, false);
  assert.equal(existsSync(join(f.home, "secrets/test.token")), false);
  assert.equal(f.requests.filter((r) => r.method !== "GET").length, 0);
});
