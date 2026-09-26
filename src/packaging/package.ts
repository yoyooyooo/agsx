import { Effect } from "effect";
import {
  constants,
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { attempt, invariant, problem, record } from "../domain/errors.js";
import type { Input } from "../domain/commands.js";
import {
  Settings,
  atomicPrivate,
  fingerprint,
  privateBytes,
  privateDirectory,
} from "../platform/store.js";
import { packageRoot } from "../platform/paths.js";

export interface BuildManifest {
  readonly schema: "agsx.build.v1";
  readonly package: string;
  readonly version: string;
  readonly source: { readonly commit: string | null; readonly dirty: boolean };
  readonly files: Readonly<Record<string, { readonly sha256: string; readonly bytes: number }>>;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly runtime: "node";
  readonly nodeMinimum: string;
  readonly releaseState: "unpublished-rebuild";
}
const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
function regular(path: string, limit: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    invariant(
      stat.isFile() && stat.size <= limit && realpathSync(path) === resolve(path),
      "Candidate assets must be bounded, canonical regular files.",
      "integrity_error",
    );
    const data = readFileSync(fd);
    invariant(data.length <= limit, "Candidate grew while being inspected.", "integrity_error");
    return data;
  } finally {
    closeSync(fd);
  }
}
function paths(root: string, dir = root): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const p = join(dir, entry.name);
    invariant(
      !entry.isSymbolicLink(),
      "Package candidates must not contain symlinks.",
      "integrity_error",
    );
    if (entry.isDirectory()) return paths(root, p);
    invariant(
      entry.isFile(),
      "Package candidates must contain only files/directories.",
      "integrity_error",
    );
    return [relative(root, p).split("\\").join("/")];
  });
}
export function verifyCandidate(directory: string): {
  root: string;
  manifest: BuildManifest;
  digest: string;
  bytes: number;
} {
  const root = resolve(directory);
  invariant(
    existsSync(root) &&
      lstatSync(root).isDirectory() &&
      !lstatSync(root).isSymbolicLink() &&
      realpathSync(root) === root,
    "Candidate directory must be canonical.",
    "integrity_error",
  );
  const raw = record(
    JSON.parse(regular(join(root, "build-manifest.json"), 1024 * 1024).toString("utf8")),
  );
  invariant(
    raw.schema === "agsx.build.v1" &&
      raw.runtime === "node" &&
      raw.releaseState === "unpublished-rebuild",
    "Candidate manifest has an unknown schema/runtime.",
    "integrity_error",
  );
  const files = record(raw.files),
    names = Object.keys(files).sort();
  invariant(
    names.length >= 5 &&
      names.length <= 100 &&
      ["dist/cli.js", "dist/credential-helper.js", "package.json", "LICENSE", "NOTICE"].every((n) =>
        Object.hasOwn(files, n),
      ),
    "Candidate is missing required runtime or licensing files.",
    "integrity_error",
  );
  let size = 0;
  for (const name of names) {
    invariant(
      !isAbsolute(name) &&
        name.split("/").every((s) => s !== ".." && s !== "." && s !== "") &&
        !name.includes("\\"),
      "Invalid package asset path.",
      "integrity_error",
    );
    const expected = record(files[name]),
      data = regular(join(root, name), 20 * 1024 * 1024);
    size += data.length;
    invariant(
      size <= 64 * 1024 * 1024 && expected.bytes === data.length && expected.sha256 === hash(data),
      "Candidate asset identity mismatch.",
      "integrity_error",
    );
  }
  const allowed = new Set([...names, "build-manifest.json", ".agsx-install.json"]);
  invariant(
    paths(root).every((n) => allowed.has(n)),
    "Candidate contains unlisted files; it is not a self-contained release directory.",
    "integrity_error",
  );
  const metadata = record(
    JSON.parse(regular(join(root, "package.json"), 128 * 1024).toString("utf8")),
  );
  invariant(
    record(metadata.agsx).schema === "agsx.package.v1" &&
      metadata.version === raw.version &&
      metadata.name === raw.package,
    "Candidate package metadata does not match its manifest.",
    "integrity_error",
  );
  invariant(
    record(raw.dependencies).effect === "4.0.0-beta.107",
    "Candidate Effect version does not match this rebuild's accepted contract.",
    "integrity_error",
  );
  return { root, manifest: raw as unknown as BuildManifest, digest: fingerprint(raw), bytes: size };
}

