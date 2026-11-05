import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Effect } from "effect";
import { parse as yamlParse } from "yaml";
import { fixture, call, cli, child, provided } from "./helpers.mjs";
import { setup } from "../dist/application/setup.js";
import { startSession, showSession, endSession } from "../dist/application/session.js";
import { privateBytes } from "../dist/platform/store.js";
import { problem } from "../dist/domain/errors.js";

function ports(f) {
  const token = "synthetic-native-credential",
    api = [],
    executions = [],
    sessions = new Map();
  let loseIssue = false;
  const user = { id: 7, login: "fixture-agent", user_kind: "agent" };
  const processes = (spec) => {
    executions.push(spec);
    const stdout =
      spec.args[0] === "auth"
        ? token
        : spec.args[0] === "remote"
          ? "https://ags.example.test/team/project.git"
          : "gh version 2.101.0\n";
    return Effect.succeed({ exitCode: 0, stdout, stderr: "" });
  };
  const transport = (req) => {
    api.push(req);
    let status = 200,
      body;
    if (req.path === "/api/v3/user") body = user;
    else if (req.path === "/api/ext/v1/client-runs" && req.method === "POST") {
      const secret = "ags_run_" + randomBytes(32).toString("base64url");
      body = {
        schema: "ags.client-run.v1",
        id: req.body.id,
        actor_id: user.id,
        actor_login: user.login,
        context: req.body.context,
        association_status: Object.keys(req.body.context).length ? "provisional" : "unlinked",
        context_trust: "caller_claimed_not_authority",
        expires_at: new Date(Date.now() + 600000).toISOString(),
        token: secret,
      };
      sessions.set(body.id, body);
      status = 201;
      if (loseIssue)
        return Effect.fail(problem("outcome_unknown", "fixture lost response", "transport"));
    } else if (req.method === "DELETE") {
      status = sessions.delete(req.path.split("/").at(-1)) ? 204 : 404;
      body = null;
    } else {
      status = 404;
      body = null;
    }
    return Effect.succeed({ status, body, bytes: Buffer.from(JSON.stringify(body)), headers: {} });
  };
  return {
    token,
    user,
    api,
    executions,
    sessions,
    transport,
    processes,
    loseNextIssue: () => {
      loseIssue = true;
    },
  };
}

test("command discovery exposes only companion functions and rejects retired commands before I/O", async (t) => {
  const f = fixture(t);
  const result = await call(f, "schema");
  const names = result.result.data.commands.map((c) => c.name);
  assert.ok(names.includes("association.collect"));
  assert.ok(names.includes("session.start"));
  for (const prefix of ["pr.", "repo.", "run.", "grant.", "git.", "invocation."])
    assert.ok(!names.some((n) => n.startsWith(prefix)));
  for (const command of ["pr.create", "grant.issue", "git.bootstrap"])
    await assert.rejects(call(f, command), (error) => error.code === "invalid_input");
  assert.equal(readdirSync(f.home).length, 0);
  const invalid = await cli(f, [
    "session",
    "start",
    "--directory",
    join(f.root, "task"),
    "--ttl-seconds",
    "NaN",
  ]);
  assert.equal(invalid.code, 2);
  assert.ok(!existsSync(join(f.root, "task")));
});

test("standalone discovery needs neither gh configuration nor node_modules", async (t) => {
  const f = fixture(t);
  const result = await cli(f, ["schema", "--command", "ci.backend"], true);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).data.commands[0].name, "ci.backend");
  assert.ok(!existsSync(join(f.home, "config.json")));
  assert.ok(!existsSync(resolve(".test-build/candidate/dist/git-shim.js")));
});

