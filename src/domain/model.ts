import { Schema } from "effect";
import { invariant, problem } from "./errors.js";

export interface RuntimeOptions {
  readonly home: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}
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
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw problem("config_error", "Expected an absolute HTTP(S) origin.");
  }
  invariant(
    ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      ["", "/"].includes(url.pathname),
    "Endpoint must be a credential-free origin.",
    "config_error",
  );
  invariant(
    url.protocol === "https:" ||
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      allowHttp,
    "HTTP is not enabled for this endpoint.",
    "config_error",
  );
  return url.origin;
}
export function hostname(value: unknown): string {
  invariant(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 253 &&
      /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(value) &&
      !value.endsWith(".") &&
      !value.includes(".."),
    "A canonical hostname without port/path/scheme is required.",
    "config_error",
  );
  const url = new URL("https://" + value);
  invariant(
    url.hostname === value.toLowerCase() && !url.port,
    "Ambiguous hostname is not supported.",
    "config_error",
  );
  return url.hostname;
}
export const AssociationSchema = Schema.Struct({
  source: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  task: Schema.optionalKey(Schema.String),
  run: Schema.optionalKey(Schema.String),
});
export type Association = typeof AssociationSchema.Type;
export function association(value: unknown): Association {
  const result = decode(AssociationSchema, value ?? {}, "Run context");
  for (const item of Object.values(result))
    invariant(
      item.length <= 256 &&
        item.trim() === item &&
        !/[\r\n\u0000]/.test(item) &&
        !/^(ags_run_|ags_grant_|mat_|ghp_)/.test(item),
      "Run context accepts identifiers, not credentials.",
    );
  return result;
}
