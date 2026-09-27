import { Effect } from "effect";
import {
  attempt,
  invariant,
  positive,
  record,
  repoPath,
  sha,
  slug,
  text,
} from "../domain/errors.js";
import type { Input } from "../domain/commands.js";
import { hostname } from "../domain/model.js";
import { HttpTransport } from "../platform/http.js";
import { credential, ghHosts, runtime, target, routingOverrides } from "./connection.js";

interface Locator {
  readonly url: string;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}
interface Projection {
  readonly status:
    | "projected"
    | "pending"
    | "not_observed"
    | "failed"
    | "unavailable"
    | "conflict"
    | "not_applicable";
  readonly number?: number;
  readonly url?: string;
  readonly repository?: string;
  readonly currentHead?: boolean;
  readonly reason?: string;
}

/** A URL is only a locator/output receipt, never permission to make a request. */
export function parseCreatedPRURL(value: unknown): Locator {
  const raw = text(value, "PR URL").trim();
  invariant(
    raw.length <= 4096 && /^https?:\/\/[^\s]+$/.test(raw) && !raw.includes("\\"),
    "Expected one native PR URL, not a command transcript.",
  );
  const url = new URL(raw);
  invariant(
    !url.username && !url.password && !url.search && !url.hash && !url.pathname.includes("%"),
    "PR URL must not contain credentials or selectors.",
  );
  const match = /^\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)\/?$/.exec(url.pathname);
  invariant(match, "Expected a native owner/repository/pull/number URL.");
  return {
    url: url.href,
    host: hostname(url.hostname),
    repository: slug(match[1]),
    number: positive(match[2]),
  };
}

function providerURL(value: unknown, repository: string, number: number): string {
  const raw = text(value, "Projection URL");
  invariant(raw.length <= 4096 && !/[\s\\]/.test(raw), "Invalid projection URL.");
  const url = new URL(raw);
  invariant(
    ["https:", "http:"].includes(url.protocol) &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    "Unsafe projection URL.",
  );
  invariant(
    url.pathname.endsWith(`/${repoPath(repository)}/pulls/${number}`),
    "Projection URL disagrees with its recorded repository and PR number.",
  );
  return url.href;
}

/** Interpret only AGS-owned mapping facts. No provider API or URL guessing. */
function projectionOf(body: Record<string, unknown>, head: string): Projection {
  if (body.external_projections === null || !Array.isArray(body.external_projections))
    return { status: "unavailable", reason: "projection_observation_unavailable" };
  invariant(body.external_projections.length <= 100, "Projection response exceeded its bound.");
  const rows = body.external_projections
    .map((value) => record(value))
    .filter((row) => row.provider === "forgejo");
  if (rows.length > 1) return { status: "conflict", reason: "multiple_forgejo_mappings" };
  if (rows.length === 1) {
    const row = rows[0]!;
    const repository = slug(row.external_repo),
      number = positive(row.external_number);
    const url = providerURL(row.external_url, repository, number);
    const currentHead = row.last_synced_sha === head;
    // A stable mapped PR URL can be useful before its latest head has synced.
    // Preserve both facts instead of labelling stale evidence fully projected.
    return { status: currentHead ? "projected" : "pending", repository, number, url, currentHead };
  }
  if (body.projection_job === null || body.projection_job === undefined)
    return { status: "not_observed", reason: "no_recorded_forgejo_job_or_mapping" };
  const job = record(body.projection_job);
  if (job.provider !== "forgejo")
    return { status: "unavailable", reason: "unexpected_projection_job" };
  if (
    job.phase === "failed_terminal" ||
    job.phase === "needs_rebase" ||
    job.status === "terminal_failed"
  )
    return { status: "failed", reason: "projection_requires_attention" };
  if (job.phase === "projected" || job.status === "projected")
    return { status: "unavailable", reason: "completed_job_without_durable_mapping" };
  if (
    [
      "queued",
      "preflight",
      "rebasing",
      "projection_resume",
      "verifying_pr",
      "pushing_ref",
      "verifying_ref",
      "ensuring_pr",
      "recording_projection",
      "failed_retryable",
    ].includes(String(job.phase))
  )
    return { status: "pending" };
  return { status: "unavailable", reason: "unknown_projection_phase" };
}

