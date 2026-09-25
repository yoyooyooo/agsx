import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { Effect, Exit, Cause } from "effect";
import { program } from "../dist/application/app.js";
export const HEAD = "a".repeat(40),
  BASE = "b".repeat(40),
  TOKEN = "fixture-human-credential";
export function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "agsx-test-"));
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
export function configure(f, endpoint, changes = {}) {
  writeFileSync(join(f.home, "token"), TOKEN, { mode: 0o600 });
  const c = {
    endpoint,
    instanceId: "fixture",
    auth: { kind: "human", credential: { file: "token" } },
    ...changes,
  };
  writeFileSync(
    join(f.home, "config.json"),
    JSON.stringify({ schema: "agsx.config.v1", defaultContext: "test", contexts: { test: c } }),
    { mode: 0o600 },
  );
  return c;
}
export async function effectResult(effect) {
  const result = await Effect.runPromiseExit(effect);
  if (Exit.isFailure(result)) throw Cause.squash(result.cause);
  return result.value;
}
export async function invoke(f, name, input = {}) {
  return effectResult(program([name, "--input", "-"], f));
}
export async function call(f, name, input = {}) {
  // Flags exercise the same parser without mutating stdin or the calling process.
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
    const p = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], ...options });
    const out = [],
      err = [];
    p.stdout.on("data", (x) => out.push(x));
    p.stderr.on("data", (x) => err.push(x));
    p.on("error", reject);
    p.on("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(out).toString(),
        stderr: Buffer.concat(err).toString(),
      }),
    );
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
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = Object.fromEntries(new URLSearchParams(raw));
    }
    const request = {
      method: req.method,
      path: new URL(req.url, "http://test").pathname,
      query: new URL(req.url, "http://test").searchParams,
      headers: req.headers,
      body,
      raw,
    };
    requests.push(request);
    try {
      await handle(request, res, req);
    } catch {
      if (!res.headersSent) send(res, 500, { error: "fixture handler failed" });
      else res.destroy();
    }
  });
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  });
  return { endpoint: `http://127.0.0.1:${s.address().port}`, requests, server: s };
}
export async function agsFixture(t, options = {}) {
  const f = fixture(t);
  const state = {
    prs: [],
    comments: [],
    reviews: [],
    writes: 0,
    loseNextWrite: false,
    userKind: options.userKind ?? "human",
    provider: options.provider ?? true,
    requiredFacts: options.requiredFacts ?? true,
    ciState: "success",
    repoExists: true,
  };
  const pr = (number = 1) => ({
    id: number,
    node_id: `PullRequest_${number}`,
    number,
    title: "Example",
    body: "",
    state: "open",
    draft: false,
    merged: false,
    user: { id: 1, login: "fixture" },
    head: { ref: "feature", sha: HEAD, repo: { full_name: "team/project" } },
    base: { ref: "main", sha: BASE, repo: { full_name: "team/project" } },
    external_projections: state.provider
      ? [{ provider: "forgejo", external_repo: "team/project", external_number: 77 }]
      : [],
  });
  state.prs.push(pr());
  const receipt = (number, operation, request) => ({
    schema: "ags.provider-observation-receipt.v1",
    id: "12345678-1234-4123-8123-123456789012",
    repository: "team/project",
    ags_pr: number,
    operation,
    authorization: "allowed",
    provider_attempt: "attempted",
    provider_outcome: "observed",
    recovery_owner: "none",
    provider: {
      kind: "forgejo",
      external_repo: "team/project",
      external_number: 77,
      display_url: "https://ci.example.test/pr/77",
      binding_source: "mapping",
    },
    authentication: { mode: "durable", principal_id: 1, principal_login: "fixture" },
    workload: {},
    observed_at: new Date().toISOString(),
  });
  const http = await server(t, async (r, res) => {
    if (r.path === "/readyz") return send(res, 200, { status: "ready", instance_id: "fixture" });
    if (r.headers.authorization !== `Bearer ${TOKEN}`)
      return send(res, 401, { error: "unauthorized" });
    if (r.path === "/api/v3/user")
      return send(res, 200, { id: 1, login: "fixture", user_kind: state.userKind });
    if (r.method === "POST" && r.path.endsWith("/repos")) {
      if (typeof r.body.auto_init !== "boolean" || Object.hasOwn(r.body, "add_readme"))
        return send(res, 422, { error: "wrong native initialization field" });
      state.writes++;
      state.repoExists = true;
      return send(res, 201, {
        id: 10,
        full_name: `team/${r.body.name}`,
        default_branch: r.body.default_branch,
        private: r.body.private,
      });
    }
    if (r.path === "/api/v3/user/repos" || r.path === "/api/v3/users/team/repos")
      return send(res, 200, [{ id: 10, full_name: "team/project", default_branch: "main" }]);
    const root = "/api/v3/repos/team/project";
    if (r.path === root)
      return state.repoExists
        ? send(res, 200, {
            id: 10,
            full_name: "team/project",
            default_branch: "main",
            private: true,
          })
        : send(res, 404, {});
    if (r.path.startsWith(root + "/git/ref/heads/"))
      return send(res, 200, { ref: "refs/heads/feature", object: { sha: HEAD, type: "commit" } });
    if (r.path === root + "/branches/main")
      return send(res, 200, { name: "main", commit: { sha: BASE } });
    if (r.path === root + "/branches")
      return send(res, 200, [{ name: "main", commit: { sha: BASE } }]);
    if (r.path === root + "/projection/status") return send(res, 200, { refs: [] });
    if (r.path === root + "/pulls") {
      if (r.method === "GET") {
        let rows = state.prs;
        if (r.query.get("head"))
          rows = rows.filter((p) => p.head.ref === r.query.get("head").split(":").at(-1));
        if (r.query.get("base")) rows = rows.filter((p) => p.base.ref === r.query.get("base"));
        return send(res, 200, rows);
      }
      state.writes++;
      const row = {
        ...pr(state.prs.length + 1),
        ...r.body,
        head: { ref: r.body.head, sha: HEAD },
        base: { ref: r.body.base, sha: BASE },
      };
      state.prs.push(row);
      if (state.loseNextWrite) {
        state.loseNextWrite = false;
        return res.destroy();
      }
      return send(res, 201, row);
    }
    const match = r.path.match(/\/pulls\/(\d+)(.*)$/);
    if (match) {
      const number = Number(match[1]),
        tail = match[2],
        pull = state.prs.find((p) => p.number === number);
      if (!pull) return send(res, 404, {});
      if (!tail) {
        if (r.method === "PATCH") {
          state.writes++;
          Object.assign(pull, r.body);
        }
        return send(res, 200, pull);
      }
      if (tail === "/reviews") {
        if (r.method === "GET") return send(res, 200, state.reviews);
        state.writes++;
        const row = { id: state.reviews.length + 1, ...r.body };
        state.reviews.push(row);
        return send(res, 201, row);
      }
      if (tail === "/update-branch") {
        state.writes++;
        return send(res, 202, { message: "updating", url: "https://primary.example.test" });
      }
      if (tail === "/provider/merge") {
        if (r.method === "POST") {
          state.writes++;
          if (r.body.expected_head_sha !== pull.head.sha) return send(res, 409, {});
          pull.merged = true;
          pull.state = "closed";
        }
        return send(res, 200, {
          provider_merged: pull.merged,
          expected_head_sha: pull.head.sha,
          provider_merge_sha: BASE,
        });
      }
      if (tail === "/provider/ci/runs") {
        const run = {
          id: 9,
          name: "CI",
          workflow_id: "ci.yml",
          status: state.ciState,
          event: "pull_request",
          head_sha: pull.head.sha,
          pull_request_number: 77,
          head_branch: "feature",
          html_url: "https://ci.example.test/run/9",
          ...(state.requiredFacts ? { required: true, requirement_source: "server_policy" } : {}),
        };
        return send(res, 200, {
          schema: "ags.provider-ci-evidence.v1",
          repository: "team/project",
          ags_pr: number,
          head_sha: pull.head.sha,
          provider: { kind: "forgejo", external_repo: "team/project", external_number: 77 },
          runs: [run],
          correlation_receipt: receipt(number, "ci.read", r),
        });
      }
      if (tail === "/provider/ci/runs/9/logs")
        return send(res, 200, {
          schema: "ags.provider-ci-run-logs.v1",
          repository: "team/project",
          ags_pr: number,
          run_id: 9,
          text: "test output\n",
          observed_at: new Date().toISOString(),
          correlation_receipt: receipt(number, "ci.read", r),
        });
    }
    const issue = r.path.match(/\/issues\/(\d+)\/comments$/);
    if (issue) {
      if (r.method === "GET") return send(res, 200, state.comments);
      state.writes++;
      const row = { id: state.comments.length + 1, ...r.body };
      state.comments.push(row);
      if (state.loseNextWrite) {
        state.loseNextWrite = false;
        return res.destroy();
      }
      return send(res, 201, row);
    }
    return send(res, 404, {});
  });
  configure(f, http.endpoint, {
    auth: { kind: state.userKind === "human" ? "human" : "service", credential: { file: "token" } },
  });
  return { ...f, ...http, state, pr };
}
