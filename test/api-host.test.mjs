import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { parse as parseYaml } from "yaml";
import { fixture, provided, child } from "./helpers.mjs";
import { setup } from "../dist/application/setup.js";
import { startSession, endSession } from "../dist/application/session.js";
import { inspectAssociation, runtime } from "../dist/application/connection.js";

test("explicit shell executable choice avoids a system-gh downgrade without changing routing", async (t) => {
  const f = fixture(t),
    p = ports();
  f.env.AGSX_GH = process.execPath;
  const chosen = await provided(f, runtime({}), p.transport, p.processes);
  assert.equal(chosen.gh, realpathSync(process.execPath));
  assert.equal(p.requests.length, 0);
  assert.equal(p.commands.length, 0);
  f.env.AGSX_GH = "relative-or-untrusted";
  await assert.rejects(
    provided(f, runtime({}), p.transport, p.processes),
    (e) => e.code === "config_error",
  );
  const explicit = await provided(f, runtime({ gh: process.execPath }), p.transport, p.processes);
  assert.equal(explicit.gh, realpathSync(process.execPath));
});

function ports() {
  const requests = [],
    commands = [];
  let version = "gh version 2.101.0\n";
  const processes = (spec) => {
    commands.push(spec);
    let stdout = "";
    if (spec.args[0] === "--version") stdout = version;
    else if (spec.args[0] === "auth") stdout = "native-fixture";
    else if (spec.args[0] === "remote") stdout = "http://ags:6666/team/project.git";
    return Effect.succeed({ exitCode: 0, stdout, stderr: "" });
  };
  const transport = (req) => {
    requests.push(req);
    assert.equal(req.endpoint, "https://api-ags.example.test");
    let status = 200,
      body;
    if (req.path === "/api/v3/user") body = { id: 7, login: "fixture", user_kind: "agent" };
    else if (req.path === "/api/ext/v1/client-runs") {
      status = 201;
      body = {
        schema: "ags.client-run.v1",
        id: req.body.id,
        actor_id: 7,
        actor_login: "fixture",
        context: req.body.context,
        association_status: "unlinked",
        context_trust: "caller_claimed_not_authority",
        expires_at: new Date(Date.now() + 600000).toISOString(),
        token: "ags_run_" + "b".repeat(43),
      };
    } else if (req.method === "DELETE") {
      status = 204;
      body = null;
    } else body = { schema: "ags.ci-backend.v1", backend: "native" };
    return Effect.succeed({ status, body, bytes: Buffer.from(JSON.stringify(body)), headers: {} });
  };
  return {
    requests,
    commands,
    processes,
    transport,
    oldGh: () => {
      version = "gh version 2.86.0\n";
    },
  };
}

test("one-time official api_host preserves short Git origins and task lifecycle routing", async (t) => {
  const f = fixture(t),
    p = ports(),
    tokenFile = join(f.root, "parent.token"),
    ghConfig = join(f.root, "gh");
  writeFileSync(tokenFile, "native-fixture", { mode: 0o600 });
  const input = {
    gh: process.execPath,
    ghConfig,
    host: "ags",
    apiHost: "api-ags.example.test",
    tokenFile,
  };
  const plan = await provided(f, setup(input, false), p.transport, p.processes);
  assert.equal(plan.apiHost, "api-ags.example.test");
  assert.equal(p.requests.length, 0);
  await provided(
    f,
    setup({ ...input, expectedPlan: plan.expectedPlan, apply: true }, true),
    p.transport,
    p.processes,
  );
  assert.equal(
    parseYaml(readFileSync(join(ghConfig, "hosts.yml"), "utf8")).ags.api_host,
    "api-ags.example.test",
  );
  const directory = join(f.root, "task");
  const active = await provided(
    f,
    startSession({ gh: process.execPath, ghConfig, directory, apply: true }),
    p.transport,
    p.processes,
  );
  assert.equal(active.host, "ags");
  assert.equal(active.apiHost, "api-ags.example.test");
  const generated = parseYaml(readFileSync(join(directory, "gh/hosts.yml"), "utf8"));
  assert.equal(generated.ags.api_host, "api-ags.example.test");
  const environment = JSON.parse(readFileSync(join(directory, "environment.json"), "utf8"));
  assert.ok(!environment.set.GH_HOST && !environment.set.GH_REPO && !environment.set.PATH);
  await provided(
    f,
    inspectAssociation({ gh: process.execPath, ghConfig }, true),
    p.transport,
    p.processes,
  );
  assert.ok(p.commands.filter((c) => c.args[0] === "auth").every((c) => c.args.at(-1) === "ags"));
  for (const [protocol, host] of [
    ["http", "ags:6666"],
    ["https", "api-ags.example.test"],
  ]) {
    const result = await child(
      process.execPath,
      [resolve("dist/credential-helper.js"), directory, "get"],
      {
        cwd: f.cwd,
        env: f.env,
        input: `protocol=${protocol}\nhost=${host}\npath=team/project.git\n\n`,
      },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes("password=ags_run_"));
  }
  await provided(f, endSession({ directory, apply: true }), p.transport, p.processes);
  assert.equal(p.requests.at(-1).endpoint, "https://api-ags.example.test");
  const count = p.requests.length;
  p.oldGh();
  await assert.rejects(
    provided(
      f,
      startSession({
        gh: process.execPath,
        ghConfig,
        directory: join(f.root, "old-client"),
        apply: true,
      }),
      p.transport,
      p.processes,
    ),
    (e) => e.code === "unsupported",
  );
  assert.equal(p.requests.length, count, "An old gh must not create a session it cannot route.");
});

test("custom API host is explicit, plan-bound and requires supported official gh", async (t) => {
  const f = fixture(t),
    p = ports(),
    tokenFile = join(f.root, "parent.token");
  writeFileSync(tokenFile, "native-fixture", { mode: 0o600 });
  const input = {
    gh: process.execPath,
    ghConfig: join(f.root, "gh"),
    host: "ags",
    apiHost: "api-ags.example.test",
    tokenFile,
  };
  const plan = await provided(f, setup(input, false), p.transport, p.processes);
  await assert.rejects(
    provided(
      f,
      setup(
        {
          ...input,
          apiHost: "different.example.test",
          expectedPlan: plan.expectedPlan,
          apply: true,
        },
        true,
      ),
      p.transport,
      p.processes,
    ),
    (e) => e.code === "conflict",
  );
  assert.equal(p.requests.length, 0);
  p.oldGh();
  await assert.rejects(
    provided(f, setup(input, false), p.transport, p.processes),
    (e) => e.code === "unsupported",
  );
  assert.equal(p.requests.length, 0);
});
