#!/usr/bin/env node
/** Explicit source-pair acceptance. No implicit live service or private path. */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const index = process.argv.indexOf("--server-checkout");
const selected = index >= 0 ? process.argv[index + 1] : process.env.AGS_COMPAT_SERVER_CHECKOUT;
if (!selected)
  throw new Error(
    "Choose an AGS Fork source checkout explicitly with --server-checkout; no production fallback.",
  );
const server = resolve(selected),
  script = join(server, "scripts/gh-native-acceptance.mjs"),
  candidate = join(root, ".test-build/candidate");
if (!existsSync(script) || !existsSync(join(server, ".git")))
  throw new Error("Selected checkout lacks the official-gh acceptance contract.");
if (!existsSync(join(candidate, "build-manifest.json")))
  throw new Error("Build this companion's standalone candidate first.");
const result = spawnSync(process.execPath, [script, "--companion", candidate], {
  cwd: server,
  stdio: "inherit",
  timeout: 300000,
  env: process.env,
});
if (result.error)
  throw new Error("Joint acceptance could not finish; inspect its scoped process failure.");
process.exitCode = result.status ?? 1;
