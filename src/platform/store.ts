import { Context, Effect, Layer } from "effect";
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
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { attempt, CliError, invariant, problem } from "../domain/errors.js";
import {
  emptyConfig,
  validateConfig,
  type Config,
  type CredentialRef,
  type RuntimeOptions,
} from "../domain/model.js";

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
export function privateDirectory(path: string, create: boolean): boolean {
  if (!existsSync(path)) {
    if (!create) return false;
    const parent = dirname(path);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
    invariant(
      realpathSync(parent) === resolve(parent),
      "Managed directory parent must be canonical, not a symlink.",
      "config_error",
    );
    mkdirSync(path, { mode: 0o700 });
  }
  const s = lstatSync(path);
  invariant(
    s.isDirectory() &&
      !s.isSymbolicLink() &&
      realpathSync(path) === resolve(path) &&
      (process.getuid === undefined || s.uid === process.getuid()) &&
      (s.mode & 0o077) === 0,
    "Managed directory must be a canonical owner-only directory.",
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
        stat.size <= maximum,
      "Expected a bounded owner-only regular file.",
      "config_error",
    );
    invariant(
      realpathSync(path) === resolve(path),
      "Secret/configuration paths may not traverse symlinks.",
      "config_error",
    );
    const result = readFileSync(fd);
    invariant(result.length <= maximum, "File exceeded its size limit.", "config_error");
    return result;
  } finally {
    closeSync(fd);
  }
}
export function atomicPrivate(path: string, value: unknown): void {
  privateDirectory(dirname(path), true);
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
function withLock<A>(path: string, f: () => A): A {
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
      "Another operation owns this state lock; inspect it rather than overriding it.",
      "state_lock",
    );
  }
  try {
    writeFileSync(fd, String(process.pid));
    fsyncSync(fd);
    return f();
  } finally {
    closeSync(fd);
    unlinkSync(path);
  }
}
export class Settings extends Context.Service<
  Settings,
  {
    readonly options: RuntimeOptions;
    readonly read: () => Effect.Effect<Config, CliError>;
    readonly update: (
      f: (current: Config) => Config,
      expected?: string,
    ) => Effect.Effect<{ config: Config; hash: string }, CliError>;
    readonly secret: (ref: CredentialRef) => Effect.Effect<string, CliError>;
    readonly importSecret: (
      name: string,
      source: string,
    ) => Effect.Effect<{ file: string }, CliError>;
    readonly eraseSecret: (ref: CredentialRef) => Effect.Effect<boolean, CliError>;
  }
>()("agsx/Settings") {}

export function settingsLayer(options: RuntimeOptions): Layer.Layer<Settings> {
  const home = resolve(options.home);
  const path = join(home, "config.json");
  const read = (): Config => {
    if (!privateDirectory(home, false)) return emptyConfig();
    if (!existsSync(path)) return emptyConfig();
    try {
      return validateConfig(JSON.parse(privateBytes(path).toString("utf8")));
    } catch (e) {
      if (e instanceof CliError) throw e;
      throw problem("config_error", "Configuration is not valid JSON.", "configuration");
    }
  };
  return Layer.succeed(Settings, {
    options: { ...options, home },
    read: () => attempt("configuration", read),
    update: (f, expected) =>
      attempt("configuration", () => {
        privateDirectory(home, true);
        return withLock(join(home, ".config.lock"), () => {
          const current = read();
          invariant(
            expected === undefined || fingerprint(current) === expected,
            "Configuration changed since the plan was made.",
            "conflict",
          );
          const config = validateConfig(f(current));
          atomicPrivate(path, config);
          return { config, hash: fingerprint(config) };
        });
      }),
    secret: (ref) =>
      attempt("credential", () => {
        let value: string;
        if ("env" in ref) value = options.env[ref.env] ?? "";
        else
          value = privateBytes(
            isAbsolute(ref.file) ? ref.file : join(home, ref.file),
            16_384,
          ).toString("utf8");
        value = value.trim();
        invariant(
          value.length > 0 && value.length <= 16_000 && !/[\r\n\u0000]/.test(value),
          "The selected credential is missing or invalid.",
          "unauthenticated",
        );
        return value;
      }),
    importSecret: (name, source) =>
      attempt("credential_import", () => {
        invariant(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name), "Invalid Context name.");
        const token = privateBytes(resolve(source), 16_384).toString("utf8").trim();
        invariant(
          token.length > 0 && !/[\r\n\u0000]/.test(token),
          "Credential file must contain one token.",
        );
        privateDirectory(home, true);
        privateDirectory(join(home, "secrets"), true);
        const file = join("secrets", `${name}.token`);
        invariant(
          !existsSync(join(home, file)),
          "An owned credential already exists; logout explicitly before replacing it.",
          "conflict",
        );
        const fd = openSync(
          join(home, file),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          writeFileSync(fd, token);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        return { file };
      }),
    eraseSecret: (ref) =>
      attempt("credential_logout", () => {
        if ("env" in ref || isAbsolute(ref.file)) return false;
        const target = resolve(home, ref.file);
        invariant(
          relative(join(home, "secrets"), target) ===
            `${relative(join(home, "secrets"), target).split("/")[0]}` &&
            target.startsWith(join(home, "secrets") + "/"),
          "Only an owned local credential may be removed.",
          "config_error",
        );
        if (!existsSync(target)) return false;
        privateBytes(target, 16_384);
        unlinkSync(target);
        return true;
      }),
  });
}

