import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture } from "./helpers.mjs";

const candidate = resolve(".test-build/candidate");
const metadata = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8"));

// Test the real consumer path, not an application-owned replacement installer.
test("npm pack and global install produce an independent CLI without lifecycle hooks", (t) => {
  const f = fixture(t);
  const packed = spawnSync(
    "npm",
    ["pack", candidate, "--json", "--ignore-scripts", "--pack-destination", f.root],
    { encoding: "utf8", timeout: 30000 },
  );
  assert.equal(packed.status, 0, packed.stderr);
  const record = JSON.parse(packed.stdout)[0];
  const files = record.files.map((file) => file.path);
  assert.ok(files.includes("dist/cli.js"));
  assert.ok(files.includes("dist/credential-helper.js"));
  assert.ok(files.includes("THIRD-PARTY-NOTICES.txt"));
  assert.ok(files.every((path) => !/^(?:src|test|node_modules|\.git|\.agsx)\//.test(path)));
  assert.equal(metadata.name, "@yoyooyoooyoooo/agsx");
  assert.equal(metadata.private, undefined);
  assert.equal(metadata.scripts, undefined);
  assert.equal(metadata.dependencies, undefined);
  const prefix = join(f.root, "npm");
  const installed = spawnSync(
    "npm",
    [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(f.root, record.filename),
    ],
    { encoding: "utf8", timeout: 30000 },
  );
  assert.equal(installed.status, 0, installed.stderr);
  const command = join(prefix, "bin/agsx");
  const version = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 5000 });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), metadata.version);
  const result = spawnSync(command, ["schema"], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const names = JSON.parse(result.stdout).data.commands.map((command) => command.name);
  assert.ok(names.includes("association.collect"));
  assert.ok(names.every((name) => !/^(?:package|release|upgrade|version)\./.test(name)));
  assert.ok(!existsSync(join(f.root, ".agsx/installation")));
});

test("retired package management is rejected rather than silently retained", (t) => {
  const f = fixture(t);
  for (const command of [
    "package.install",
    "package.verify",
    "package.inspect",
    "release",
    "upgrade",
  ]) {
    const result = spawnSync(process.execPath, [join(candidate, "dist/cli.js"), command], {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, AGSX_HOME: f.home },
    });
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(result.stdout).error.code, "invalid_input");
  }
});
