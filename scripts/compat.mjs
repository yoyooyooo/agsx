#!/usr/bin/env node
/** Opt-in Linux compatibility acceptance against one immutable public server.
 * Download occurs outside the namespace; server and CLI effects only run in a
 * new user+network namespace with loopback. No fallback to production networking.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = {
  version: "fork-20260924.3",
  source: "91a5cd7ff299950e94e8dbbbce7750512d9878be",
  archiveSha256: "23837f4cc4687ae8f42d7240ae436486429d702d28e1475f80c23425d6bdc781",
  url: "https://github.com/yoyooyooo/agent-git-service/releases/download/fork-20260924.3/ags-fork-20260924.3-linux_amd64.tar.gz",
};
if (process.platform !== "linux" || process.arch !== "x64")
  throw new Error("The pinned real-server fixture is Linux x64 only.");
function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0)
    throw new Error(`${cmd} failed (${result.status}): ${(result.stderr ?? "").slice(0, 500)}`);
  return result.stdout;
}
run("unshare", ["--user", "--map-root-user", "--net", "true"]);
const work = mkdtempSync(join(tmpdir(), "agsx-server-compat-"));
try {
  const archive = join(work, "server.tgz");
  run("curl", [
    "--disable",
    "--fail",
    "--location",
    "--silent",
    "--show-error",
    "--proto",
    "=https",
    "--proto-redir",
    "=https",
    "--max-time",
    "90",
    "--max-filesize",
    "67108864",
    release.url,
    "--output",
    archive,
  ]);
  if (createHash("sha256").update(readFileSync(archive)).digest("hex") !== release.archiveSha256)
    throw new Error("Pinned server asset hash mismatch.");
  const names = run("tar", ["-tzf", archive]).trim().split("\n");
  if (
    !names.every((name) =>
      /^(?:LICENSE|NOTICE|build-info\.json|bin\/(?:gh-server|ags-edge|ags-replication))$/.test(
        name,
      ),
    )
  )
    throw new Error("Unexpected server archive entry.");
  run("tar", ["-xzf", archive, "-C", work]);
  const info = JSON.parse(readFileSync(join(work, "build-info.json"), "utf8"));
  if (info.version !== release.version || info.revision !== release.source)
    throw new Error("Server manifest/source mismatch.");
  const binary = join(work, "bin/gh-server");
  if (
    createHash("sha256").update(readFileSync(binary)).digest("hex") !==
    info.binaries["gh-server"].sha256
  )
    throw new Error("Server executable hash mismatch.");
  const tested = spawnSync(
    "unshare",
    [
      "--user",
      "--map-root-user",
      "--net",
      process.execPath,
      join(root, "scripts/compat-worker.mjs"),
      binary,
      release.source,
    ],
    { cwd: root, encoding: "utf8", timeout: 180000, maxBuffer: 4 * 1024 * 1024 },
  );
  let receipt;
  try {
    receipt = JSON.parse(tested.stdout.trim());
  } catch {
    throw new Error(`Isolated server test did not return a receipt (exit ${tested.status}).`);
  }
  mkdirSync(join(root, ".test-build"), { recursive: true });
  writeFileSync(
    join(root, ".test-build/compatibility.json"),
    JSON.stringify({ ...receipt, release }, null, 2) + "\n",
  );
  console.log(JSON.stringify({ ...receipt, release }));
  if (tested.status !== 0 || !receipt.passed) process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
