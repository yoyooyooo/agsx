import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, call, child } from "./helpers.mjs";

const candidate = resolve(".test-build/candidate");
test("standalone companion installs one owned slot without adding a gh/git command surface", async (t) => {
  const f = fixture(t),
    prefix = join(f.root, "installed");
  const checked = await call(f, "package.verify", { directory: candidate });
  const digest = checked.result.data.digest;
  const plan = await call(f, "package.install", {
    directory: candidate,
    prefix,
    expectedDigest: digest,
  });
  assert.equal(plan.result.status, "planned");
  assert.ok(!existsSync(prefix));
  const installed = await call(f, "package.install", {
    directory: candidate,
    prefix,
    expectedDigest: digest,
    apply: true,
  });
  assert.equal(installed.result.data.retainedVersions, 1);
  assert.equal(installed.result.data.shellPathChanged, false);
  const again = await call(f, "package.install", {
    directory: candidate,
    prefix,
    expectedDigest: digest,
    apply: true,
  });
  assert.equal(again.result.data.unchanged, true);
  for (const name of ["releases", "current", "previous", "dist/git-shim.js"])
    assert.ok(!existsSync(join(prefix, name)));
  const result = await child(process.execPath, [join(prefix, "dist/cli.js"), "schema"], {
    cwd: f.cwd,
    env: f.env,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).data.commands.length, 12);
  assert.ok(!readdirSync(prefix).some((name) => name.startsWith(".transaction-")));
});
test("unowned destination and changed candidate are not overwritten", async (t) => {
  const f = fixture(t),
    copy = join(f.root, "candidate"),
    prefix = join(f.root, "foreign");
  cpSync(candidate, copy, { recursive: true });
  mkdirSync(prefix, { mode: 0o700 });
  writeFileSync(join(prefix, "keep"), "unchanged");
  const checked = await call(f, "package.verify", { directory: copy });
  await assert.rejects(
    call(f, "package.install", {
      directory: copy,
      prefix,
      expectedDigest: checked.result.data.digest,
      apply: true,
    }),
    (e) => e.code === "conflict",
  );
  assert.equal(readFileSync(join(prefix, "keep"), "utf8"), "unchanged");
  writeFileSync(join(copy, "dist/cli.js"), "unexpected bytes");
  await assert.rejects(
    call(f, "package.verify", { directory: copy }),
    (e) => e.code === "integrity_error",
  );
});
test("interrupted single-slot installation cannot execute a half-installed companion", async (t) => {
  const f = fixture(t),
    prefix = join(f.root, "installed");
  const checked = await call(f, "package.verify", { directory: candidate });
  await call(f, "package.install", {
    directory: candidate,
    prefix,
    expectedDigest: checked.result.data.digest,
    apply: true,
  });
  writeFileSync(
    join(prefix, ".installing.json"),
    JSON.stringify({ schema: "agsx.installing.v1", digest: checked.result.data.digest }),
    { mode: 0o600 },
  );
  const result = await child(process.execPath, [join(prefix, "dist/cli.js"), "schema"], {
    cwd: f.cwd,
    env: f.env,
  });
  assert.equal(result.code, 5);
  assert.equal(JSON.parse(result.stdout).error.stage, "startup");
  await call(f, "package.install", {
    directory: candidate,
    prefix,
    expectedDigest: checked.result.data.digest,
    apply: true,
  });
  assert.ok(!existsSync(join(prefix, ".installing.json")));
});
