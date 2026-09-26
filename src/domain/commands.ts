import { Schema } from "effect";
import { decode, AssociationSchema } from "./model.js";
import { invariant, problem, record } from "./errors.js";
const S = Schema.String,
  B = Schema.Boolean,
  N = Schema.Finite,
  optional = Schema.optionalKey;
export type Risk = "read" | "local-write" | "write";
export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  readonly risk: Risk;
  readonly schema: Schema.ConstraintDecoder<unknown>;
}
const common = { apply: optional(B) };
const gh = { gh: optional(S), ghConfig: optional(S), caFile: optional(S) };
function command(
  name: string,
  summary: string,
  risk: Risk,
  fields: Schema.Struct.Fields = {},
): CommandSpec {
  return { name, summary, risk, schema: Schema.Struct({ ...common, ...fields }) };
}
export const COMMANDS: readonly CommandSpec[] = [
  command(
    "schema",
    "Describe companion commands; ordinary Git/PR/CI belongs to official gh.",
    "read",
    { command: optional(S) },
  ),
  command(
    "setup.plan",
    "Inspect one official gh host configuration and plan an explicit credential import.",
    "read",
    { ...gh, host: S, apiHost: optional(S), tokenFile: S },
  ),
  command(
    "setup.apply",
    "Verify one native AGS identity and CAS-update only its official gh host entry.",
    "local-write",
    { ...gh, host: S, apiHost: optional(S), tokenFile: S, expectedPlan: S },
  ),
  command(
    "doctor",
    "Explain origin, gh defaults, host authentication and optional AGS reachability; no shim.",
    "read",
    { ...gh, network: optional(B) },
  ),
  command(
    "session.start",
    "Prepare one task-scoped standard Git/gh environment using a native actor; no command grants.",
    "write",
    {
      ...gh,
      host: optional(S),
      directory: S,
      ttlSeconds: optional(N),
      context: optional(AssociationSchema),
      source: optional(
        Schema.Struct({
          instance: S,
          tokenFile: S,
          endpointHint: optional(S),
          locator: optional(Schema.Record(S, S)),
        }),
      ),
    },
  ),
  command(
    "session.show",
    "Read the owned run identity and environment paths, never the bearer.",
    "read",
    { directory: S },
  ),
  command(
    "session.end",
    "Revoke one owned run credential and remove its local credential files.",
    "write",
    { directory: S, caFile: optional(S) },
  ),
  command(
    "association.show",
    "Read authenticated Agent/Task/Run and provider links for the origin's AGS PR.",
    "read",
    { ...gh, number: N },
  ),
  command(
    "ci.backend",
    "Inspect the repository's server-selected CI backend; does not run or replace gh CI commands.",
    "read",
    { ...gh },
  ),
  command("package.inspect", "Inspect this companion's build and runtime identity.", "read"),
  command("package.verify", "Verify an explicit local candidate's content manifest.", "read", {
    directory: S,
  }),
  command(
    "package.install",
    "Install one verified candidate into an empty/owned slot, without version archives.",
    "local-write",
    { directory: S, prefix: S, expectedDigest: S },
  ),
];
export type Input = Readonly<Record<string, unknown>> & { readonly apply?: boolean };
export function findCommand(name: string): CommandSpec {
  const spec = COMMANDS.find((item) => item.name === name);
  invariant(
    spec,
    "Unknown companion command. Use official git/gh for ordinary repository, PR and CI work.",
  );
  return spec;
}
export function validateInput(spec: CommandSpec, input: unknown): Input {
  return decode(spec.schema, input, "Command input") as Input;
}
export function commandDocument(spec: CommandSpec) {
  const doc = Schema.toJsonSchemaDocument(spec.schema as Schema.Constraint);
  return {
    name: spec.name,
    summary: spec.summary,
    risk: spec.risk,
    input: {
      ...doc.schema,
      $schema: "https://json-schema.org/draft/2020-12/schema",
      ...(Object.keys(doc.definitions).length ? { $defs: doc.definitions } : {}),
    },
    output: "agsx.result.v1",
    writesRequireApply: spec.risk !== "read",
  };
}
function parseValue(value: string, property: Record<string, unknown>): unknown {
  if (property.type === "boolean") {
    invariant(["true", "false"].includes(value), "Boolean flag must be true or false.");
    return value === "true";
  }
  if (property.type === "number" || property.type === "integer") {
    const number = Number(value);
    invariant(Number.isFinite(number), "Numeric flag must be finite.");
    return number;
  }
  if (property.type === "object" || property.type === "array") {
    try {
      return JSON.parse(value);
    } catch {
      throw problem("invalid_input", "Structured flags expect JSON.", "arguments");
    }
  }
  return value;
}
export function parseArgv(argv: readonly string[]): {
  spec: CommandSpec;
  partial: Record<string, unknown>;
  inputFile?: string;
} {
  if (!argv.length || argv[0] === "--help" || argv[0] === "help")
    return { spec: findCommand("schema"), partial: {} };
  let name = argv[0]!,
    offset = 1;
  if (!name.includes(".") && !["schema", "doctor"].includes(name)) {
    invariant(Boolean(argv[1]) && !argv[1]!.startsWith("-"), "A command leaf is required.");
    name += "." + argv[1];
    offset = 2;
  }
  const spec = findCommand(name),
    partial: Record<string, unknown> = {};
  const document = record(commandDocument(spec).input),
    properties = record(document.properties);
  let inputFile: string | undefined;
  for (let i = offset; i < argv.length; i++) {
    const raw = argv[i]!;
    if (raw === "--help") {
      invariant(i === argv.length - 1, "Help cannot hide trailing arguments.");
      return { spec: findCommand("schema"), partial: { command: name } };
    }
    invariant(
      raw.startsWith("--") && raw !== "--",
      "Use named flags or --input JSON; no command passthrough exists.",
    );
    const equal = raw.indexOf("="),
      flag = raw.slice(2, equal < 0 ? undefined : equal),
      key = flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    if (key === "input") {
      invariant(inputFile === undefined, "Duplicate --input.");
      inputFile = equal >= 0 ? raw.slice(equal + 1) : argv[++i];
      invariant(inputFile, "--input needs a file or '-'.");
      continue;
    }
    invariant(
      Object.hasOwn(properties, key) && !Object.hasOwn(partial, key),
      "Unknown or duplicate flag; no credentials were read.",
    );
    let property = record(properties[key]);
    if (typeof property.$ref === "string") {
      invariant(property.$ref.startsWith("#/$defs/"), "Unsupported schema reference.");
      property = record(record(document.$defs)[property.$ref.slice(8)]);
    }
    let value: string;
    if (equal >= 0) value = raw.slice(equal + 1);
    else if (property.type === "boolean" && (!argv[i + 1] || argv[i + 1]!.startsWith("--")))
      value = "true";
    else {
      value = argv[++i]!;
      invariant(value !== undefined, "Flag requires a value.");
    }
    partial[key] = parseValue(value, property);
  }
  return { spec, partial, ...(inputFile ? { inputFile } : {}) };
}