export const collectAssociation = (input: Input) =>
  Effect.gen(function* () {
    const supplied = yield* attempt("created_pr_locator", () => parseCreatedPRURL(input.url));
    const waitMs = yield* attempt("projection_wait", () => {
      const seconds = input.waitSeconds ?? 5;
      invariant(
        typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 && seconds <= 30,
        "wait-seconds must be between 0 and 30.",
      );
      return Math.floor(seconds * 1000);
    });
    const rt = yield* runtime(input);
    yield* attempt("collection_environment", () =>
      invariant(
        routingOverrides(rt.options.env).length === 0,
        "Remove repository/credential overrides before collecting origin-bound links.",
        "config_error",
      ),
    );
    const selected = yield* target(input);
    yield* attempt("collection_target", () => {
      invariant(
        selected.repository === supplied.repository,
        "The reported PR belongs to a different repository; no authenticated request was sent.",
        "conflict",
      );
      const hosts = ghHosts(rt.ghConfig).hosts;
      const explicitAlias =
        Object.hasOwn(hosts, supplied.host) &&
        hostname(record(hosts[supplied.host]).api_host ?? supplied.host) === selected.apiHost;
      invariant(
        supplied.host === selected.host || supplied.host === selected.apiHost || explicitAlias,
        "The reported PR host is not the origin or a configured alias of its API; no authenticated request was sent.",
        "conflict",
      );
    });

    let verified = false,
      reads = 0;
    const receipt = (projection: Projection) => ({
      schema: "agsx.pr-links.v1",
      ags: {
        url: supplied.url,
        repository: supplied.repository,
        number: supplied.number,
        verified,
      },
      forgejo: projection,
      reads,
      readOnly: true,
      retryCreation: false,
      // The collector never claims it issued a mutation or determines gh's exit.
      creationAuthority: "official-gh-caller",
    });
    if (selected.host === "github.com" || selected.host.endsWith(".ghe.com"))
      return receipt({ status: "not_applicable", reason: "not_an_ags_collection_target" });

    const observe = Effect.gen(function* () {
      const auth = yield* credential(input, selected.host),
        http = yield* HttpTransport;
      const until = performance.now() + waitMs;
      let last: Projection = { status: "not_observed" };
      do {
        const remaining = Math.floor(until - performance.now());
        if (reads > 0 && remaining < 50) return last;
        const first = reads === 0;
        reads++;
        const response = yield* http.request({
          endpoint: selected.endpoint,
          path: `/api/v3/repos/${repoPath(supplied.repository)}/pulls/${supplied.number}`,
          method: "GET",
          credential: auth.token,
          timeoutMs: first && waitMs === 0 ? 5000 : Math.max(50, Math.min(5000, remaining)),
          maxBytes: 1024 * 1024,
          ...(auth.caFile ? { caFile: auth.caFile } : {}),
        });
        // Authentication, unavailable observations and malformed results are not
        // retried. Only pending or not-yet-observed projection states are polled.
        if (response.status !== 200)
          return {
            status: "unavailable",
            reason: `ags_read_http_${response.status}`,
          } as Projection;
        last = yield* attempt("projection_receipt", () => {
          const body = record(response.body);
          invariant(
            body.number === supplied.number &&
              record(record(body.base).repo).full_name === supplied.repository,
            "Native PR readback disagrees with its fixed target.",
            "conflict",
          );
          const head = sha(record(body.head).sha);
          verified = true;
          return projectionOf(body, head);
        });
        if (last.url || !["pending", "not_observed"].includes(last.status) || waitMs === 0)
          return last;
        const delay = Math.min(250, Math.floor(until - performance.now()));
        if (delay < 50) return last;
        yield* Effect.sleep(delay);
      } while (performance.now() < until);
      return last;
    });
    const outcome = yield* observe.pipe(
      Effect.catch((error) =>
        Effect.succeed<Projection>({
          status: error.code === "conflict" ? "conflict" : "unavailable",
          reason: `association_${error.code}`,
        }),
      ),
    );
    return receipt(outcome);
  });
