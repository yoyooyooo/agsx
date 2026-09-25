import { Schema } from "effect";
import { decode } from "./model.js";
import { invariant, problem, record } from "./errors.js";

const S = Schema.String,
  B = Schema.Boolean,
  N = Schema.Finite;
const optional = Schema.optionalKey;
const strings = Schema.Array(S);
const json = Schema.Record(S, Schema.Unknown);
const common = {
  context: optional(S),
  repo: optional(S),
  identity: optional(Schema.Literals(["human", "service", "workload"])),
  apply: optional(B),
  invocation: optional(S),
  fields: optional(strings),
  timeoutMs: optional(N),
};
export type Risk = "read" | "local-write" | "write";
export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  readonly risk: Risk;
  readonly owner: "client" | "ags" | "operator";
  readonly schema: Schema.ConstraintDecoder<unknown>;
}
function command(
  name: string,
  summary: string,
  risk: Risk,
  fields: Schema.Struct.Fields = {},
  owner: CommandSpec["owner"] = "ags",
): CommandSpec {
  return { name, summary, risk, owner, schema: Schema.Struct({ ...common, ...fields }) };
}
const pr = { number: N };
const page = { limit: optional(N), page: optional(N), all: optional(B) };
export const COMMANDS: readonly CommandSpec[] = [
  command(
    "schema",
    "Describe commands, typed inputs, risk and exit contracts without I/O.",
    "read",
    { command: optional(S) },
    "client",
  ),
  command(
    "context.list",
    "List configured routes without reading credentials.",
    "read",
    {},
    "client",
  ),
  command(
    "context.show",
    "Show the selected origin-bound route without authentication.",
    "read",
    {},
    "client",
  ),
  command(
    "context.add",
    "Add an explicit AGS-only or workload-enabled Context.",
    "local-write",
    { name: S, configuration: json, expectedConfig: optional(S) },
    "client",
  ),
  command(
    "context.remove",
    "Remove a named Context, not its external credentials.",
    "local-write",
    { name: S, expectedConfig: S },
    "client",
  ),
  command(
    "context.use",
    "Set the explicit outside-repository default.",
    "local-write",
    { name: S, expectedConfig: optional(S) },
    "client",
  ),
  command(
    "context.export",
    "Export secret-free Context configuration as JSON.",
    "read",
    { name: S },
    "client",
  ),
  command(
    "context.import",
    "Converge an explicit preset; no personal deployment defaults.",
    "local-write",
    { configuration: json, expectedConfig: S },
    "client",
  ),
  command(
    "context.doctor",
    "Check route, optional readiness and server identity without secrets.",
    "read",
    { network: optional(B) },
    "client",
  ),
  command("auth.status", "Verify the selected native identity or exact workload grant.", "read"),
  command(
    "auth.import",
    "Verify and import an owner-only token file into the new client home.",
    "local-write",
    { file: S, kind: Schema.Literals(["human", "service"]) },
    "client",
  ),
  command(
    "auth.logout",
    "Forget an owned credential reference; server revocation is a separate fact.",
    "local-write",
    {},
    "client",
  ),
  command(
    "auth.device-start",
    "Begin AGS device authorization without opening a browser.",
    "write",
    { clientId: optional(S), scope: optional(S) },
  ),
  command(
    "auth.device-finish",
    "Poll and securely store one pending device authorization.",
    "local-write",
    { wait: optional(B) },
    "client",
  ),
  command(
    "repo.create",
    "Create a repository with explicit visibility/default branch; projection is separate.",
    "write",
    {
      description: optional(S),
      visibility: optional(Schema.Literals(["private", "public"])),
      defaultBranch: optional(S),
      readme: optional(B),
    },
  ),
  command("repo.view", "Read native repository facts.", "read"),
  command("repo.list", "List visible repositories with bounded pagination.", "read", {
    ...page,
    owner: optional(S),
  }),
  command("repo.refs", "Read branch/tag reference facts.", "read", {
    ...page,
    kind: optional(Schema.Literals(["heads", "tags"])),
    ref: optional(S),
  }),
  command(
    "repo.verify",
    "Observe native repository, exact branch and configured projections.",
    "read",
    { branch: optional(S) },
  ),
  command(
    "pr.create",
    "Create one exact head/base PR; unknown results never trigger a duplicate POST.",
    "write",
    {
      head: S,
      base: S,
      title: optional(S),
      body: optional(S),
      bodyFile: optional(S),
      draft: optional(B),
      fill: optional(B),
      expectedHead: optional(S),
    },
  ),
  command("pr.view", "Read an exact AGS PR and its projection facts.", "read", {
    ...pr,
    comments: optional(B),
  }),
  command("pr.list", "List PRs through native REST, not a bundled gh engine.", "read", {
    ...page,
    state: optional(Schema.Literals(["open", "closed", "all"])),
    head: optional(S),
    base: optional(S),
    author: optional(S),
    draft: optional(B),
    labels: optional(strings),
  }),
  command(
    "pr.status",
    "Group visible open PRs by author/review state for the current identity.",
    "read",
    page,
  ),
  command("pr.edit", "Edit an exact PR after validating its expected head.", "write", {
    ...pr,
    expectedHead: S,
    title: optional(S),
    body: optional(S),
    bodyFile: optional(S),
    base: optional(S),
  }),
  command("pr.comment", "Post a comment to one numbered PR.", "write", {
    ...pr,
    body: optional(S),
    bodyFile: optional(S),
  }),
  command("pr.review", "Submit an exact-head approval, comment, or change request.", "write", {
    ...pr,
    expectedHead: S,
    event: Schema.Literals(["APPROVE", "COMMENT", "REQUEST_CHANGES"]),
    body: optional(S),
    bodyFile: optional(S),
  }),
  command("pr.reviews", "Read reviews for one exact PR.", "read", { ...pr, ...page }),
  command("pr.close", "Close a numbered PR without deleting its Git branch.", "write", {
    ...pr,
    expectedHead: S,
  }),
  command("pr.reopen", "Reopen a numbered PR under native AGS policy.", "write", {
    ...pr,
    expectedHead: S,
  }),
  command(
    "pr.update-branch",
    "Ask AGS to update the PR branch with a head precondition.",
    "write",
    { ...pr, expectedHead: S, rebase: optional(B) },
  ),
  command(
    "pr.merge",
    "Merge through the server-selected policy path; require an exact head.",
    "write",
    {
      ...pr,
      expectedHead: S,
      method: Schema.Literals(["merge", "rebase", "rebase-merge", "squash", "fast-forward-only"]),
    },
  ),
  command(
    "ci.checks",
    "Read exact-head CI evidence; required filtering needs server policy facts.",
    "read",
    {
      ...pr,
      required: optional(B),
      watch: optional(B),
      intervalMs: optional(N),
      waitMs: optional(N),
      failFast: optional(B),
    },
  ),
  command("run.list", "List provider runs bound to an AGS PR, with explicit filters.", "read", {
    number: N,
    ...page,
    branch: optional(S),
    commit: optional(S),
    event: optional(S),
    state: optional(S),
    workflow: optional(S),
  }),
  command("run.view", "Read one run bound to a numbered AGS PR.", "read", { number: N, runId: N }),
  command(
    "run.logs",
    "Read bounded logs for an exact run; never connect directly to a provider.",
    "read",
    { number: N, runId: N, failedOnly: optional(B) },
  ),
  command(
    "git.run",
    "Run native Git with origin-scoped credentials, no shell and no global mutation.",
    "write",
    { args: strings },
    "client",
  ),
  command(
    "git.bootstrap",
    "Plan/materialize explicit client-local git/gh shims; no global PATH mutation.",
    "local-write",
    {},
    "client",
  ),
  command("grant.status", "Observe/revalidate the current exact optional workload grant.", "read"),
  command("grant.issue", "Issue a workload grant using explicit Context trust.", "write"),
  command("grant.renew", "Renew only the current exact workload grant.", "write"),
  command("grant.revoke", "Revoke a grant and remove only its owned cache entry.", "write"),
  command(
    "invocation.list",
    "List bounded local operation records without secrets or request bodies.",
    "read",
    {},
    "client",
  ),
  command("invocation.show", "Read one local operation record.", "read", { id: S }, "client"),
  command(
    "invocation.reconcile",
    "Read back one unknown effect without replaying the write.",
    "read",
    { id: S },
    "client",
  ),
  command(
    "ops.plan",
    "Read an explicit operator manifest and compute a safe desired-state plan.",
    "read",
    { manifest: S },
    "operator",
  ),
  command(
    "ops.verify",
    "Observe AGS/provider mapping, protection, hooks and labels without writes.",
    "read",
    { manifest: S },
    "operator",
  ),
  command(
    "ops.apply",
    "Apply only a fresh, exact observed operator plan; no shell/database backdoors.",
    "write",
    { manifest: S, expectedPlan: S },
    "operator",
  ),
  command(
    "package.inspect",
    "Inspect current build, dependency pins and supported runtime.",
    "read",
    {},
    "client",
  ),
  command(
    "package.verify",
    "Verify an explicit candidate directory against its build manifest.",
    "read",
    { directory: S },
    "client",
  ),
  command(
    "package.install",
    "Install one verified candidate into an explicit empty/owned single slot.",
    "local-write",
    { directory: S, prefix: S, expectedDigest: S },
    "client",
  ),
];
export type Input = Readonly<Record<string, unknown>> & {
  readonly context?: string;
  readonly repo?: string;
  readonly identity?: "human" | "service" | "workload";
  readonly apply?: boolean;
  readonly invocation?: string;
  readonly fields?: readonly string[];
  readonly timeoutMs?: number;
};
export function findCommand(name: string): CommandSpec {
  const spec = COMMANDS.find((c) => c.name === name);
  invariant(spec, "Unknown command. Use schema to discover the exact supported surface.");
  return spec;
}
export function validateInput(spec: CommandSpec, value: unknown): Input {
  return decode(spec.schema, value, "Command input") as Input;
}
export function commandDocument(spec: CommandSpec) {
  const document = Schema.toJsonSchemaDocument(spec.schema as Schema.Constraint);
  const input = {
    ...document.schema,
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...(Object.keys(document.definitions).length ? { $defs: document.definitions } : {}),
  };
  return {
    name: spec.name,
    summary: spec.summary,
    risk: spec.risk,
    owner: spec.owner,
    input,
    output: "agsx.result.v1",
    writesRequireApply: spec.risk !== "read",
  };
}
export function parseValue(value: string, property: Record<string, unknown>): unknown {
  if (property.type === "boolean") {
    invariant(["true", "false"].includes(value), "Boolean flag must be true or false.");
    return value === "true";
  }
  if (property.type === "number" || property.type === "integer") {
    const n = Number(value);
    invariant(Number.isFinite(n), "Numeric argument is invalid.");
    return n;
  }
  if (property.type === "object" || property.type === "array") {
    try {
      return JSON.parse(value);
    } catch {
      throw problem(
        "invalid_input",
        "Structured flag expects valid JSON; --input is preferred.",
        "arguments",
      );
    }
  }
  return value;
}
export function parseArgv(argv: readonly string[]): {
  spec: CommandSpec;
  partial: Record<string, unknown>;
  inputFile?: string;
} {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "help")
    return { spec: findCommand("schema"), partial: {} };
  let name = argv[0]!,
    offset = 1;
  if (!name.includes(".") && name !== "schema") {
    invariant(
      Boolean(argv[1]) && !argv[1]!.startsWith("-"),
      "A command leaf is required; use schema.",
    );
    name += `.${argv[1]}`;
    offset = 2;
  }
  const spec = findCommand(name),
    partial: Record<string, unknown> = {};
  let inputFile: string | undefined;
  const doc = record(commandDocument(spec).input),
    properties = record(doc.properties);
  for (let i = offset; i < argv.length; i++) {
    const raw = argv[i]!;
    if (raw === "--help") {
      invariant(i === argv.length - 1, "Help must not hide trailing arguments.");
      return { spec: findCommand("schema"), partial: { command: name } };
    }
    invariant(
      raw.startsWith("--") && raw !== "--",
      "Use named flags or --input JSON; positional arguments are not accepted.",
    );
    const split = raw.indexOf("="),
      flag = raw.slice(2, split < 0 ? undefined : split),
      key = flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    if (key === "input") {
      invariant(inputFile === undefined, "Duplicate --input.");
      inputFile = split >= 0 ? raw.slice(split + 1) : argv[++i];
      invariant(inputFile, "--input needs a file or '-'.");
      continue;
    }
    invariant(Object.hasOwn(properties, key), "Unknown flag; no state or credential was read.");
    invariant(
      !Object.hasOwn(partial, key),
      "Duplicate flag; use JSON arrays for multi-value input.",
    );
    let property = record(properties[key]);
    if (typeof property.$ref === "string") {
      invariant(property.$ref.startsWith("#/$defs/"), "Unsupported command schema reference.");
      property = record(record(doc.$defs)[property.$ref.slice("#/$defs/".length)]);
    }
    let value: string;
    if (split >= 0) value = raw.slice(split + 1);
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
