import { Schema } from "effect";
import { invariant, onlyKeys, problem, record } from "./errors.js";

export const CredentialSchema = Schema.Union([
  Schema.Struct({ file: Schema.String }),
  Schema.Struct({ env: Schema.String }),
]);
export const AuthSchema = Schema.Struct({
  kind: Schema.Literals(["human", "service"]),
  credential: CredentialSchema,
});
export const WorkloadSchema = Schema.Struct({
  adapter: Schema.Literal("multica"),
  endpoint: Schema.String,
  issuerInstanceId: Schema.String,
  workspaces: Schema.Array(Schema.String),
});
export const ContextSchema = Schema.Struct({
  endpoint: Schema.String,
  instanceId: Schema.String,
  aliases: Schema.optionalKey(Schema.Array(Schema.String)),
  allowHttp: Schema.optionalKey(Schema.Boolean),
  auth: Schema.optionalKey(AuthSchema),
  workload: Schema.optionalKey(WorkloadSchema),
  caFile: Schema.optionalKey(Schema.String),
  proxy: Schema.optionalKey(Schema.String),
  publicUrls: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
export const ConfigSchema = Schema.Struct({
  schema: Schema.Literal("agsx.config.v1"),
  defaultContext: Schema.optionalKey(Schema.String),
  contexts: Schema.Record(Schema.String, ContextSchema),
  journalLimit: Schema.optionalKey(Schema.Number),
});
export type ContextConfig = typeof ContextSchema.Type;
export type Config = typeof ConfigSchema.Type;
export type CredentialRef = typeof CredentialSchema.Type;
export type IdentityKind = "human" | "service" | "workload";
export interface Target {
  readonly contextName: string;
  readonly context: ContextConfig;
  readonly repository?: string;
  readonly identity: IdentityKind;
  readonly home?: string;
}
export interface RuntimeOptions {
  readonly home: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly requestTimeoutMs?: number;
  readonly maxResponseBytes?: number;
}
export const emptyConfig = (): Config => ({ schema: "agsx.config.v1", contexts: {} });
export function decode<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
  label = "input",
): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
  } catch {
    throw problem("invalid_input", `${label} does not match its declared schema.`, "schema");
  }
}
export function normalizeEndpoint(value: string, allowHttp = false): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw problem("config_error", "Endpoint must be an absolute HTTP(S) origin.");
  }
  invariant(
    ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      ["", "/"].includes(u.pathname),
    "Endpoint must be a credential-free HTTP(S) origin.",
    "config_error",
  );
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname.toLowerCase());
  invariant(
    u.protocol === "https:" || loopback || allowHttp,
    "Non-loopback HTTP requires explicit allowHttp in the Context.",
    "config_error",
  );
  return u.origin;
}
export function validateCredential(ref: CredentialRef): void {
  if ("env" in ref) {
    invariant(
      /^[A-Z_][A-Z0-9_]*$/.test(ref.env) &&
        !["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "MULTICA_TOKEN"].includes(ref.env),
      "Use a dedicated, explicitly named AGS credential environment variable.",
      "config_error",
    );
  } else {
    invariant(
      ref.file.length > 0 && !ref.file.includes("\u0000"),
      "Credential file reference is invalid.",
      "config_error",
    );
  }
}
export function validateContext(value: unknown): ContextConfig {
  const c = decode(ContextSchema, value, "Context");
  invariant(
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(c.instanceId),
    "instanceId must be a stable identifier.",
    "config_error",
  );
  normalizeEndpoint(c.endpoint, c.allowHttp);
  for (const alias of c.aliases ?? []) normalizeEndpoint(alias, c.allowHttp);
  if (c.auth) validateCredential(c.auth.credential);
  if (c.workload) {
    normalizeEndpoint(c.workload.endpoint, c.allowHttp);
    invariant(
      c.workload.issuerInstanceId.length > 0 &&
        c.workload.workspaces.length > 0 &&
        c.workload.workspaces.every((w) => /^[A-Za-z0-9_.:-]+$/.test(w)),
      "Workload trust needs the exact issuer instance ID and an explicit workspace allowlist.",
      "config_error",
    );
  }
  if (c.proxy) normalizeEndpoint(c.proxy, true);
  for (const v of Object.values(c.publicUrls ?? {})) normalizeEndpoint(v, c.allowHttp);
  return {
    ...c,
    endpoint: normalizeEndpoint(c.endpoint, c.allowHttp),
    ...(c.aliases ? { aliases: c.aliases.map((a) => normalizeEndpoint(a, c.allowHttp)) } : {}),
  };
}
export function validateConfig(value: unknown): Config {
  const cfg = decode(ConfigSchema, value, "Configuration");
  const endpoints = new Map<string, string>();
  const contexts: Record<string, ContextConfig> = {};
  for (const [name, raw] of Object.entries(cfg.contexts)) {
    invariant(
      /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name),
      "Context name is invalid.",
      "config_error",
    );
    const c = validateContext(raw);
    contexts[name] = c;
    for (const address of new Set([c.endpoint, ...(c.aliases ?? [])])) {
      invariant(
        !endpoints.has(address),
        "Context endpoints/aliases overlap; route selection would be ambiguous.",
        "config_error",
      );
      endpoints.set(address, name);
    }
  }
  invariant(
    cfg.defaultContext === undefined || contexts[cfg.defaultContext] !== undefined,
    "defaultContext must name a configured Context.",
    "config_error",
  );
  invariant(
    cfg.journalLimit === undefined ||
      (Number.isInteger(cfg.journalLimit) && cfg.journalLimit >= 8 && cfg.journalLimit <= 512),
    "journalLimit must be an integer from 8 to 512.",
    "config_error",
  );
  return { ...cfg, contexts };
}
export function jsonObject(value: unknown): Record<string, unknown> {
  return record(value, "response");
}
export function rejectSecretInput(value: Record<string, unknown>): void {
  onlyKeys(
    value,
    Object.keys(value).filter((k) => !/^(token|password|secret|privateKey)$/i.test(k)),
    "Public input",
  );
}

export type ResultStatus = "ok" | "planned" | "pending" | "unknown" | "error";
export interface ResultEnvelope {
  readonly schema: "agsx.result.v1";
  readonly command: string;
  readonly status: ResultStatus;
  readonly data?: unknown;
  readonly target?: {
    readonly context: string;
    readonly endpoint: string;
    readonly repository?: string;
  };
  readonly invocation?: string;
  readonly warnings?: readonly string[];
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly stage: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}