export type JournalState = "sending" | "complete" | "rejected" | "unknown";
export interface JournalEntry {
  readonly schema: "agsx.operation.v1";
  readonly id: string;
  readonly digest: string;
  readonly context: string;
  readonly endpoint: string;
  readonly repository?: string;
  readonly operation: string;
  readonly method: string;
  readonly path: string;
  readonly createdAt: string;
  readonly state: JournalState;
  readonly status?: number;
  readonly resultDigest?: string;
  readonly locator?: Readonly<Record<string, unknown>>;
}
export class Journal extends Context.Service<
  Journal,
  {
    readonly begin: (
      entry: Omit<JournalEntry, "schema" | "createdAt" | "state">,
      limit: number,
    ) => Effect.Effect<{ fresh: boolean; entry: JournalEntry }, CliError>;
    readonly finish: (
      id: string,
      change: Pick<JournalEntry, "state"> &
        Partial<Pick<JournalEntry, "status" | "resultDigest" | "locator">>,
    ) => Effect.Effect<JournalEntry, CliError>;
    readonly get: (id: string) => Effect.Effect<JournalEntry | undefined, CliError>;
    readonly list: () => Effect.Effect<readonly JournalEntry[], CliError>;
  }
>()("agsx/Journal") {}

export function journalLayer(homeValue: string): Layer.Layer<Journal> {
  const home = resolve(homeValue),
    dir = join(home, "operations");
  const file = (id: string) => {
    invariant(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id),
      "Invocation must be a UUID.",
    );
    return join(dir, `${id}.json`);
  };
  const get = (id: string): JournalEntry | undefined => {
    const p = file(id);
    if (!privateDirectory(home, false) || !privateDirectory(dir, false) || !existsSync(p))
      return undefined;
    const row = JSON.parse(privateBytes(p, 16_384).toString("utf8")) as JournalEntry;
    invariant(
      row.schema === "agsx.operation.v1" &&
        row.id === id &&
        ["sending", "complete", "rejected", "unknown"].includes(row.state),
      "Invalid operation journal record.",
      "integrity_error",
    );
    return row;
  };
  const list = (): readonly JournalEntry[] => {
    if (!privateDirectory(home, false) || !privateDirectory(dir, false)) return [];
    return readdirSync(dir)
      .filter((n) => /^[0-9a-f-]{36}\.json$/.test(n))
      .map((n) => get(n.slice(0, -5))!)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  };
  return Layer.succeed(Journal, {
    get: (id) => attempt("journal", () => get(id)),
    list: () => attempt("journal", list),
    begin: (entry, limit) =>
      attempt("journal", () => {
        privateDirectory(home, true);
        privateDirectory(dir, true);
        return withLock(join(dir, ".lock"), () => {
          const existing = get(entry.id);
          if (existing) {
            invariant(
              existing.digest === entry.digest,
              "Invocation ID is already bound to a different request.",
              "conflict",
            );
            return { fresh: false, entry: existing };
          }
          const records = [...list()];
          while (records.length >= limit) {
            const index = records.findIndex(
              (r) => r.state === "complete" || r.state === "rejected",
            );
            invariant(
              index >= 0,
              "The journal is full of unresolved operations; reconcile them before new writes.",
              "conflict",
            );
            const [row] = records.splice(index, 1);
            unlinkSync(file(row!.id));
          }
          const row: JournalEntry = {
            ...entry,
            schema: "agsx.operation.v1",
            createdAt: new Date().toISOString(),
            state: "sending",
          };
          atomicPrivate(file(entry.id), row);
          return { fresh: true, entry: row };
        });
      }),
    finish: (id, change) =>
      attempt("journal", () =>
        withLock(join(dir, ".lock"), () => {
          const existing = get(id);
          invariant(existing, "Operation journal record not found.", "conflict");
          const row = { ...existing, ...change };
          atomicPrivate(file(id), row);
          return row;
        }),
      ),
  });
}
