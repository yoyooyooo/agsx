#!/usr/bin/env node
/** Invoked only by compat.mjs inside a fresh user/network namespace. */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir, networkInterfaces } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binary = process.argv[2],
  expectedSource = process.argv[3];
if (!binary || !expectedSource || process.platform !== "linux" || process.getuid() !== 0)
  throw new Error("This worker needs the explicitly created private user/network namespace.");
const up = spawnSync("ip", ["link", "set", "lo", "up"], { encoding: "utf8" });
if (up.status !== 0 || Object.keys(networkInterfaces()).some((name) => name !== "lo"))
  throw new Error("Fixture network is not loopback-only; no fallback is allowed.");
const work = mkdtempSync(join(tmpdir(), "agsx-native-acceptance-")),
  home = join(work, "client"),
  serverHome = join(work, "server");
mkdirSync(home, { mode: 0o700 });
mkdirSync(serverHome, { mode: 0o700 });
const token = randomBytes(32).toString("hex"),
  tokenFile = join(work, "fixture.token");
writeFileSync(tokenFile, token, { mode: 0o600 });
const env = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: work,
  LANG: "C.UTF-8",
  NO_PROXY: "*",
  GIT_AUTHOR_NAME: "AGS Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.test",
  GIT_COMMITTER_NAME: "AGS Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.test",
};
const record = {
  schema: "agsx.real-server-acceptance.v1",
  serverSource: expectedSource,
  network: "new user+network namespace, loopback only",
  productionData: false,
  productionCredentials: false,
  checks: [],
  startedAt: new Date().toISOString(),
};
let stage = "start",
  primary,
  lastLog = "";