test("setup plans without network then verifies before changing exactly one official gh host", async (t) => {
  const f = fixture(t),
    p = ports(f),
    directory = join(f.root, "official-gh"),
    tokenFile = join(f.root, "native.token");
  mkdirSync(directory, { mode: 0o755 });
  writeFileSync(
    join(directory, "hosts.yml"),
    "github.com:\n  user: original-user\n  oauth_token: synthetic-github-only\n",
    { mode: 0o600 },
  );
  writeFileSync(tokenFile, p.token, { mode: 0o600 });
  const input = { gh: process.execPath, ghConfig: directory, host: "ags.example.test", tokenFile };
  const plan = await provided(f, setup(input, false), p.transport, p.processes);
  assert.equal(p.api.length, 0);
  assert.equal(plan.previousUser, null);
  assert.ok(!JSON.stringify(plan).includes(p.token));
  const applied = await provided(
    f,
    setup({ ...input, expectedPlan: plan.expectedPlan, apply: true }, true),
    p.transport,
    p.processes,
  );
  assert.equal(applied.configured, true);
  assert.equal(p.api[0].path, "/api/v3/user");
  const hosts = yamlParse(readFileSync(join(directory, "hosts.yml"), "utf8"));
  assert.equal(hosts["github.com"].oauth_token, "synthetic-github-only");
  assert.equal(hosts["ags.example.test"].user, p.user.login);
  assert.equal(hosts["ags.example.test"].oauth_token, p.token);
  assert.ok(!JSON.stringify(applied).includes(p.token));
  assert.equal(applied.modifiesGitRemote, false);
});

test("setup rejects stale plans, unsafe files and hidden api_host rerouting", async (t) => {
  const f = fixture(t),
    p = ports(f),
    directory = join(f.root, "gh"),
    tokenFile = join(f.root, "native.token");
  writeFileSync(tokenFile, p.token, { mode: 0o600 });
  const input = { gh: process.execPath, ghConfig: directory, host: "ags.example.test", tokenFile };
  const plan = await provided(f, setup(input, false), p.transport, p.processes);
  writeFileSync(tokenFile, "changed-fixture");
  await assert.rejects(
    provided(
      f,
      setup({ ...input, expectedPlan: plan.expectedPlan, apply: true }, true),
      p.transport,
      p.processes,
    ),
    (error) => error.code === "conflict",
  );
  assert.equal(p.api.length, 0);
  chmodSync(tokenFile, 0o644);
  await assert.rejects(
    provided(f, setup(input, false), p.transport, p.processes),
    (error) => error.code === "config_error",
  );
  chmodSync(tokenFile, 0o600);
  const linked = join(f.root, "symlink-token");
  symlinkSync(tokenFile, linked);
  await assert.rejects(
    provided(f, setup({ ...input, tokenFile: linked }, false), p.transport, p.processes),
  );
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(
    join(directory, "hosts.yml"),
    "ags.example.test:\n  api_host: another.example.test\n",
    { mode: 0o600 },
  );
  await assert.rejects(
    provided(f, setup(input, false), p.transport, p.processes),
    (error) => error.code === "config_error",
  );
});

test("task setup creates one shared standard-client identity without command grants, PATH or target overrides", async (t) => {
  const f = fixture(t),
    p = ports(f),
    directory = join(f.root, "task");
  f.env.GH_HOST = "github.com";
  f.env.GH_TOKEN = "ambient-must-not-be-used";
  const input = {
    gh: process.execPath,
    ghConfig: join(f.root, "original-gh"),
    directory,
    context: { source: "fixture", agent: "actor", task: "one", run: "one" },
  };
  const plan = await provided(f, startSession(input), p.transport, p.processes);
  assert.equal(plan.planned, true);
  assert.equal(p.api.length, 0);
  assert.ok(!existsSync(directory));
  const active = await provided(
    f,
    startSession({ ...input, apply: true }),
    p.transport,
    p.processes,
  );
  assert.equal(active.phase, "active");
  assert.equal(active.associationStatus, "provisional");
  assert.equal(p.api.filter((r) => r.method === "POST").length, 1);
  assert.ok(p.api.every((r) => !r.path.includes("grant")));
  assert.ok(
    p.executions
      .filter((r) => r.args[0] === "auth")
      .every((r) => !r.env.GH_TOKEN && !r.env.GH_HOST),
  );
  const manifest = JSON.parse(readFileSync(active.environmentFile, "utf8"));
  assert.equal(manifest.changesPath, false);
  assert.equal(manifest.ghIsWrapped, false);
  assert.ok(manifest.unset.includes("GH_HOST"));
  assert.ok(
    !Object.hasOwn(manifest.set, "GH_HOST") &&
      !Object.hasOwn(manifest.set, "GH_REPO") &&
      !Object.hasOwn(manifest.set, "PATH"),
  );
  const issued = p.sessions.get(active.id);
  assert.ok(!JSON.stringify(active).includes(issued.token));
  assert.ok(!JSON.stringify(manifest).includes(issued.token));
  assert.ok(!existsSync(join(directory, "shims")));
  const shown = await provided(f, showSession({ directory }), p.transport, p.processes);
  assert.equal(shown.id, active.id);
  assert.ok(!JSON.stringify(shown).includes(issued.token));
  const config = yamlParse(privateBytes(join(directory, "gh/hosts.yml")).toString());
  assert.equal(config["ags.example.test"].oauth_token, issued.token);
});

