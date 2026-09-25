import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fixture, configure, call, child, TOKEN } from "./helpers.mjs";
import { credentialReply } from "../dist/credential-helper.js";

export async function gitFixture(t) {
  const f = fixture(t),
    repos = join(f.root, "repos"),
    bare = join(repos, "team/project.git"),
    seed = join(f.root, "seed");
  mkdirSync(join(repos, "team"), { recursive: true });
  mkdirSync(seed);
  const git = async (args, cwd = seed) => {
    const r = await child("/usr/bin/git", args, { cwd, env: f.env });
    assert.equal(r.code, 0, r.stderr);
    return r.stdout.trim();
  };
  await git(["init", "--bare", bare]);
  await git(["--git-dir", bare, "config", "http.receivepack", "true"]);
  await git(["init", "--initial-branch=main"]);
  writeFileSync(join(seed, "README.md"), "initial\n");
  await git(["add", "."]);
  await git(["commit", "-m", "initial"]);
  await git(["remote", "add", "origin", bare]);
  await git(["push", "origin", "main"]);
  await git(["--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main"]);
  let bytes = 0;
  const calls = [];
  const http = createServer(async (req, res) => {
    calls.push({ method: req.method, path: req.url, auth: req.headers.authorization });
    if (req.url === "/api/v3/user") {
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.statusCode = 401;
        return res.end("{}");
      }
      return res.end('{"id":1,"login":"fixture","user_kind":"human"}');
    }
    const expected = `Basic ${Buffer.from(`token:${TOKEN}`).toString("base64")}`;
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { "WWW-Authenticate": "Basic realm=agsx-test" });
      return res.end("authentication required");
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const data = Buffer.concat(chunks);
    bytes += data.length;
    const u = new URL(req.url, "http://fixture"),
      p = spawn("/usr/bin/git", ["http-backend"], {
        env: {
          ...f.env,
          GIT_PROJECT_ROOT: repos,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: u.pathname,
          QUERY_STRING: u.search.slice(1),
          REQUEST_METHOD: req.method,
          CONTENT_TYPE: req.headers["content-type"] ?? "",
          CONTENT_LENGTH: String(data.length),
          REMOTE_USER: "fixture",
          SERVER_PROTOCOL: "HTTP/1.1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
    const out = [];
    p.stdout.on("data", (c) => out.push(c));
    p.stderr.resume();
    p.on("error", () => {
      res.statusCode = 500;
      res.end();
    });
    p.on("close", () => {
      const body = Buffer.concat(out);
      let index = body.indexOf("\r\n\r\n"),
        skip = 4;
      if (index < 0) {
        index = body.indexOf("\n\n");
        skip = 2;
      }
      if (index < 0) {
        res.statusCode = 500;
        return res.end();
      }
      const headers = body.subarray(0, index).toString().split(/\r?\n/);
      for (const line of headers) {
        const i = line.indexOf(":");
        if (i < 0) continue;
        const key = line.slice(0, i),
          v = line.slice(i + 1).trim();
        if (key.toLowerCase() === "status") res.statusCode = Number(v.split(" ")[0]);
        else res.setHeader(key, v);
      }
      res.end(body.subarray(index + skip));
    });
    p.stdin.end(data);
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  t.after(async () => {
    http.closeAllConnections();
    await new Promise((r) => http.close(r));
  });
  const endpoint = `http://127.0.0.1:${http.address().port}`;
  configure(f, endpoint);
  return { ...f, repos, bare, seed, git, endpoint, calls, bytes: () => bytes };
}

test("real smart HTTP Git clone, commit, push and fetch preserve exact origin credentials", async (t) => {
  const f = await gitFixture(t),
    checkout = join(f.cwd, "clone"),
    url = f.endpoint + "/team/project.git",
    marker = join(f.root, "bad-helper-invoked");
  const original = `[credential "${url}"]\n helper = !/usr/bin/touch ${marker}\n[http "${url}"]\n extraHeader = Authorization: Basic deliberately-wrong\n`;
  writeFileSync(join(f.root, ".gitconfig"), original, { mode: 0o600 });
  const clone = await call(f, "git.run", { args: ["clone", url, checkout], apply: true });
  assert.equal(clone.exitCode, 0, JSON.stringify(clone));
  assert.equal(existsSync(marker), false);
  assert.equal(readFileSync(join(checkout, "README.md"), "utf8"), "initial\n");
  const local = { ...f, cwd: checkout };
  writeFileSync(join(checkout, "README.md"), "updated through new client\n");
  await call(local, "git.run", { args: ["add", "README.md"], apply: true });
  const commit = await call(local, "git.run", {
    args: ["commit", "-m", "new client fixture"],
    apply: true,
  });
  assert.equal(commit.exitCode, 0, JSON.stringify(commit));
  const id = randomUUID(),
    request = { args: ["push", "origin", "HEAD:refs/heads/main"], invocation: id, apply: true };
  const pushed = await call(local, "git.run", request);
  assert.equal(pushed.exitCode, 0, JSON.stringify(pushed));
  const before = f.calls.filter((c) => c.path.endsWith("git-receive-pack")).length;
  const duplicate = await call(local, "git.run", request);
  assert.equal(duplicate.result.data.alreadyCompleted, true);
  assert.equal(f.calls.filter((c) => c.path.endsWith("git-receive-pack")).length, before);
  const remoteHead = await f.git(["--git-dir", f.bare, "rev-parse", "refs/heads/main"]),
    localHead = await f.git(["rev-parse", "HEAD"], checkout);
  assert.equal(remoteHead, localHead);
  assert.equal(
    (await call(local, "git.run", { args: ["fetch", "origin"], apply: true })).exitCode,
    0,
  );
  assert.equal(
    (
      await call(local, "git.run", { args: ["ls-remote", url, "refs/heads/main"] })
    ).result.data.stdout.split("\t")[0],
    localHead,
  );
  assert.ok(f.bytes() > 100);
  assert.equal(readFileSync(join(f.root, ".gitconfig"), "utf8"), original);
  assert.equal(existsSync(marker), false);
  assert.equal(JSON.stringify(pushed).includes(TOKEN), false);
});
test("credential helper never returns credentials for another host or repository", (t) => {
  const f = fixture(t),
    file = join(f.root, "envelope.json");
  writeFileSync(
    file,
    JSON.stringify({
      schema: "agsx.git-credential.v1",
      origin: "https://primary.example.test",
      repository: "team/project",
      token: TOKEN,
    }),
    { mode: 0o600 },
  );
  assert.equal(
    credentialReply("get", "protocol=https\nhost=evil.example.test\npath=team/project.git\n", file),
    "",
  );
  assert.equal(
    credentialReply(
      "get",
      "protocol=https\nhost=primary.example.test\npath=other/project.git\n",
      file,
    ),
    "",
  );
  assert.ok(
    credentialReply(
      "get",
      "protocol=https\nhost=primary.example.test\npath=team/project.git\n",
      file,
    ).includes(TOKEN),
  );
  assert.equal(credentialReply("store", "", file), "");
});
test("unsafe remote overrides, arbitrary executable flags and credential-bearing URLs are rejected", async (t) => {
  const f = fixture(t);
  configure(f, "http://127.0.0.1:6666");
  await assert.rejects(
    call(f, "git.run", {
      args: ["clone", "http://user:password@127.0.0.1:6666/team/project.git", "out"],
      apply: true,
    }),
  );
  await assert.rejects(call(f, "git.run", { args: ["push", "another", "HEAD"], apply: true }));
  await assert.rejects(call(f, "git.run", { args: ["log", "--exec=/bin/echo"] }));
  await assert.rejects(
    call(f, "git.run", { args: ["commit", "-ccredential.helper=evil"], apply: true }),
  );
});
test("bootstrap is explicit, session-local and refuses foreign shim content", async (t) => {
  const f = fixture(t),
    plan = await call(f, "git.bootstrap");
  assert.equal(plan.result.status, "planned");
  assert.equal(existsSync(join(f.home, "shims")), false);
  const applied = await call(f, "git.bootstrap", { apply: true });
  assert.equal(applied.result.data.globalPathChanged, false);
  assert.equal(applied.result.data.gitConfigurationChanged, false);
  writeFileSync(join(f.home, "shims", "git"), "foreign", { mode: 0o700 });
  await assert.rejects(call(f, "git.bootstrap", { apply: true }), (e) => e.code === "conflict");
});
