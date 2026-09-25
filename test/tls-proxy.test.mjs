import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import http from "node:http";
import net from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { HttpTransport, NodeHttpLive } from "../dist/platform/http.js";
import { fixture, child, effectResult } from "./helpers.mjs";
const request = (input) =>
  effectResult(
    Effect.gen(function* () {
      return yield* (yield* HttpTransport).request(input);
    }).pipe(Effect.provide(NodeHttpLive)),
  );
test("explicit CA and HTTPS CONNECT preserve TLS verification and target-bound authentication", async (t) => {
  const f = fixture(t),
    key = join(f.root, "key.pem"),
    cert = join(f.root, "cert.pem");
  const created = await child(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      key,
      "-out",
      cert,
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ],
    { cwd: f.cwd, env: f.env },
  );
  assert.equal(created.code, 0, created.stderr);
  let seen;
  const target = https.createServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    (req, res) => {
      seen = req.headers.authorization;
      res.setHeader("content-type", "application/json");
      res.end('{"secure":true}');
    },
  );
  let secureConnections = 0;
  target.on("secureConnection", () => secureConnections++);
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  t.after(async () => {
    target.closeAllConnections();
    await new Promise((r) => target.close(r));
  });
  const endpoint = `https://127.0.0.1:${target.address().port}`;
  await assert.rejects(
    request({ endpoint, path: "/", method: "GET" }),
    (e) => e.code === "unavailable",
  );
  assert.equal(
    (
      await request({
        endpoint,
        path: "/",
        method: "GET",
        caFile: cert,
        credential: "direct-fixture",
      })
    ).body.secure,
    true,
  );
  const sockets = new Set();
  let connectHeaders;
  const proxy = http.createServer();
  proxy.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  proxy.on("connect", (req, socket, head) => {
    connectHeaders = req.headers;
    const remote = net.connect(target.address().port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) remote.write(head);
      socket.pipe(remote);
      remote.pipe(socket);
    });
    remote.on("error", () => socket.destroy());
    socket.on("error", () => remote.destroy());
    socket.on("close", () => remote.destroy());
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => proxy.close(r));
  });
  const before = secureConnections;
  const result = await request({
    endpoint,
    path: "/api/v3/user",
    method: "GET",
    caFile: cert,
    proxy: `http://127.0.0.1:${proxy.address().port}`,
    credential: "proxy-fixture",
    timeoutMs: 2000,
  });
  assert.equal(result.body.secure, true);
  assert.equal(seen, "Bearer proxy-fixture");
  assert.equal(connectHeaders.authorization, undefined);
  assert.equal(
    secureConnections - before,
    1,
    "The actual request must use the CONNECT tunnel, not open a parallel direct connection.",
  );
});
