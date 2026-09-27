#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as bundle } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const task = process.argv[2] ?? "check";
const hash = (value) => createHash("sha256").update(value).digest("hex");
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "test" },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
function git(...args) {
  const repository = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: root,
    encoding: "utf8",
  });
  if (repository.status !== 0 || resolve(repository.stdout.trim()) !== root) return null;
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}
function scan(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? scan(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}
function boundary() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (pkg.private !== true)
    throw new Error(
      "The catalog development workspace is private; npm publishes the bundled package.",
    );
  for (const [name, version] of Object.entries(pkg.workspaces.catalog)) {
    if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version))
      throw new Error(`Catalog is not exact: ${name}`);
    const installed = JSON.parse(
      readFileSync(join(root, "node_modules", name, "package.json"), "utf8"),
    );
    if (installed.version !== version)
      throw new Error(`Installed dependency differs from catalog: ${name}`);
  }
  for (const path of scan(join(root, "src"))) {
    const source = readFileSync(path, "utf8");
    if (/from\s+["'](?:bun|bun:)/.test(source) || /Bun\./.test(source))
      throw new Error("Bun is dependency installation only.");
    if (/mini\.tail|imile-win\.tail|\/Users\/yoyo|\/home\/box|\.ak\/ags|f763231d/.test(source))
      throw new Error("Personal deployment fact in reusable code.");
    if (/libexec\/ags-gh|node_modules\/.*agent-kit/.test(source))
      throw new Error("Legacy binary or monorepo coupling was reintroduced.");
  }
  for (const retired of [
    "src/git-shim.ts",
    "src/application/pulls.ts",
    "src/application/git.ts",
    "src/application/identity.ts",
    "src/operator/operator.ts",
  ])
    if (existsSync(join(root, retired)))
      throw new Error("Retired command/shim product surface reintroduced: " + retired);
  for (const name of ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"])
    if (existsSync(join(root, name))) throw new Error("Bun must own the only dependency lock.");
  console.log(
    "architecture: exact catalogs, Node-only runtime, isolated state/public examples, no legacy engine",
  );
}
function compile() {
  rmSync(join(root, "dist"), { recursive: true, force: true });
  run(process.execPath, ["node_modules/typescript/bin/tsc"]);
}
async function standalone() {
  const directory = join(root, ".test-build", "candidate");
  // Build-owned output only. Never remove an installed package or user state.
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(join(directory, "dist"), { recursive: true });
  const bundled = await bundle({
    metafile: true,
    entryPoints: {
      cli: join(root, "src/cli.ts"),
      "credential-helper": join(root, "src/credential-helper.ts"),
    },
    outdir: join(directory, "dist"),
    bundle: true,
    splitting: true,
    platform: "node",
    format: "esm",
    target: "node22",
    legalComments: "eof",
    logLevel: "warning",
    banner: {
      js: "import { createRequire as __agsxCreateRequire } from 'node:module'; const require = __agsxCreateRequire(import.meta.url);",
    },
  });
  const bundledPackages = new Map();
  for (const input of Object.keys(bundled.metafile.inputs)) {
    if (!input.includes("node_modules/")) continue;
    let dir = dirname(resolve(root, input));
    while (dir !== root && dirname(dir) !== dir) {
      const metadata = join(dir, "package.json");
      if (existsSync(metadata)) {
        const p = JSON.parse(readFileSync(metadata, "utf8"));
        if (p.name && p.version) {
          bundledPackages.set(dir, p);
          break;
        }
      }
      dir = dirname(dir);
    }
  }
  const notices = [];
  for (const [dir, pkg] of bundledPackages) {
    const file = [
      "LICENSE",
      "LICENSE.md",
      "LICENSE.txt",
      "license",
      "license.md",
      "license.txt",
      "License",
    ]
      .map((n) => join(dir, n))
      .find(existsSync);
    if (!file) throw new Error(`Bundled package lacks a retained license: ${pkg.name}`);
    notices.push(`${pkg.name}@${pkg.version}\n${"=".repeat(72)}\n${readFileSync(file, "utf8")}\n`);
  }
  writeFileSync(join(directory, "THIRD-PARTY-NOTICES.txt"), notices.join("\n"));
  const original = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const metadata = {
    name: original.name,
    version: original.version,
    description: original.description,
    publishConfig: { access: "public", registry: "https://registry.npmjs.org" },
    type: "module",
    license: original.license,
    engines: original.engines,
    bin: original.bin,
    agsx: original.agsx,
  };
  writeFileSync(join(directory, "package.json"), JSON.stringify(metadata, null, 2) + "\n");
  for (const name of [
    "LICENSE",
    "NOTICE",
    "README.md",
    "SECURITY.md",
    "docs/architecture.md",
    "docs/commands.md",
    "docs/protocol.md",
    "docs/feature-parity.md",
    "examples/setup.example.json",
    "examples/session.example.json",
  ]) {
    if (!existsSync(join(root, name))) throw new Error(`Missing distribution file ${name}`);
    mkdirSync(dirname(join(directory, name)), { recursive: true });
    writeFileSync(join(directory, name), readFileSync(join(root, name)));
  }
  const files = {};
  for (const path of scan(directory)) {
    const bytes = readFileSync(path);
    files[path.slice(directory.length + 1)] = { sha256: hash(bytes), bytes: bytes.length };
  }
  const dependencies = Object.fromEntries(
    Object.entries(original.dependencies).map(([name]) => [
      name,
      JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")).version,
    ]),
  );
  const manifest = {
    schema: "agsx.build.v1",
    package: original.name,
    version: original.version,
    source: { commit: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain") !== "" },
    runtime: "node",
    nodeMinimum: "22.18.0",
    dependencies,
    files,
  };
  writeFileSync(join(directory, "build-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    `bundle: ${Object.keys(files).length} files, ${Object.values(files).reduce((sum, f) => sum + f.bytes, 0)} bytes; no native gh binary`,
  );
}
function test() {
  const tests = scan(join(root, "test")).filter((p) => p.endsWith(".test.mjs"));
  if (!tests.length) throw new Error("No tests found");
  run(process.execPath, ["--test", "--test-concurrency=1", ...tests]);
}
if (
  ![
    "check",
    "build",
    "bundle",
    "test",
    "typecheck",
    "boundary",
    "format",
    "format-check",
    "compat",
  ].includes(task)
)
  throw new Error("Unknown development task");
if (task === "format" || task === "format-check")
  run(process.execPath, [
    "node_modules/prettier/bin/prettier.cjs",
    task === "format" ? "--write" : "--check",
    "src",
    "test",
    "scripts",
    "docs",
    "examples",
    ".github",
    "README.md",
    "AGENTS.md",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "package.json",
    "tsconfig.json",
    ".prettierrc.json",
  ]);
if (task === "check" || task === "boundary") boundary();
if (task === "typecheck") run(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit"]);
if (["check", "build", "test", "bundle", "compat"].includes(task)) compile();
if (["check", "build", "bundle", "test", "compat"].includes(task)) await standalone();
if (["check", "test"].includes(task)) test();
if (task === "compat") run(process.execPath, ["scripts/compat.mjs"]);
