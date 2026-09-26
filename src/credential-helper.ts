#!/usr/bin/env node
/** Standard Git credential helper only. It is NOT a git/gh shim or dispatcher. */
import { resolve } from "node:path";
import { loadSession, sessionCredential } from "./application/session.js";
import { hostname } from "./domain/model.js";
import { invariant, record, slug, safeError } from "./domain/errors.js";

const [directory, operation] = process.argv.slice(2);
if (!directory || operation !== "get") process.exit(0);
let input = "";
const timeout = setTimeout(() => {
  process.stdin.destroy();
  process.exitCode = 1;
}, 5000);
process.stdin.on("data", (chunk) => {
  input += String(chunk);
  if (Buffer.byteLength(input) > 16384) {
    process.stdin.destroy();
    clearTimeout(timeout);
    process.exitCode = 1;
  }
});
process.stdin.on("error", () => {
  clearTimeout(timeout);
  process.exitCode = 1;
});
process.stdin.on("end", () => {
  clearTimeout(timeout);
  try {
    const values: Record<string, string> = {};
    for (const line of input.split("\n")) {
      if (!line) continue;
      const equal = line.indexOf("=");
      invariant(equal > 0, "Invalid credential request.");
      const key = line.slice(0, equal);
      // Git may send repeated capability[] / wwwauth[] negotiation metadata.
      // Only the target coordinates decide this helper's response.
      if (!["protocol", "host", "path"].includes(key)) continue;
      invariant(!Object.hasOwn(values, key), "Duplicate credential target field.");
      values[key] = line.slice(equal + 1);
    }
    invariant(
      ["http", "https"].includes(values.protocol ?? "") &&
        Boolean(values.host) &&
        Boolean(values.path),
      "Credential request lacks its exact target.",
    );
    const url = new URL(`${values.protocol}://${values.host}`);
    invariant(
      !url.username && !url.password && !url.search && !url.hash && url.pathname === "/",
      "Invalid credential origin.",
    );
    const repo = slug(decodeURIComponent(values.path!).replace(/\.git$/, ""));
    const saved = loadSession(resolve(directory));
    invariant(
      saved.phase === "active" &&
        Date.parse(String(saved.expiresAt)) > Date.now() &&
        [saved.host, saved.apiHost].includes(hostname(url.hostname)),
      "Inactive session or different host.",
    );
    const scopes = Array.isArray(saved.gitScopes) ? saved.gitScopes : [];
    invariant(
      scopes.some((value) => {
        const scope = record(value);
        return (
          scope.origin === url.origin && (scope.repository === null || scope.repository === repo)
        );
      }),
      "Different repository or transport scope.",
    );
    const token = sessionCredential(resolve(directory), saved);
    process.stdout.write(`username=token\npassword=${token}\n\n`);
  } catch (error) {
    process.stderr.write(
      "AGS credential helper: " + safeError(error, "credential_helper").message + "\n",
    );
    process.exitCode = 1;
  }
});