export const packageCommand = (name: string, input: Input) =>
  Effect.gen(function* () {
    const settings = yield* Settings;
    if (name === "package.inspect")
      return yield* attempt("package_inspect", () => {
        const root = packageRoot(),
          metadata = record(JSON.parse(readFileSync(join(root, "package.json"), "utf8")));
        const manifest = existsSync(join(root, "build-manifest.json"))
          ? verifyCandidate(root)
          : null;
        return {
          name: metadata.name,
          version: metadata.version,
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          standaloneBundle: Boolean(manifest),
          source: manifest?.manifest.source ?? null,
          manifestDigest: manifest?.digest ?? null,
          catalog: record(record(metadata.workspaces ?? {}).catalog ?? {}),
          published: false,
          globalInstallationChanged: false,
        };
      });
    const candidate = yield* attempt("package_verify", () =>
      verifyCandidate(resolve(settings.options.cwd, String(input.directory))),
    );
    if (name === "package.verify")
      return {
        verified: true,
        digest: candidate.digest,
        manifest: candidate.manifest,
        bytes: candidate.bytes,
        signatureVerified: false,
        claim: "Local content identity, not a trusted-publisher signature or publication approval.",
      };
    const prefix = resolve(settings.options.cwd, String(input.prefix));
    yield* attempt("package_install", () =>
      invariant(
        candidate.digest === input.expectedDigest,
        "Candidate changed since verification.",
        "conflict",
      ),
    );
    if (!input.apply)
      return {
        planned: true,
        prefix,
        candidateDigest: candidate.digest,
        bytes: candidate.bytes,
        previousVersionRetained: false,
      };
    return yield* attempt("package_install", () => {
      invariant(
        prefix !== candidate.root &&
          !candidate.root.startsWith(prefix + "/") &&
          !prefix.startsWith(candidate.root + "/"),
        "Candidate and destination may not overlap.",
      );
      privateDirectory(prefix, true);
      const receiptFile = join(prefix, ".agsx-install.json"),
        marker = join(prefix, ".installing.json"),
        lock = join(prefix, ".install.lock");
      const prior = existsSync(receiptFile)
        ? record(JSON.parse(privateBytes(receiptFile).toString("utf8")))
        : undefined;
      const pending = existsSync(marker)
        ? record(JSON.parse(privateBytes(marker).toString("utf8")))
        : undefined;
      if (pending)
        invariant(
          pending.digest === candidate.digest,
          "An interrupted installation must resume its exact candidate.",
          "conflict",
        );
      if (!prior && !pending)
        invariant(
          readdirSync(prefix).length === 0,
          "Refusing to install into a nonempty, unowned directory.",
          "conflict",
        );
      if (prior && !pending) {
        invariant(
          prior.schema === "agsx.install.v1",
          "Destination has an unknown installation owner.",
          "conflict",
        );
        const actual = verifyCandidate(prefix);
        invariant(
          actual.digest === prior.digest,
          "Installed files have drifted; no overwrite was performed.",
          "conflict",
        );
        if (actual.digest === candidate.digest)
          return {
            installed: false,
            unchanged: true,
            prefix,
            digest: candidate.digest,
            retainedVersions: 1,
          };
      }
      let fd: number;
      try {
        fd = openSync(
          lock,
          constants.O_EXCL | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
      } catch {
        throw problem(
          "conflict",
          "Another installer owns this destination; do not break its lock automatically.",
          "package_lock",
        );
      }
      const stage = join(prefix, `.transaction-${randomUUID()}`);
      mkdirSync(stage, { mode: 0o700 });
      try {
        // The ownership snapshot was read before obtaining the cross-process
        // lock. A competing installer may have completed in that interval.
        const lockedPrior = existsSync(receiptFile)
          ? record(JSON.parse(privateBytes(receiptFile).toString("utf8")))
          : undefined;
        const lockedPending = existsSync(marker)
          ? record(JSON.parse(privateBytes(marker).toString("utf8")))
          : undefined;
        invariant(
          fingerprint(lockedPrior) === fingerprint(prior) &&
            fingerprint(lockedPending) === fingerprint(pending),
          "Installation ownership changed before this transaction acquired the lock.",
          "conflict",
        );
        // Copy and re-verify before replacing a single destination asset.
        for (const name of [...Object.keys(candidate.manifest.files), "build-manifest.json"]) {
          const dest = join(stage, name);
          mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
          copyFileSync(join(candidate.root, name), dest, constants.COPYFILE_EXCL);
        }
        const staged = verifyCandidate(stage);
        invariant(
          staged.digest === candidate.digest,
          "Staged package does not match verified bytes.",
          "integrity_error",
        );
        atomicPrivate(marker, { schema: "agsx.installing.v1", digest: candidate.digest });
        const oldNames = prior ? Object.keys(record(prior.files ?? {})) : [];
        for (const name of [...Object.keys(candidate.manifest.files), "build-manifest.json"]) {
          const destination = join(prefix, name);
          mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
          invariant(
            realpathSync(dirname(destination)) === resolve(dirname(destination)) &&
              (!existsSync(destination) || !lstatSync(destination).isSymbolicLink()),
            "Destination asset path is unsafe.",
            "integrity_error",
          );
          renameSync(join(stage, name), destination);
        }
        for (const name of oldNames)
          if (!Object.hasOwn(candidate.manifest.files, name)) {
            invariant(
              !isAbsolute(name) && !name.split("/").includes(".."),
              "Invalid prior managed path.",
              "integrity_error",
            );
            const p = join(prefix, name);
            if (existsSync(p)) unlinkSync(p);
          }
        atomicPrivate(receiptFile, {
          schema: "agsx.install.v1",
          digest: candidate.digest,
          version: candidate.manifest.version,
          source: candidate.manifest.source,
          files: candidate.manifest.files,
        });
        unlinkSync(marker);
        return {
          installed: true,
          prefix,
          digest: candidate.digest,
          retainedVersions: 1,
          program: join(prefix, "dist", "cli.js"),
          shellPathChanged: false,
        };
      } finally {
        closeSync(fd);
        unlinkSync(lock);
        rmSync(stage, { recursive: true, force: true });
      }
    });
  });
