import { Context, Effect, Layer } from "effect";
import * as http from "node:http";
import * as https from "node:https";
import * as tls from "node:tls";
import { isIP } from "node:net";
import { readFileSync } from "node:fs";
import type { Duplex } from "node:stream";
import { CliError, invariant, problem, safeError } from "../domain/errors.js";
import { normalizeEndpoint } from "../domain/model.js";

export interface HttpRequest {
  readonly endpoint: string;
  readonly path: string;
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly credential?: string;
  readonly body?: unknown;
  readonly format?: "json" | "form";
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly caFile?: string;
  readonly proxy?: string;
}
export interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
  readonly text: string;
  readonly headers: Readonly<Record<string, string>>;
}
export class HttpTransport extends Context.Service<
  HttpTransport,
  {
    readonly request: (request: HttpRequest) => Effect.Effect<HttpResponse, CliError>;
  }
>()("agsx/HttpTransport") {}

/** A real Node transport (not fetch: AGS commonly uses port 6666).
 * One invocation = one HTTP attempt, no redirects or proxy/provider failover.
 */
export const NodeHttpLive = Layer.succeed(HttpTransport, {
  request: (input: HttpRequest) =>
    Effect.callback<HttpResponse, CliError>((resume) => {
      const mutates = input.method !== "GET";
      let request: http.ClientRequest | undefined;
      let connect: http.ClientRequest | undefined;
      let tunnel: Duplex | undefined;
      let tunnelAgent: https.Agent | undefined;
      let timer: NodeJS.Timeout | undefined;
      let settled = false;
      const clean = () => {
        if (timer) clearTimeout(timer);
        request?.destroy();
        connect?.destroy();
        tunnel?.destroy();
        tunnelAgent?.destroy();
      };
      const finish = (effect: Effect.Effect<HttpResponse, CliError>) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resume(effect);
      };
      const failure = (kind: "transport" | "timeout" | "limit" | "incomplete" | "proxy") => {
        finish(
          Effect.fail(
            problem(
              mutates ? "outcome_unknown" : "unavailable",
              mutates
                ? "The write outcome is unknown; inspect the exact target before any retry."
                : "The remote response was unavailable, incomplete, or exceeded its limits.",
              `http_${kind}`,
            ),
          ),
        );
        clean();
      };
      try {
        const endpoint = normalizeEndpoint(input.endpoint, true);
        invariant(
          input.path.startsWith("/") &&
            !input.path.startsWith("//") &&
            !input.path.includes("\\") &&
            !input.path.includes("#") &&
            !/[\r\n\u0000]/.test(input.path),
          "Invalid relative API path.",
        );
        const url = new URL(input.path, endpoint);
        invariant(
          url.origin === endpoint && !url.username && !url.password,
          "HTTP request must stay on its selected origin.",
        );
        const max = input.maxBytes ?? 2 * 1024 * 1024;
        const timeout = input.timeoutMs ?? 15_000;
        invariant(
          Number.isInteger(max) &&
            max > 0 &&
            max <= 16 * 1024 * 1024 &&
            Number.isInteger(timeout) &&
            timeout >= 50 &&
            timeout <= 300_000,
          "Invalid HTTP limits.",
        );
        const payload =
          input.body === undefined
            ? undefined
            : input.format === "form"
              ? new URLSearchParams(
                  Object.entries(input.body as Record<string, unknown>).map(([k, v]) => [
                    k,
                    String(v),
                  ]),
                ).toString()
              : JSON.stringify(input.body);
        invariant(
          payload === undefined || Buffer.byteLength(payload) <= 2 * 1024 * 1024,
          "Request JSON is too large.",
        );
        const headers: Record<string, string> = {
          Accept: "application/json",
          Connection: "close",
          "User-Agent": "agsx",
          ...input.headers,
        };
        invariant(
          !Object.keys(input.headers ?? {}).some((k) =>
            /^(authorization|host|proxy-authorization|cookie)$/i.test(k),
          ),
          "Authentication and routing headers are owned by the transport.",
        );
        if (input.credential) headers.Authorization = `Bearer ${input.credential}`;
        if (payload !== undefined) {
          headers["Content-Type"] =
            input.format === "form" ? "application/x-www-form-urlencoded" : "application/json";
          headers["Content-Length"] = String(Buffer.byteLength(payload));
        }
        const ca = input.caFile ? readFileSync(input.caFile) : undefined;
        const response = (res: http.IncomingMessage) => {
          const chunks: Buffer[] = [];
          let size = 0;
          const status = res.statusCode ?? 0;
          // Never follow authentication or write redirects; even same-origin 307 is a separate effect.
          if (status >= 300 && status < 400 && status !== 304) {
            res.resume();
            finish(
              Effect.fail(
                problem(
                  "conflict",
                  "Redirect refused. Correct the configured canonical endpoint; no request was replayed.",
                  "http_redirect",
                  { status },
                ),
              ),
            );
            clean();
            return;
          }
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > max) {
              failure("limit");
              return;
            }
            chunks.push(Buffer.from(chunk));
          });
          res.on("aborted", () => failure("incomplete"));
          res.on("error", () => failure("transport"));
          res.on("end", () => {
            if (!res.complete) {
              failure("incomplete");
              return;
            }
            const text = Buffer.concat(chunks).toString("utf8");
            let body: unknown = null;
            if (text) {
              try {
                body = JSON.parse(text);
              } catch {
                body = null;
              }
            }
            const safeHeaders = Object.fromEntries(
              Object.entries(res.headers)
                .filter(([k]) =>
                  [
                    "content-type",
                    "link",
                    "etag",
                    "retry-after",
                    "x-request-id",
                    "x-ags-edge-request-id",
                    "x-ags-edge-route",
                  ].includes(k),
                )
                .map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v ?? "")]),
            );
            finish(Effect.succeed({ status, body, text, headers: safeHeaders }));
          });
        };
        const start = (socket?: Duplex) => {
          const proxy = input.proxy ? new URL(normalizeEndpoint(input.proxy, true)) : undefined;
          if (proxy && url.protocol === "http:") {
            const client = proxy.protocol === "https:" ? https : http;
            request = client.request(
              proxy,
              {
                method: input.method,
                path: url.href,
                headers: { ...headers, Host: url.host },
                agent: false,
              },
              response,
            );
          } else if (url.protocol === "https:") {
            if (socket) {
              tunnelAgent = new https.Agent({ keepAlive: false });
              tunnelAgent.createConnection = () => socket;
            }
            request = https.request(
              url,
              { method: input.method, headers, agent: tunnelAgent ?? false, ca },
              response,
            );
          } else
            request = http.request(url, { method: input.method, headers, agent: false }, response);
          request.on("error", () => failure("transport"));
          if (payload !== undefined) request.write(payload);
          request.end();
        };
        timer = setTimeout(() => failure("timeout"), timeout);
        if (input.proxy && url.protocol === "https:") {
          const proxy = new URL(normalizeEndpoint(input.proxy, true));
          const client = proxy.protocol === "https:" ? https : http;
          connect = client.request(proxy, {
            method: "CONNECT",
            path: `${url.hostname}:${url.port || "443"}`,
            headers: { Host: `${url.hostname}:${url.port || "443"}` },
            agent: false,
          });
          connect.on("error", () => failure("proxy"));
          connect.on("connect", (res, socket, head) => {
            if (res.statusCode !== 200 || head.length) {
              socket.destroy();
              failure("proxy");
              return;
            }
            const secured = tls.connect({
              socket,
              host: url.hostname,
              servername: isIP(url.hostname) ? undefined : url.hostname,
              ca,
              rejectUnauthorized: true,
            });
            tunnel = secured;
            secured.on("error", () => failure("proxy"));
            secured.once("secureConnect", () => start(secured));
          });
          connect.end();
        } else start();
      } catch (e) {
        finish(Effect.fail(safeError(e, "http_setup")));
        clean();
      }
      return Effect.sync(clean);
    }),
});

export function expectStatus(
  response: HttpResponse,
  accepted: readonly number[] = [200],
): HttpResponse {
  if (accepted.includes(response.status)) return response;
  if (response.status === 401)
    throw problem("unauthenticated", "AGS rejected the selected credential.", "http_status", {
      status: 401,
    });
  if (response.status === 403)
    throw problem("denied", "AGS denied this exact operation.", "http_status", { status: 403 });
  if (response.status === 404)
    throw problem(
      "unsupported",
      "The selected resource or server capability was not found.",
      "http_status",
      { status: 404 },
    );
  if ([409, 412, 422].includes(response.status))
    throw problem(
      "conflict",
      "AGS rejected a precondition or the requested state conflicts with current state.",
      "http_status",
      { status: response.status },
    );
  if (response.status === 429 || response.status >= 500)
    throw problem(
      "unavailable",
      "The server cannot currently complete this request.",
      "http_status",
      { status: response.status },
    );
  throw problem("unsupported", "Unexpected HTTP status from the selected service.", "http_status", {
    status: response.status,
  });
}
