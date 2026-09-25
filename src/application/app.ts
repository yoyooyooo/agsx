import { Effect, Layer } from "effect";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  COMMANDS,
  commandDocument,
  findCommand,
  parseArgv,
  validateInput,
  type CommandSpec,
  type Input,
} from "../domain/commands.js";
import {
  attempt,
  branch,
  invariant,
  positive,
  problem,
  record,
  sha,
  slug,
  EXIT_CODES,
} from "../domain/errors.js";
import type { ResultEnvelope, RuntimeOptions } from "../domain/model.js";
import { fingerprint, journalLayer, settingsLayer } from "../platform/store.js";
import { NodeHttpLive } from "../platform/http.js";
import { processLayer } from "../platform/process.js";
import { readStandardInput } from "../platform/input.js";
import { configurationCommand, authenticationCommand } from "./configuration.js";
import { resolveTarget, publicTarget } from "./routing.js";
import { repositoryCommand } from "./repositories.js";
import { pullCommand } from "./pulls.js";
import { ciCommand } from "./ci.js";
import { gitCommand, bootstrapGit } from "./git.js";
import { obtainGrant, revokeGrant } from "./identity.js";
import { invocationCommand } from "./invocations.js";
import { operatorCommand } from "../operator/operator.js";
import { packageCommand } from "../packaging/package.js";
import { safeResponse } from "./client.js";
import { presentUrls } from "./presentation.js";

export function validateSemantics(spec: CommandSpec, input: Input): Input {
  if (input.repo !== undefined) slug(input.repo);
  if (input.context !== undefined)
    invariant(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(input.context), "Invalid Context name.");
  for (const key of ["number", "runId", "page", "limit"])
    if (input[key] !== undefined) positive(input[key], key);
  if (input.limit !== undefined) invariant(Number(input.limit) <= 100, "limit cannot exceed 100.");
  if (input.expectedHead !== undefined) sha(input.expectedHead);
  for (const key of ["base", "defaultBranch"]) if (input[key] !== undefined) branch(input[key]);
  invariant(
    !(input.body !== undefined && input.bodyFile !== undefined),
    "body and bodyFile cannot be combined.",
  );
  if (input.invocation)
    invariant(
      /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        input.invocation,
      ),
      "invocation must be a UUID.",
    );
  if (input.timeoutMs !== undefined)
    invariant(
      Number.isInteger(input.timeoutMs) && input.timeoutMs >= 50 && input.timeoutMs <= 300000,
      "timeoutMs must be 50..300000.",
    );
  if (input.fields)
    invariant(
      input.fields.length <= 64 &&
        input.fields.every(
          (f) =>
            /^[A-Za-z_][A-Za-z0-9_.]*$/.test(f) &&
            !f.split(".").some((k) => ["__proto__", "constructor", "prototype"].includes(k)),
        ),
      "fields must be bounded plain property paths, never expressions.",
    );
  if (
    spec.risk !== "read" &&
    input.apply &&
    [
      "pr.create",
      "pr.comment",
      "pr.edit",
      "pr.review",
      "pr.close",
      "pr.reopen",
      "pr.update-branch",
      "pr.merge",
      "repo.create",
      "git.run",
      "ops.apply",
    ].includes(spec.name)
  )
    return { ...input, invocation: input.invocation ?? randomUUID() };
  return input;
}
function plan(spec: CommandSpec, input: Input): unknown {
  return {
    planned: true,
    operation: spec.name,
    risk: spec.risk,
    owner: spec.owner,
    inputDigest: fingerprint(input),
    ...(input.repo ? { repository: input.repo } : {}),
    ...(input.context ? { context: input.context } : {}),
    ...(input.expectedHead ? { expectedHead: input.expectedHead } : {}),
    credentialsRead: false,
    networkRequested: false,
    executionRequires: "--apply",
    authorizationClaimed: false,
  };
}
export const dispatch = (spec: CommandSpec, input: Input) =>
  Effect.gen(function* () {
    if (spec.name === "schema")
      return {
        schema: "agsx.commands.v1",
        commands: input.command
          ? [commandDocument(findCommand(String(input.command)))]
          : COMMANDS.map(commandDocument),
        resultSchema: "agsx.result.v1",
        exitCodes: EXIT_CODES,
        defaultOutput: "json",
        writes: "explicit --apply; HTTP effects are not retried",
        experimental: true,
      };
    if (spec.name.startsWith("context.")) return yield* configurationCommand(spec.name, input);
    if (spec.name.startsWith("package.")) return yield* packageCommand(spec.name, input);
    if (spec.name.startsWith("invocation.")) return yield* invocationCommand(spec.name, input);
    if (spec.name.startsWith("ops.")) return yield* operatorCommand(spec.name, input);
    if (spec.name === "git.bootstrap") return yield* bootstrapGit(Boolean(input.apply));
    if (spec.name === "git.run") return yield* gitCommand(input);
    if (spec.risk !== "read" && !input.apply) return plan(spec, input);
    const requireRepo = !(spec.name.startsWith("auth.") || spec.name === "repo.list");
    const target = yield* resolveTarget(input, requireRepo);
    let data: unknown;
    if (spec.name.startsWith("auth."))
      data = yield* authenticationCommand(spec.name, input, target);
    else if (spec.name.startsWith("repo."))
      data = yield* repositoryCommand(spec.name, input, target);
    else if (spec.name.startsWith("pr.")) data = yield* pullCommand(spec.name, input, target);
    else if (spec.name.startsWith("ci.") || spec.name.startsWith("run."))
      data = yield* ciCommand(spec.name, input, target);
    else if (spec.name === "grant.revoke") data = yield* revokeGrant(target);
    else if (spec.name.startsWith("grant.")) {
      const grant = yield* obtainGrant(
        target,
        spec.name === "grant.issue" ? "issue" : spec.name === "grant.renew" ? "renew" : "observe",
      );
      data = { grant: grant.grant, reused: grant.reused, credentialExposed: false };
    } else
      return yield* Effect.fail(
        problem("unsupported", "The selected command has no application handler.", "dispatch"),
      );
    return { __target: publicTarget(target), __data: presentUrls(data, target) };
  });

