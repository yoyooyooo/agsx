import { mkdtempSync, mkdirSync, rmSync, chmodSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { Effect, Exit, Cause, Layer } from "effect";
import { program } from "../dist/application/app.js";
import { settingsLayer } from "../dist/platform/store.js";
import { ProcessRunner } from "../dist/platform/process.js";
import { HttpTransport } from "../dist/platform/http.js";
export function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agsx-companion-test-")));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"),
    cwd = join(root, "work");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(cwd, { mode: 0o700 });
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    NO_PROXY: "*",
    LANG: "C",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.test",
  };
  return { root, home, cwd, env };
}
export async function effectResult(effect) {
  const result = await Effect.runPromiseExit(effect);
  if (Exit.isFailure(result)) throw Cause.squash(result.cause);
  return result.value;
}
export const provided = (f, effect, transport, processes) =>
  effectResult(
    Effect.scoped(effect).pipe(
      Effect.provide(
        Layer.mergeAll(
          settingsLayer(f),
          Layer.succeed(HttpTransport, { request: transport }),
          Layer.succeed(ProcessRunner, { run: processes }),
        ),
      ),
    ),
  );
export async function call(f, name, input = {}) {
  const args = [name];
  for (const [key, value] of Object.entries(input))
    if (value !== undefined)
      args.push(
        `--${key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`,
        typeof value === "object" ? JSON.stringify(value) : String(value),
      );
  return effectResult(program(args, f));
}
export async function child(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], ...options }),
      out = [],
      err = [];
    const timer = setTimeout(() => p.kill("SIGKILL"), 20000);
    p.stdout.on("data", (x) => out.push(x));
    p.stderr.on("data", (x) => err.push(x));
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out).toString(),
        stderr: Buffer.concat(err).toString(),
      });
    });
    p.stdin.on("error", () => {});
    p.stdin.end(options.input);
  });
}
export const cli = (f, args, standalone = false) =>
  child(
    process.execPath,
    [resolve(standalone ? ".test-build/candidate/dist/cli.js" : "dist/cli.js"), ...args],
    { cwd: f.cwd, env: { ...f.env, AGSX_HOME: f.home } },
  );
export function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}
export async function server(t, handle) {
  const requests = [];
  const s = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = Object.fromEntries(new URLSearchParams(raw));
    }
    const request = {
      method: req.method,
      path: new URL(req.url, "http://example.test").pathname,
      query: new URL(req.url, "http://example.test").searchParams,
      headers: req.headers,
      body,
      raw,
    };
    requests.push(request);
    try {
      await handle(request, res, req);
    } catch {
      if (!res.headersSent) send(res, 500, { error: "fixture failed" });
      else res.destroy();
    }
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(async () => {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  });
  return { endpoint: `http://127.0.0.1:${s.address().port}`, server: s, requests };
}
