import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Effect, Exit, Cause } from "effect";
import { NodeHttpLive, HttpTransport } from "../dist/platform/http.js";
import { ProcessRunner, processLayer } from "../dist/platform/process.js";
import { server, fixture, effectResult, send } from "./helpers.mjs";

const request = (input) =>
  Effect.gen(function* () {
    return yield* (yield* HttpTransport).request(input);
  }).pipe(Effect.provide(NodeHttpLive));
test("HTTP redirects do not forward Bearer credentials or replay write methods", async (t) => {
  let leaked = 0;
  const other = await server(t, (r, res) => {
    leaked++;
    send(res, 200, {});
  });
  const source = await server(t, (r, res) => {
    res.writeHead(307, { location: other.endpoint + "/stolen" });
    res.end();
  });
  await assert.rejects(
    effectResult(
      request({
        endpoint: source.endpoint,
        path: "/original",
        method: "POST",
        credential: "fixture-secret",
        body: { test: true },
      }),
    ),
    (e) => e.code === "conflict" && e.stage === "http_redirect",
  );
  assert.equal(source.requests.length, 1);
  assert.equal(leaked, 0);
});
test("body limits, interrupted responses and timeouts classify reads versus uncertain writes", async (t) => {
  const s = await server(t, (r, res) => {
    if (r.path === "/large") return send(res, 200, { body: "x".repeat(10000) });
    if (r.path === "/cut") {
      res.writeHead(200, { "content-length": "1000" });
      res.write("short");
      return setTimeout(() => res.destroy(), 10);
    }
    // No response: intentionally test wall-clock timeout.
  });
  await assert.rejects(
    effectResult(request({ endpoint: s.endpoint, path: "/large", method: "GET", maxBytes: 1024 })),
    (e) => e.code === "unavailable",
  );
  await assert.rejects(
    effectResult(request({ endpoint: s.endpoint, path: "/cut", method: "GET" })),
    (e) => e.code === "unavailable",
  );
  await assert.rejects(
    effectResult(
      request({ endpoint: s.endpoint, path: "/hang", method: "POST", body: {}, timeoutMs: 60 }),
    ),
    (e) => e.code === "outcome_unknown",
  );
  assert.equal(s.requests.filter((x) => x.path === "/hang").length, 1);
});
test("cancelling a hanging request releases the socket instead of leaving background I/O", async (t) => {
  let closed = false;
  const s = await server(t, (r, res, req) => {
    res.on("close", () => {
      closed = true;
    });
  });
  const controller = new AbortController();
  const pending = Effect.runPromiseExit(
    request({ endpoint: s.endpoint, path: "/hang", method: "GET", timeoutMs: 10000 }),
    { signal: controller.signal },
  );
  await new Promise((r) => setTimeout(r, 30));
  controller.abort();
  const exit = await pending;
  assert.equal(Exit.isFailure(exit), true);
  assert.equal(Cause.hasInterruptsOnly(exit.cause), true);
  for (let i = 0; i < 20 && !closed; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(closed, true);
});
test("HTTP proxy selection is explicit and uses the original target Host", async (t) => {
  let target;
  const s = await server(t, (r, res) => {
    target = { path: r.path, host: r.headers.host, auth: r.headers.authorization };
    send(res, 200, { proxied: true });
  });
  const result = await effectResult(
    request({
      endpoint: "http://primary.example.test:6666",
      path: "/api/v3/user",
      method: "GET",
      proxy: s.endpoint,
      credential: "fixture",
    }),
  );
  assert.equal(result.status, 200);
  assert.equal(target.host, "primary.example.test:6666");
  assert.equal(target.auth, "Bearer fixture");
});
test("subprocesses receive no ambient credentials and cannot spawn shell fragments", async (t) => {
  const f = fixture(t),
    layer = processLayer({
      ...f.env,
      GH_TOKEN: "must-not-leak",
      MULTICA_TOKEN: "must-not-leak",
      AWS_SECRET_ACCESS_KEY: "must-not-leak",
      NODE_OPTIONS: "--invalid-injected-flag",
    });
  const result = await effectResult(
    Effect.gen(function* () {
      return yield* (yield* ProcessRunner).run({
        command: process.execPath,
        args: [
          "-e",
          "console.log(JSON.stringify({gh:process.env.GH_TOKEN,task:process.env.MULTICA_TOKEN,aws:process.env.AWS_SECRET_ACCESS_KEY,node:process.env.NODE_OPTIONS,args:process.argv.slice(1)}))",
          "$(false); echo bad",
        ],
        cwd: f.cwd,
      });
    }).pipe(Effect.provide(layer)),
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), { args: ["$(false); echo bad"] });
});
test("timeout kills a real subprocess and finalization reaps it", async (t) => {
  const f = fixture(t),
    layer = processLayer(f.env);
  const before = Date.now();
  await assert.rejects(
    effectResult(
      Effect.gen(function* () {
        return yield* (yield* ProcessRunner).run({
          command: process.execPath,
          args: ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
          cwd: f.cwd,
          timeoutMs: 80,
        });
      }).pipe(Effect.provide(layer)),
    ),
    (e) => e.code === "unavailable" && e.stage === "process_timeout",
  );
  assert.ok(Date.now() - before < 5000);
});
test("overflowing subprocess output has a hard bound", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    effectResult(
      Effect.gen(function* () {
        return yield* (yield* ProcessRunner).run({
          command: process.execPath,
          args: ["-e", "process.stdout.write('x'.repeat(1024*1024));setInterval(()=>{},1000)"],
          cwd: f.cwd,
          maxBytes: 1024,
        });
      }).pipe(Effect.provide(processLayer(f.env))),
    ),
    (e) => e.stage === "process_output",
  );
});
