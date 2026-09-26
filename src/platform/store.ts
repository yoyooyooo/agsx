import { Context, Layer } from "effect";
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { invariant, problem } from "../domain/errors.js";
import type { RuntimeOptions } from "../domain/model.js";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const fingerprint = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
export function privateDirectory(path: string, create: boolean, strict = true): boolean {
  path = resolve(path);
  if (!existsSync(path)) {
    if (!create) return false;
    let ancestor = dirname(path);
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    invariant(
      realpathSync(ancestor) === ancestor && lstatSync(ancestor).isDirectory(),
      "Managed directories cannot traverse symlinks.",
      "config_error",
    );
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const st = lstatSync(path);
  invariant(
    st.isDirectory() &&
      !st.isSymbolicLink() &&
      realpathSync(path) === path &&
      (process.getuid === undefined || st.uid === process.getuid()) &&
      (st.mode & (strict ? 0o077 : 0o022)) === 0,
    "Managed directory must be canonical and owner-controlled.",
    "config_error",
  );
  return true;
}
export function privateBytes(path: string, maximum = 1024 * 1024): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    invariant(
      stat.isFile() &&
        (stat.mode & 0o077) === 0 &&
        (process.getuid === undefined || stat.uid === process.getuid()) &&
        stat.size <= maximum &&
        realpathSync(path) === resolve(path),
      "Expected a canonical bounded owner-only regular file.",
      "config_error",
    );
    const bytes = readFileSync(fd);
    invariant(bytes.length <= maximum, "File exceeded its bound.", "config_error");
    return bytes;
  } finally {
    closeSync(fd);
  }
}
export function atomicPrivate(path: string, value: unknown, privateParent = true): void {
  privateDirectory(dirname(path), true, privateParent);
  if (existsSync(path)) privateBytes(path);
  const next = join(dirname(path), `.write-${randomUUID()}`);
  const fd = openSync(
    next,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(next, path);
    const parent = openSync(dirname(path), constants.O_RDONLY);
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  } finally {
    if (existsSync(next)) unlinkSync(next);
  }
}
export function withLock<A>(path: string, action: () => A): A {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    throw problem(
      "conflict",
      "State is locked by another operation; do not override an unknown owner.",
      "state_lock",
    );
  }
  try {
    writeFileSync(fd, String(process.pid));
    fsyncSync(fd);
    return action();
  } finally {
    closeSync(fd);
    unlinkSync(path);
  }
}
export class Settings extends Context.Service<Settings, { readonly options: RuntimeOptions }>()(
  "agsx/Settings",
) {}
export const settingsLayer = (options: RuntimeOptions): Layer.Layer<Settings> =>
  Layer.succeed(Settings, { options: { ...options, home: resolve(options.home) } });