test("standard Git credential protocol is exact-host/repository bound and never dispatches Git commands", async (t) => {
  const f = fixture(t),
    p = ports(f),
    directory = join(f.root, "task");
  const active = await provided(
    f,
    startSession({ gh: process.execPath, directory, apply: true }),
    p.transport,
    p.processes,
  );
  const helper = resolve("dist/credential-helper.js");
  const good = await child(process.execPath, [helper, directory, "get"], {
    cwd: f.cwd,
    env: f.env,
    input: "protocol=https\nhost=ags.example.test\npath=team/project.git\n\n",
  });
  assert.equal(good.code, 0);
  assert.ok(good.stdout.includes(p.sessions.get(active.id).token));
  for (const input of [
    "protocol=https\nhost=github.com\npath=team/project.git\n\n",
    "protocol=https\nhost=ags.example.test\npath=other/project.git\n\n",
  ]) {
    const bad = await child(process.execPath, [helper, directory, "get"], {
      cwd: f.cwd,
      env: f.env,
      input,
    });
    assert.notEqual(bad.code, 0);
    assert.equal(bad.stdout, "");
  }
  const manifest = JSON.parse(readFileSync(active.environmentFile, "utf8"));
  const env = { ...f.env, ...manifest.set };
  for (const key of manifest.unset) delete env[key];
  const git = await child("git", ["credential", "fill"], {
    cwd: f.cwd,
    env,
    input: "protocol=https\nhost=ags.example.test\npath=team/project.git\n\n",
  });
  assert.equal(git.code, 0, git.stderr);
  assert.ok(git.stdout.includes(p.sessions.get(active.id).token));
});

