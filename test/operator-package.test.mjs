import test from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  chmodSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { fixture, agsFixture, server, send, call, child } from "./helpers.mjs";
import { verifyCandidate } from "../dist/packaging/package.js";
import { fingerprint } from "../dist/platform/store.js";

async function operatorFixture(t) {
  const f = await agsFixture(t),
    state = {
      writes: 0,
      repo: { id: 20, full_name: "team/project", private: true, default_branch: "main" },
      protection: {
        branch_name: "main",
        enable_push: false,
        enable_force_push: false,
        required_approvals: 3,
      },
      hooks: [],
      labels: [],
    };
  const provider = await server(t, (r, res) => {
    if (r.headers.authorization !== "Bearer provider-fixture") return send(res, 401, {});
    const root = "/api/v1/repos/team/project";
    if (r.path === root) {
      if (r.method === "PATCH") {
        state.writes++;
        Object.assign(state.repo, r.body);
      }
      return send(res, 200, state.repo);
    }
    if (r.path === root + "/branches/main")
      return send(res, 200, { commit: { id: "a".repeat(40) } });
    if (r.path === root + "/branch_protections/main") {
      if (r.method === "PATCH") {
        state.writes++;
        Object.assign(state.protection, r.body);
      }
      return send(res, 200, state.protection);
    }
    if (r.path === root + "/hooks") {
      if (r.method === "POST") {
        state.writes++;
        state.hooks.push({ id: 1, ...r.body });
        return send(res, 201, state.hooks[0]);
      }
      return send(res, 200, state.hooks);
    }
    if (r.path === root + "/labels") {
      if (r.method === "POST") {
        state.writes++;
        state.labels.push({ id: 1, ...r.body });
        return send(res, 201, state.labels[0]);
      }
      return send(res, 200, state.labels);
    }
    return send(res, 404, {});
  });
  const runtime = join(f.root, "runtime");
  mkdirSync(runtime, { mode: 0o700 });
  mkdirSync(join(runtime, "config"), { mode: 0o700 });
  writeFileSync(
    join(runtime, "config/integrations.yaml"),
    YAML.stringify({ forgejo: { repos: {} }, unrelated: { keep: "unchanged" } }),
    { mode: 0o600 },
  );
  writeFileSync(join(f.root, "provider.token"), "provider-fixture", { mode: 0o600 });
  writeFileSync(join(f.root, "hook.secret"), "webhook-fixture-secret", { mode: 0o600 });
  const manifest = {
    schema: "agsx.operator.v1",
    context: "test",
    repository: "team/project",
    forgejo: {
      endpoint: provider.endpoint,
      credential: { file: join(f.root, "provider.token") },
      repository: "team/project",
    },
    desired: {
      branch: "main",
      private: true,
      protection: { enable_push: true, enable_force_push: false },
      labels: [{ name: "needs-review", color: "abcdef", description: "Review" }],
      webhook: {
        url: f.endpoint + "/hooks/provider",
        secret: { file: join(f.root, "hook.secret") },
        events: ["push", "pull_request"],
      },
    },
    runtime: { root: runtime, autoPr: true, mergeMethod: "rebase" },
  };
  const path = join(f.root, "operator.json");
  writeFileSync(path, JSON.stringify(manifest), { mode: 0o600 });
  return { ...f, provider, operatorState: state, runtime, manifest: path };
}
test("operator plan/apply is separate, exact, no backend SQL, and preserves unrelated review gates/config", async (t) => {
  const f = await operatorFixture(t),
    before = readFileSync(join(f.runtime, "config/integrations.yaml"), "utf8");
  const planned = await call(f, "ops.plan", { manifest: f.manifest });
  assert.equal(planned.result.data.steps.length, 4);
  assert.equal(f.operatorState.writes, 0);
  assert.equal(JSON.stringify(planned).includes("provider-fixture"), false);
  assert.equal(JSON.stringify(planned).includes("webhook-fixture-secret"), false);
  const applied = await call(f, "ops.apply", {
    manifest: f.manifest,
    expectedPlan: planned.result.data.planHash,
    apply: true,
  });
  assert.equal(applied.result.data.applied.length, 4);
  assert.equal(f.operatorState.protection.required_approvals, 3);
  assert.equal(f.operatorState.protection.enable_force_push, false);
  assert.equal(f.operatorState.writes, 3);
  const mapping = YAML.parse(readFileSync(join(f.runtime, "config/integrations.yaml"), "utf8"));
  assert.equal(mapping.unrelated.keep, "unchanged");
  assert.equal(mapping.forgejo.repos["team/project"].delegated_merge_method, "rebase");
  const verified = await call(f, "ops.verify", { manifest: f.manifest });
  assert.equal(verified.result.data.converged, true);
  assert.equal(verified.result.data.steps.length, 0);
  const journal = readdirSync(join(f.home, "operations"))
    .filter((x) => x.endsWith(".json"))
    .map((x) => readFileSync(join(f.home, "operations", x), "utf8"))
    .join("\n");
  assert.equal(journal.includes("webhook-fixture-secret"), false);
  assert.equal(journal.includes("provider-fixture"), false);
});
test("operator refuses a stale observed plan instead of overwriting newly changed provider policy", async (t) => {
  const f = await operatorFixture(t),
    plan = await call(f, "ops.plan", { manifest: f.manifest });
  f.operatorState.protection.required_approvals = 4;
  await assert.rejects(
    call(f, "ops.apply", {
      manifest: f.manifest,
      expectedPlan: plan.result.data.planHash,
      apply: true,
    }),
    (e) => e.code === "conflict",
  );
  assert.equal(f.operatorState.writes, 0);
});
function cloneCandidate(f, name = "candidate") {
  const dest = join(f.root, name);
  cpSync(resolve(".test-build/candidate"), dest, { recursive: true });
  return dest;
}
function changeVersion(root, version) {
  const p = join(root, "package.json"),
    pkg = JSON.parse(readFileSync(p, "utf8"));
  pkg.version = version;
  writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
  const m = join(root, "build-manifest.json"),
    manifest = JSON.parse(readFileSync(m, "utf8"));
  manifest.version = version;
  const bytes = readFileSync(p);
  manifest.files["package.json"] = {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  writeFileSync(m, JSON.stringify(manifest, null, 2) + "\n");
}
test("standalone package verifies and installs one slot, upgrades without retained releases and runs outside source tree", async (t) => {
  const f = fixture(t),
    candidate = cloneCandidate(f),
    verified = verifyCandidate(candidate),
    prefix = join(f.root, "installed");
  const one = await call(f, "package.install", {
    directory: candidate,
    prefix,
    expectedDigest: verified.digest,
    apply: true,
  });
  assert.equal(one.result.data.retainedVersions, 1);
  const actual = await child(
    process.execPath,
    [join(prefix, "dist/cli.js"), "schema", "--command", "pr.list"],
    { cwd: f.cwd, env: { ...f.env, AGSX_HOME: f.home } },
  );
  assert.equal(actual.code, 0, actual.stderr);
  assert.equal(JSON.parse(actual.stdout).data.commands[0].name, "pr.list");
  assert.equal(
    (
      await call(f, "package.install", {
        directory: candidate,
        prefix,
        expectedDigest: verified.digest,
        apply: true,
      })
    ).result.data.unchanged,
    true,
  );
  changeVersion(candidate, "0.0.0-rebuild.2");
  const two = verifyCandidate(candidate);
  await call(f, "package.install", {
    directory: candidate,
    prefix,
    expectedDigest: two.digest,
    apply: true,
  });
  assert.equal(verifyCandidate(prefix).manifest.version, "0.0.0-rebuild.2");
  assert.equal(existsSync(join(prefix, "releases")), false);
  assert.equal(existsSync(join(prefix, "current")), false);
  assert.equal(
    readdirSync(prefix).some((n) => n.startsWith(".transaction-")),
    false,
  );
});
test("candidate drift and nonempty foreign directories are never overwritten", async (t) => {
  const f = fixture(t),
    candidate = cloneCandidate(f),
    before = verifyCandidate(candidate),
    prefix = join(f.root, "foreign");
  mkdirSync(prefix, { mode: 0o700 });
  writeFileSync(join(prefix, "user-file"), "keep");
  await assert.rejects(
    call(f, "package.install", {
      directory: candidate,
      prefix,
      expectedDigest: before.digest,
      apply: true,
    }),
    (e) => e.code === "conflict",
  );
  assert.equal(readFileSync(join(prefix, "user-file"), "utf8"), "keep");
  writeFileSync(join(candidate, "dist/cli.js"), "tampered");
  assert.throws(() => verifyCandidate(candidate));
});
test("an interrupted package cannot run and resumes only its exact candidate", async (t) => {
  const f = fixture(t),
    candidate = cloneCandidate(f),
    verified = verifyCandidate(candidate),
    prefix = join(f.root, "installed");
  await call(f, "package.install", {
    directory: candidate,
    prefix,
    expectedDigest: verified.digest,
    apply: true,
  });
  writeFileSync(
    join(prefix, ".installing.json"),
    JSON.stringify({ schema: "agsx.installing.v1", digest: verified.digest }),
    { mode: 0o600 },
  );
  const blocked = await child(process.execPath, [join(prefix, "dist/cli.js"), "schema"], {
    cwd: f.cwd,
    env: { ...f.env, AGSX_HOME: f.home },
  });
  assert.equal(blocked.code, 5);
  assert.equal(JSON.parse(blocked.stdout).error.stage, "startup");
  await call(f, "package.install", {
    directory: candidate,
    prefix,
    expectedDigest: verified.digest,
    apply: true,
  });
  assert.equal(existsSync(join(prefix, ".installing.json")), false);
  assert.equal(verifyCandidate(prefix).digest, verified.digest);
});