function selected(value: unknown, fields: readonly string[] | undefined): unknown {
  if (!fields?.length) return value;
  const pick = (row: unknown) =>
    Object.fromEntries(
      fields.map((field) => [
        field,
        field
          .split(".")
          .reduce<unknown>(
            (v, key) =>
              v !== null && typeof v === "object" && Object.hasOwn(v, key)
                ? (v as Record<string, unknown>)[key]
                : null,
            row,
          ),
      ]),
    );
  return Array.isArray(value) ? value.map(pick) : pick(value);
}
export function resultEnvelope(
  command: string,
  raw: unknown,
  input: Input,
): { result: ResultEnvelope; exitCode: number } {
  const wrapper = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const data = Object.hasOwn(wrapper, "__data") ? wrapper.__data : raw;
  const d = data !== null && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const planned = d.planned === true,
    pending = d.pending === true,
    unknown = d.outcome === "unknown",
    failed = d.failed === true || (typeof d.exitCode === "number" && d.exitCode !== 0);
  const status = unknown
    ? "unknown"
    : planned
      ? "planned"
      : pending
        ? "pending"
        : failed
          ? "error"
          : "ok";
  return {
    result: {
      schema: "agsx.result.v1",
      command,
      status,
      data: safeResponse(selected(data, input.fields)),
      ...(wrapper.__target ? { target: wrapper.__target as ResultEnvelope["target"] } : {}),
      ...(input.invocation ? { invocation: input.invocation } : {}),
    },
    exitCode: unknown
      ? 6
      : pending
        ? 8
        : failed
          ? typeof d.exitCode === "number"
            ? Math.max(1, Math.min(d.exitCode, 125))
            : 1
          : 0,
  };
}
export const execute = (argv: readonly string[], options: RuntimeOptions) =>
  Effect.gen(function* () {
    const parsed = yield* attempt("arguments", () => parseArgv(argv));
    const stdin = parsed.inputFile === "-" ? yield* readStandardInput : undefined;
    const raw = yield* attempt("input", () => {
      let file: Record<string, unknown> = {};
      if (parsed.inputFile) {
        const name = parsed.inputFile === "-" ? 0 : resolve(options.cwd, parsed.inputFile);
        if (typeof name === "string")
          invariant(
            statSync(name).isFile() && statSync(name).size <= 1024 * 1024,
            "Input must be a regular JSON file under 1 MiB.",
          );
        const bytes = stdin ?? readFileSync(name);
        invariant(bytes.length <= 1024 * 1024, "Input exceeds 1 MiB.");
        try {
          file = record(JSON.parse(bytes.toString("utf8")), "Input JSON");
        } catch {
          throw problem("invalid_input", "Input must be a JSON object.", "input");
        }
        invariant(
          !Object.keys(parsed.partial).some((k) => Object.hasOwn(file, k)),
          "A value cannot be provided by both --input and flags.",
        );
      }
      return { ...file, ...parsed.partial };
    });
    const input = yield* attempt("arguments", () =>
      validateSemantics(parsed.spec, validateInput(parsed.spec, raw)),
    );
    const data = yield* dispatch(parsed.spec, input);
    return resultEnvelope(parsed.spec.name, data, input);
  });
export const liveLayers = (options: RuntimeOptions) =>
  Layer.mergeAll(
    settingsLayer(options),
    journalLayer(options.home),
    NodeHttpLive,
    processLayer(options.env),
  );
export const program = (argv: readonly string[], options: RuntimeOptions) =>
  execute(argv, options).pipe(Effect.scoped, Effect.provide(liveLayers(options)));