async function command(executable, args, cwd = work, customEnv = env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: customEnv, stdio: ["pipe", "pipe", "pipe"] });
    const output = [],
      errors = [];
    let total = 0;
    const capture = (target) => (chunk) => {
      total += chunk.length;
      if (total > 8 * 1024 * 1024) {
        child.kill("SIGKILL");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", capture(output));
    child.stderr.on("data", capture(errors));
    child.stdin.end();
    const timeout = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        code,
        stdout: Buffer.concat(output).toString(),
        stderr: Buffer.concat(errors).toString(),
      });
    });
  });
}
async function cli(name, input = {}, cwd = work, accepted = [0]) {
  stage = name;
  const args = [join(root, ".test-build/candidate/dist/cli.js"), name];
  for (const [key, value] of Object.entries(input))
    args.push(
      `--${key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`,
      typeof value === "object" ? JSON.stringify(value) : String(value),
    );
  const result = await command(process.execPath, args, cwd, { ...env, AGSX_HOME: home });
  let body;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    throw new Error(`${name}: expected a single JSON result, got exit ${result.code}`);
  }
  record.checks.push({ command: name, exit: result.code, status: body.status });
  if (!accepted.includes(result.code))
    throw new Error(
      `${name}: exit=${result.code}, error=${body.error?.code ?? "unknown"}, stage=${body.error?.stage ?? "none"}, message=${body.error?.message ?? body.data?.stderr ?? ""}`,
    );
  return body;
}
async function git(args, cwd) {
  const result = await cli("git.run", { args, apply: true }, cwd);
  if (result.data.exitCode !== 0) throw new Error("Git did not complete");
  return result.data.stdout.trim();
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
const portServer = net.createServer();
await new Promise((r) => portServer.listen(0, "127.0.0.1", r));
const port = portServer.address().port;
await new Promise((r) => portServer.close(r));
const endpoint = `http://127.0.0.1:${port}`;
try {
  primary = spawn(binary, [], {
    cwd: serverHome,
    env: {
      ...env,
      PORT: String(port),
      DB_DSN: `sqlite:${join(serverHome, "database.sqlite")}?_foreign_keys=on`,
      GIT_REPO_DIR: join(serverHome, "repos"),
      BASE_URL: endpoint,
      ADMIN_LOGIN: "fixture",
      ADMIN_TOKEN: token,
      LISTEN_MODE: "production",
      ENVIRONMENT: "development",
      ENABLE_WORKFLOW_EXEC: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const consume = (chunk) => {
    lastLog = (lastLog + chunk.toString()).slice(-4096);
  };
  primary.stdout.on("data", consume);
  primary.stderr.on("data", consume);
  primary.on("error", () => {});
  const deadline = Date.now() + 30000;
  let ready;
  while (Date.now() < deadline) {
    if (primary.exitCode !== null) throw new Error("Fixture primary exited during startup");
    try {
      const r = await fetch(endpoint + "/readyz", { signal: AbortSignal.timeout(1000) });
      if (r.ok) {
        ready = await r.json();
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  assert(
    ready?.status === "ready" && ready.version === expectedSource,
    "Pinned primary did not become ready",
  );
  await cli("context.add", {
    name: "fixture",
    configuration: { endpoint, instanceId: "isolated" },
    apply: true,
  });
  await cli("context.use", { name: "fixture", apply: true });
  const auth = await cli("auth.import", {
    context: "fixture",
    kind: "human",
    file: tokenFile,
    apply: true,
  });
  const login = auth.data.identity.principal.login,
    repo = `${login}/client-acceptance`;
  await cli("auth.status");
  const created = await cli("repo.create", {
    repo,
    defaultBranch: "main",
    visibility: "private",
    readme: true,
    apply: true,
  });
  assert(created.data.result.repository.full_name === repo, "Real repository identity differs");
  await cli("repo.view", { repo });
  await cli("repo.verify", { repo });
  const checkout = join(work, "checkout"),
    url = `${endpoint}/${repo}.git`;
  await git(["clone", url, checkout], work);
  await git(["switch", "-c", "feature"], checkout);
  writeFileSync(join(checkout, "feature.txt"), "feature\n");
  await git(["add", "feature.txt"], checkout);
  await git(["commit", "-m", "feature commit"], checkout);
  const head = await git(["rev-parse", "HEAD"], checkout);
  await git(["push", "origin", "HEAD:refs/heads/feature"], checkout);
  const opened = await cli(
    "pr.create",
    {
      repo,
      head: "feature",
      base: "main",
      title: "Independent client acceptance",
      expectedHead: head,
      apply: true,
    },
    checkout,
  );
  const number = opened.data.result.pull.number;
  assert(Number.isInteger(number), "Real PR number missing");
  await cli("pr.list", { repo }, checkout);
  await cli("pr.status", { repo }, checkout);
  await cli("pr.view", { repo, number }, checkout);
  await cli(
    "pr.edit",
    { repo, number, expectedHead: head, title: "Independent client accepted", apply: true },
    checkout,
  );
  await cli(
    "pr.comment",
    { repo, number, body: "A disposable native-server comment", apply: true },
    checkout,
  );
  await cli(
    "pr.review",
    {
      repo,
      number,
      expectedHead: head,
      event: "COMMENT",
      body: "Comment-only self review",
      apply: true,
    },
    checkout,
  );
  await cli("pr.reviews", { repo, number }, checkout);
  await cli("pr.close", { repo, number, expectedHead: head, apply: true }, checkout);
  await cli("pr.reopen", { repo, number, expectedHead: head, apply: true }, checkout);
  // No provider was configured. Unsupported must be explicit, not false success.
  const ci = await cli("ci.checks", { repo, number }, checkout, [3, 8]);
  assert(["error", "pending"].includes(ci.status), "Pure AGS CI absence was silently accepted");
  await cli(
    "pr.merge",
    { repo, number, expectedHead: head, method: "merge", apply: true },
    checkout,
    [3],
  );
  await git(["switch", "main"], checkout);
  writeFileSync(join(checkout, "base.txt"), "base advances independently\n");
  await git(["add", "base.txt"], checkout);
  await git(["commit", "-m", "advance base"], checkout);
  const baseHead = await git(["rev-parse", "HEAD"], checkout);
  await git(["push", "origin", "HEAD:refs/heads/main"], checkout);
  const beforeRebase = await cli("pr.view", { repo, number }, checkout);
  assert(beforeRebase.data.head.sha === head, "PR source unexpectedly changed");
  const rebased = await cli(
    "pr.update-branch",
    { repo, number, expectedHead: head, rebase: true, apply: true },
    checkout,
  );
  assert(
    rebased.data.changed === true && rebased.data.atomicRefPrecondition === "force-with-lease",
    "Real rebase did not use an atomic ref lease",
  );
  await git(["fetch", "origin"], checkout);
  const ancestry = await command(
    "/usr/bin/git",
    ["merge-base", "--is-ancestor", baseHead, "origin/feature"],
    checkout,
  );
  assert(ancestry.code === 0, "Rebased head does not contain the advanced base");
  const check = await command("/usr/bin/git", ["fsck", "--strict", "--no-reflogs"], checkout);
  assert(check.code === 0, "Real Git object integrity failed");
  await cli(
    "context.add",
    {
      name: "duplicate-route",
      configuration: { endpoint, instanceId: "not-allowed" },
      apply: true,
    },
    work,
    [3],
  );
  record.passed = true;
  record.repositoryCount = 1;
  record.pullCount = 1;
  record.gitIntegrity = "ok";
  record.rebaseLeaseVerified = true;
  record.providerConfigured = false;
  record.notClaimed = [
    "live fleet rollout",
    "Multica/Forgejo production integration",
    "native merge without an atomic expected-head server contract",
  ];
} catch (error) {
  record.passed = false;
  record.failedStage = stage;
  record.error = String(error.message).split(token).join("[REDACTED]").slice(0, 900);
  // Only disposable fixture output, redacted and bounded; never retained beyond the failure record.
  if (stage === "start")
    record.fixtureStartupError = lastLog.split(token).join("[REDACTED]").slice(-1200);
} finally {
  if (primary && primary.exitCode === null) {
    try {
      process.kill(-primary.pid, "SIGTERM");
    } catch {}
    await Promise.race([
      new Promise((r) => primary.once("close", r)),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
    if (primary.exitCode === null) {
      try {
        process.kill(-primary.pid, "SIGKILL");
      } catch {}
      await new Promise((r) => primary.once("close", r));
    }
  }
  rmSync(work, { recursive: true, force: true });
  record.temporaryDataRemoved = true;
  record.finishedAt = new Date().toISOString();
}
process.stdout.write(JSON.stringify(record) + "\n");
process.exitCode = record.passed ? 0 : 1;
