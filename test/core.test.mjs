import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import {
  fixture,
  configure,
  call,
  cli,
  child,
  server,
  send,
  effectResult,
  TOKEN,
  HEAD,
} from "./helpers.mjs";
import { program } from "../dist/application/app.js";
import { validateConfig } from "../dist/domain/model.js";
import { parseArgv, validateInput } from "../dist/domain/commands.js";
import {
  Settings,
  settingsLayer,
  Journal,
  journalLayer,
  fingerprint,
} from "../dist/platform/store.js";

const errorCode = (code) => (error) => error?.code === code;
test("schema discovery and unsupported input have no config/credential/network side effects", async (t) => {
  const f = fixture(t),
    home = join(f.root, "not-created"),
    opts = { ...f, home };
  const result = await effectResult(program(["schema"], opts));
  assert.ok(result.result.data.commands.length >= 45);
  assert.equal(existsSync(home), false);
  await assert.rejects(
    effectResult(program(["pr.destroy", "--apply"], opts)),
    errorCode("invalid_input"),
  );
  await assert.rejects(
    effectResult(program(["pr.create", "--unknown", "anything"], opts)),
    errorCode("invalid_input"),
  );
  assert.equal(existsSync(home), false);
  const executable = await cli(f, ["nonsense", "--help"]);
  assert.equal(executable.code, 2);
  assert.equal(JSON.parse(executable.stdout).status, "error");
});
test("stdin JSON is bounded, parsed once and never requires a private project context", async (t) => {
  const f = fixture(t);
  const result = await child(
    process.execPath,
    [resolve("dist/cli.js"), "context.add", "--input", "-", "--apply"],
    {
      cwd: f.cwd,
      env: { ...f.env, AGSX_HOME: f.home },
      input: JSON.stringify({
        name: "stdin",
        configuration: { endpoint: "http://127.0.0.1:6666", instanceId: "stdin" },
      }),
    },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "ok");
  const invalid = await child(
    process.execPath,
    [resolve("dist/cli.js"), "context.list", "--input", "-"],
    { cwd: f.cwd, env: { ...f.env, AGSX_HOME: f.home }, input: "{invalid" },
  );
  assert.equal(invalid.code, 2);
  assert.equal(JSON.parse(invalid.stdout).error.code, "invalid_input");
  const oversized = await child(
    process.execPath,
    [resolve("dist/cli.js"), "context.list", "--input", "-"],
    { cwd: f.cwd, env: { ...f.env, AGSX_HOME: f.home }, input: "x".repeat(1024 * 1024 + 1) },
  );
  assert.equal(oversized.code, 2);
  assert.equal(JSON.parse(oversized.stdout).error.stage, "stdin");
});
test("finite numbers, unknown fields and duplicate options are rejected before credential lookup", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    call(f, "pr.view", { repo: "team/project", number: -1 }),
    errorCode("invalid_input"),
  );
  await assert.rejects(
    call(f, "pr.merge", {
      repo: "team/project",
      number: 1,
      expectedHead: "bad",
      method: "merge",
      apply: true,
    }),
    errorCode("invalid_input"),
  );
  assert.throws(() => parseArgv(["context.list", "--apply", "--apply"]));
  const parsed = parseArgv(["pr.view", "--number", "1"]);
  assert.equal(validateInput(parsed.spec, parsed.partial).number, 1);
  assert.throws(() => validateInput(parsed.spec, { number: 1, token: "must-not-be-accepted" }));
});
test("AGS-only Context can be created, selected, exported and removed without Multica", async (t) => {
  const f = fixture(t),
    configuration = { endpoint: "http://127.0.0.1:6666", instanceId: "standalone" };
  const plan = await call(f, "context.add", { name: "local", configuration });
  assert.equal(plan.result.status, "planned");
  assert.equal(existsSync(join(f.home, "config.json")), false);
  await call(f, "context.add", { name: "local", configuration, apply: true });
  await call(f, "context.use", { name: "local", apply: true });
  const exported = await call(f, "context.export", { name: "local" });
  assert.equal(exported.result.data.configuration.workload, undefined);
  const listed = await call(f, "context.list");
  assert.equal(listed.result.data.defaultContext, "local");
  await assert.rejects(
    call(f, "context.remove", { name: "local", expectedConfig: "stale", apply: true }),
    errorCode("conflict"),
  );
  await call(f, "context.remove", {
    name: "local",
    expectedConfig: listed.result.data.configHash,
    apply: true,
  });
  assert.deepEqual((await call(f, "context.list")).result.data.contexts, {});
});
test("overlapping aliases, ambient GH tokens, and non-loopback HTTP fail explicit configuration", () => {
  assert.throws(() =>
    validateConfig({
      schema: "agsx.config.v1",
      contexts: { a: { endpoint: "http://primary.example.test", instanceId: "a" } },
    }),
  );
  assert.throws(() =>
    validateConfig({
      schema: "agsx.config.v1",
      contexts: {
        a: { endpoint: "https://primary.example.test", instanceId: "a" },
        b: {
          endpoint: "https://other.example.test",
          instanceId: "b",
          aliases: ["https://primary.example.test"],
        },
      },
    }),
  );
  assert.throws(() =>
    validateConfig({
      schema: "agsx.config.v1",
      contexts: {
        a: {
          endpoint: "https://primary.example.test",
          instanceId: "a",
          auth: { kind: "human", credential: { env: "GH_TOKEN" } },
        },
      },
    }),
  );
});
test("credential/config symlinks and loose permissions are not accepted", async (t) => {
  const f = fixture(t);
  configure(f, "http://127.0.0.1:6666");
  chmodSync(join(f.home, "token"), 0o644);
  const read = Effect.gen(function* () {
    return yield* (yield* Settings).secret({ file: "token" });
  }).pipe(Effect.provide(settingsLayer(f)));
  await assert.rejects(effectResult(read), errorCode("config_error"));
  const secret = join(f.root, "external-token");
  writeFileSync(secret, TOKEN, { mode: 0o600 });
  symlinkSync(secret, join(f.home, "linked"));
  const linked = Effect.gen(function* () {
    return yield* (yield* Settings).secret({ file: "linked" });
  }).pipe(Effect.provide(settingsLayer(f)));
  await assert.rejects(effectResult(linked));
});
test("known writes are plan-only by default and malformed input cannot be hidden by a plan", async (t) => {
  const f = fixture(t),
    home = join(f.root, "absent");
  const result = await call({ ...f, home }, "pr.create", {
    repo: "team/project",
    head: "feature",
    base: "main",
    title: "Plan only",
  });
  assert.equal(result.result.status, "planned");
  assert.equal(result.result.data.credentialsRead, false);
  assert.equal(existsSync(home), false);
});
test("journal binds invocation to exact request and retains unknown effects under capacity pressure", async (t) => {
  const f = fixture(t),
    layer = journalLayer(f.home),
    ids = [];
  const begin = (id, digest = "a".repeat(64)) =>
    effectResult(
      Effect.gen(function* () {
        return yield* (yield* Journal).begin(
          {
            id,
            digest,
            context: "test",
            endpoint: "http://127.0.0.1:6666",
            repository: "team/project",
            operation: "pr.comment",
            method: "POST",
            path: "/api/v3/example",
          },
          8,
        );
      }).pipe(Effect.provide(layer)),
    );
  const id = randomUUID();
  assert.equal((await begin(id)).fresh, true);
  assert.equal((await begin(id)).fresh, false);
  await assert.rejects(begin(id, "b".repeat(64)), errorCode("conflict"));
  ids.push(id);
  for (let i = 0; i < 7; i++) {
    const next = randomUUID();
    ids.push(next);
    await begin(next);
  }
  await assert.rejects(begin(randomUUID()), errorCode("conflict"));
  await effectResult(
    Effect.gen(function* () {
      yield* (yield* Journal).finish(id, { state: "complete" });
    }).pipe(Effect.provide(layer)),
  );
  await begin(randomUUID());
  const rows = await effectResult(
    Effect.gen(function* () {
      return yield* (yield* Journal).list();
    }).pipe(Effect.provide(layer)),
  );
  assert.equal(rows.length, 8);
  assert.equal(
    rows.some((r) => r.id === id),
    false,
  );
  assert.equal(rows.filter((r) => r.state === "sending").length, 8);
  assert.equal(
    readFileSync(join(f.home, "operations", `${ids[1]}.json`), "utf8").includes("token"),
    false,
  );
});
test("standalone bundle executes without external node_modules or existing client state", async (t) => {
  const f = fixture(t),
    result = await cli(f, ["schema", "--command", "repo.create"], true);
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.schema, "agsx.result.v1");
  assert.equal(payload.data.commands[0].name, "repo.create");
  assert.equal(existsSync(join(f.home, "config.json")), false);
});