for (const ambientSource of [
  "global-helper",
  "repository-url-helper",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "global-askpass",
  "repository-askpass",
]) {
  test(`task Git ignores ambient ${ambientSource} outside its scope and after expiry`, async (t) => {
    const f = fixture(t),
      p = ports(f),
      directory = join(f.root, "task"),
      marker = join(f.root, "ambient-called"),
      canary = join(f.root, "ambient.mjs"),
      globalConfig = join(f.env.HOME, ".gitconfig");
    const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
    writeFileSync(
      canary,
      `#!${process.execPath}\n` +
        `import { appendFileSync } from "node:fs";\n` +
        `appendFileSync(${JSON.stringify(marker)}, "called\\n", { mode: 0o600 });\n` +
        `process.stdout.write(process.argv[2] === "get" ? "username=ambient\\npassword=synthetic-human\\n\\n" : "synthetic-human\\n");\n`,
      { mode: 0o700 },
    );
    writeFileSync(globalConfig, "", { mode: 0o600 });
    const helper = `!${quote(process.execPath)} ${quote(canary)}`;
    const ambient = { ...f.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
    const git = (args, env = ambient, input) => child("git", args, { cwd: f.cwd, env, input });
    assert.equal((await git(["init", "--quiet"])).code, 0);
    assert.equal(
      (await git(["remote", "add", "origin", "https://ags.example.test/team/project.git"])).code,
      0,
    );
    if (ambientSource === "global-helper")
      assert.equal(
        (await git(["config", "--file", globalConfig, "--add", "credential.helper", helper])).code,
        0,
      );
    else if (ambientSource === "repository-url-helper") {
      for (const target of [
        "https://ags.example.test/team/project.git",
        "https://ags.example.test/team/other.git",
        "https://foreign.example.test/team/project.git",
      ])
        assert.equal(
          (await git(["config", "--local", "--add", `credential.${target}.helper`, helper])).code,
          0,
        );
    } else if (ambientSource.endsWith("-askpass"))
      assert.equal(
        (
          await git([
            "config",
            ...(ambientSource === "global-askpass" ? ["--file", globalConfig] : ["--local"]),
            "core.askPass",
            canary,
          ])
        ).code,
        0,
      );
    else f.env[ambientSource] = ambient[ambientSource] = canary;
    const request = (host = "ags.example.test", path = "team/project.git") =>
      `protocol=https\nhost=${host}\npath=${path}\ncapability[]=authtype\ncapability[]=state\n\n`;
    const calls = () =>
      existsSync(marker) ? readFileSync(marker, "utf8").split("\n").length - 1 : 0;
    // Prove the installed canary can answer a real Git request before isolation.
    const control = await git(["credential", "fill"], ambient, request("foreign.example.test"));
    assert.equal(control.code, 0, control.stderr);
    assert.match(control.stdout, /password=synthetic-human/);
    const originalCalls = calls();
    const originalConfig = readFileSync(globalConfig);
    const localConfig = join(f.cwd, ".git/config");
    const originalLocalConfig = readFileSync(localConfig);
    const active = await provided(
      f,
      startSession({ gh: process.execPath, directory, apply: true }),
      p.transport,
      p.processes,
    );
    const manifest = JSON.parse(readFileSync(active.environmentFile, "utf8"));
    const env = { ...f.env };
    for (const key of manifest.unset) delete env[key];
    Object.assign(env, manifest.set, { GIT_CONFIG_NOSYSTEM: "1" });
    const good = await git(["credential", "fill"], env, request());
    assert.equal(good.code, 0, good.stderr);
    assert.ok(good.stdout.includes(p.sessions.get(active.id).token));
    assert.equal(calls(), originalCalls);
    const denied = [];
    for (const input of [
      request("ags.example.test", "team/other.git"),
      request("foreign.example.test"),
    ])
      denied.push(await git(["credential", "fill"], env, input));
    const saved = JSON.parse(readFileSync(join(directory, "session.json"), "utf8"));
    saved.expiresAt = "2000-01-01T00:00:00.000Z";
    writeFileSync(join(directory, "session.json"), JSON.stringify(saved), { mode: 0o600 });
    denied.push(await git(["credential", "fill"], env, request()));
    for (const result of denied) {
      assert.notEqual(result.code, 0);
      assert.equal(result.stdout, "");
      assert.ok(!result.stderr.includes(p.sessions.get(active.id).token));
    }
    assert.equal(calls(), originalCalls, "Task Git must not call an ambient helper or AskPass");
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.ok(!env.GIT_ASKPASS && !env.SSH_ASKPASS);
    assert.deepEqual(readFileSync(globalConfig), originalConfig);
    assert.deepEqual(readFileSync(localConfig), originalLocalConfig);
  });
}

test("missing optional source context does not block native identity and siblings remain isolated", async (t) => {
  const f = fixture(t),
    p = ports(f);
  const first = await provided(
    f,
    startSession({
      gh: process.execPath,
      directory: join(f.root, "a"),
      context: { task: "one" },
      source: { instance: "source", tokenFile: join(f.root, "missing") },
      apply: true,
    }),
    p.transport,
    p.processes,
  );
  const second = await provided(
    f,
    startSession({ gh: process.execPath, directory: join(f.root, "b"), apply: true }),
    p.transport,
    p.processes,
  );
  assert.equal(first.warnings.length, 1);
  assert.notEqual(first.id, second.id);
  assert.notEqual(p.sessions.get(first.id).token, p.sessions.get(second.id).token);
  const ended = await provided(
    f,
    endSession({ directory: first.directory, apply: true }),
    p.transport,
    p.processes,
  );
  assert.equal(ended.serverRevoked, true);
  assert.equal(ended.nativeParentRevoked, false);
  assert.equal(p.sessions.size, 1);
  assert.ok(!existsSync(join(first.directory, "gh/hosts.yml")));
  assert.ok(existsSync(join(second.directory, "gh/hosts.yml")));
});

test("lost setup response is not replayed and its known UUID can be ended with the original actor", async (t) => {
  const f = fixture(t),
    p = ports(f),
    directory = join(f.root, "unknown");
  p.loseNextIssue();
  const input = { gh: process.execPath, directory, apply: true };
  await assert.rejects(
    provided(f, startSession(input), p.transport, p.processes),
    (error) => error.code === "outcome_unknown",
  );
  const state = JSON.parse(readFileSync(join(directory, "session.json"), "utf8"));
  assert.equal(state.phase, "unknown");
  assert.ok(p.sessions.has(state.id));
  await assert.rejects(
    provided(f, startSession(input), p.transport, p.processes),
    (error) => error.code === "conflict",
  );
  assert.equal(p.api.filter((r) => r.method === "POST").length, 1);
  const ended = await provided(f, endSession({ directory, apply: true }), p.transport, p.processes);
  assert.equal(ended.serverRevoked, true);
  assert.equal(p.sessions.size, 0);
});
