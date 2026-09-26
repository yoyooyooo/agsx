import { Effect, Layer } from "effect";
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  COMMANDS,
  commandDocument,
  findCommand,
  parseArgv,
  validateInput,
  type Input,
} from "../domain/commands.js";
import { attempt, invariant, record, EXIT_CODES } from "../domain/errors.js";
import type { RuntimeOptions } from "../domain/model.js";
import { settingsLayer } from "../platform/store.js";
import { processLayer } from "../platform/process.js";
import { NodeHttpLive } from "../platform/http.js";
import { readStandardInput } from "../platform/input.js";
import { setup } from "./setup.js";
import { doctor } from "./doctor.js";
import { startSession, showSession, endSession } from "./session.js";
import { inspectAssociation } from "./connection.js";
import { packageCommand } from "../packaging/package.js";

const execute = (name: string, input: Input) =>
  Effect.gen(function* () {
    if (name === "schema")
      return {
        schema: "agsx.companion-commands.v1",
        commands:
          typeof input.command === "string"
            ? [commandDocument(findCommand(input.command))]
            : COMMANDS.map(commandDocument),
        defaultOutput: "json",
        ordinaryCommands: "official git and gh",
        shim: false,
        exitCodes: EXIT_CODES,
        experimental: true,
      };
    if (name === "setup.plan" || name === "setup.apply")
      return yield* setup(input, name === "setup.apply");
    if (name === "doctor") return yield* doctor(input);
    if (name === "session.start") return yield* startSession(input);
    if (name === "session.show") return yield* showSession(input);
    if (name === "session.end") return yield* endSession(input);
    if (name === "association.show" || name === "ci.backend")
      return yield* inspectAssociation(input, name === "ci.backend");
    return yield* packageCommand(name, input);
  });
export const program = (argv: readonly string[], options: RuntimeOptions) =>
  Effect.scoped(
    Effect.gen(function* () {
      const parsed = yield* attempt("arguments", () => parseArgv(argv));
      let json: Record<string, unknown> = {};
      if (parsed.inputFile) {
        const bytes =
          parsed.inputFile === "-"
            ? yield* readStandardInput
            : yield* attempt("input_file", () => {
                const fd = openSync(
                  resolve(options.cwd, parsed.inputFile!),
                  constants.O_RDONLY | constants.O_NOFOLLOW,
                );
                try {
                  const st = fstatSync(fd);
                  invariant(
                    st.isFile() && st.size <= 1024 * 1024,
                    "JSON input must be a bounded regular file.",
                  );
                  const data = readFileSync(fd);
                  invariant(data.length <= 1024 * 1024, "Input exceeded its bound.");
                  return data;
                } finally {
                  closeSync(fd);
                }
              });
        json = yield* attempt("input_json", () => record(JSON.parse(bytes.toString("utf8"))));
      }
      const input = yield* attempt("input_schema", () => {
        invariant(
          !Object.keys(json).some((key) => Object.hasOwn(parsed.partial, key)),
          "An input property cannot appear in both JSON and flags.",
        );
        const value = validateInput(parsed.spec, { ...json, ...parsed.partial });
        if (value.number !== undefined)
          invariant(
            Number.isSafeInteger(value.number) && Number(value.number) > 0,
            "PR number must be a positive safe integer.",
          );
        return value;
      });
      const data = yield* execute(parsed.spec.name, input);
      const planned =
        data !== null &&
        typeof data === "object" &&
        (("planned" in data && data.planned === true) || ("mode" in data && data.mode === "plan"));
      return {
        result: {
          schema: "agsx.result.v1",
          command: parsed.spec.name,
          status: planned ? "planned" : "ok",
          data,
        },
        exitCode: 0,
      };
    }),
  ).pipe(
    Effect.provide(Layer.mergeAll(settingsLayer(options), NodeHttpLive, processLayer(options.env))),
  );
