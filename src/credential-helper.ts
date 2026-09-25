#!/usr/bin/env node
/** Private Git helper protocol. Never install it as a generic system helper. */
import { readFileSync } from "node:fs";
import { privateBytes } from "./platform/store.js";

export function credentialReply(action: string, input: string, file: string | undefined): string {
  if (action !== "get" || !file) return "";
  try {
    const request = Object.fromEntries(
      input
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const i = line.indexOf("=");
          return [line.slice(0, i), line.slice(i + 1)];
        }),
    );
    const envelope = JSON.parse(privateBytes(file, 20_000).toString("utf8")) as {
      schema: string;
      origin: string;
      repository: string;
      token: string;
    };
    if (envelope.schema !== "agsx.git-credential.v1" || !/^https?$/.test(request.protocol ?? ""))
      return "";
    const origin = new URL(envelope.origin);
    const path = (request.path ?? "").replace(/^\//, "").replace(/\.git$/, "");
    if (
      request.protocol + ":" !== origin.protocol ||
      request.host !== origin.host ||
      path !== envelope.repository
    )
      return "";
    if (!envelope.token || /[\r\n\u0000]/.test(envelope.token)) return "";
    return `username=token\npassword=${envelope.token}\n\n`;
  } catch {
    return "";
  }
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.stdout.write(
    credentialReply(
      process.argv[2] ?? "",
      readFileSync(0, "utf8"),
      process.env.AGSX_GIT_CREDENTIAL_FILE,
    ),
  );
}
