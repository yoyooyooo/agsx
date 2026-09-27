import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { collectAssociation, parseCreatedPRURL } from "../dist/application/collect.js";
import { problem } from "../dist/domain/errors.js";
import { fixture, provided, call } from "./helpers.mjs";

function setup(t) {
  const f = fixture(t),
    directory = join(f.root, "gh");
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(
    join(directory, "hosts.yml"),
    "primary:\n  api_host: api.example.test\nprimary.example.test:\n  api_host: api.example.test\n",
    { mode: 0o600 },
  );
  const input = {
    gh: process.execPath,
    ghConfig: directory,
    url: "https://primary:6666/team/project/pull/7",
    waitSeconds: 0,
  };
  const processes = [],
    requests = [];
  const runProcess = (spec) => {
    processes.push(spec);
    assert.ok(!spec.args.includes("create") && !spec.args.includes("--apply"));
    const stdout =
      spec.args[0] === "remote"
        ? "http://primary.example.test:6666/team/project.git"
        : spec.args[0] === "auth"
          ? "synthetic-native-only"
          : "gh version 2.101.0\n";
    return Effect.succeed({ exitCode: 0, stdout, stderr: "" });
  };
  const head = "a".repeat(40);
  const body = {
    number: 7,
    base: { repo: { full_name: "team/project" } },
    head: { sha: head },
    external_projections: [],
    projection_job: { provider: "forgejo", phase: "queued", status: "queued" },
  };
  const ready = () => ({
    ...body,
    external_projections: [
      {
        provider: "forgejo",
        external_repo: "ci/project",
        external_number: 23,
        external_url: "https://forgejo.example.test/ci/project/pulls/23",
        last_synced_sha: head,
      },
    ],
  });
  const run = (response = body, extra = {}) =>
    provided(
      f,
      collectAssociation({ ...input, ...extra }),
      (req) => {
        requests.push(req);
        assert.equal(req.method, "GET");
        assert.equal(req.endpoint, "https://api.example.test");
        assert.equal(req.path, "/api/v3/repos/team/project/pulls/7");
        assert.equal(req.credential, "synthetic-native-only");
        return response instanceof Function
          ? response(req)
          : Effect.succeed({ status: 200, body: response, text: "", headers: {} });
      },
      runProcess,
    );
  return { f, input, body, ready, run, processes, requests, process: runProcess };
}

test("collect preserves native identity and returns a distinct stored Forgejo URL", async (t) => {
  const s = setup(t);
  const result = await s.run(s.ready());
  assert.equal(result.ags.url, s.input.url);
  assert.equal(result.ags.number, 7);
  assert.equal(result.ags.verified, true);
  assert.equal(result.forgejo.number, 23);
  assert.equal(result.forgejo.url, "https://forgejo.example.test/ci/project/pulls/23");
  assert.equal(result.forgejo.status, "projected");
  assert.equal(result.readOnly, true);
  assert.equal(result.retryCreation, false);
  assert.equal(s.requests.length, 1);
  assert.ok(!JSON.stringify(result).includes("synthetic-native-only"));
  const schema = await call(s.f, "schema", { command: "association.collect" });
  assert.equal(schema.result.data.commands[0].risk, "read");
});

test("collect validates URL and canonical aliases before reading any credential", async (t) => {
  const s = setup(t);
  for (const url of [
    "https://untrusted.example.test/team/project/pull/7",
    "https://primary:6666/other/project/pull/7",
    "https://name:password@primary/team/project/pull/7",
    "https://primary/team/project/pull/7?token=fixture",
    "https://primary/team/project/pull/7\nhttps://forgejo.example.test/ci/project/pulls/23",
  ]) {
    await assert.rejects(s.run(s.ready(), { url }));
  }
  assert.equal(s.requests.length, 0);
  assert.ok(s.processes.every((p) => p.args[0] !== "auth"));
  assert.throws(() => parseCreatedPRURL("https://primary/team/project/pull/9007199254740992"));
  assert.throws(() => parseCreatedPRURL("https://primary/team%2fother/project/pull/7"));
  await assert.rejects(s.run(s.ready(), { waitSeconds: 31 }));
});

test("collect waits only for pending observations and never replays a create", async (t) => {
  const s = setup(t);
  let number = 0;
  const result = await s.run(
    () =>
      Effect.succeed({
        status: 200,
        body: ++number === 1 ? s.body : s.ready(),
        text: "",
        headers: {},
      }),
    { waitSeconds: 1 },
  );
  assert.equal(result.forgejo.status, "projected");
  assert.equal(result.reads, 2);
  assert.equal(s.requests.length, 2);
  assert.ok(s.requests.every((r) => r.method === "GET"));
  assert.ok(s.processes.every((p) => !p.args.includes("create")));
});

test("pending, disabled/unknown and failed projections preserve the native PR", async (t) => {
  const s = setup(t);
  const pending = await s.run();
  assert.equal(pending.forgejo.status, "pending");
  assert.equal(pending.forgejo.url, undefined);
  const missing = await s.run({ ...s.body, projection_job: null });
  assert.equal(missing.forgejo.status, "not_observed");
  const failed = await s.run({
    ...s.body,
    projection_job: {
      provider: "forgejo",
      phase: "failed_terminal",
      last_error: "private-provider-diagnostic",
    },
  });
  assert.equal(failed.forgejo.status, "failed");
  assert.equal(failed.ags.verified, true);
  assert.equal(failed.retryCreation, false);
  assert.ok(!JSON.stringify(failed).includes("private-provider-diagnostic"));
  const start = performance.now();
  const bounded = await s.run(s.body, { waitSeconds: 0.08 });
  assert.equal(bounded.forgejo.status, "pending");
  assert.ok(performance.now() - start < 600);
  assert.ok(bounded.reads < 3);
});

test("malformed, redirected and unavailable reads do not discard the original URL or retry", async (t) => {
  const s = setup(t);
  for (const response of [
    () => Effect.succeed({ status: 401, body: null, text: "", headers: {} }),
    () => Effect.fail(problem("conflict", "redirect refused", "http_redirect")),
    () => Effect.fail(problem("unavailable", "fixture transport failure", "http_transport")),
    { ...s.body, number: 8 },
    { ...s.body, external_projections: null },
    {
      ...s.ready(),
      external_projections: [
        {
          ...s.ready().external_projections[0],
          external_url: "https://user:secret@forgejo.example.test/ci/project/pulls/23",
        },
      ],
    },
  ]) {
    const before = s.requests.length;
    const result = await s.run(response, { waitSeconds: 1 });
    assert.equal(result.ags.url, s.input.url);
    assert.equal(result.retryCreation, false);
    assert.ok(["unavailable", "conflict"].includes(result.forgejo.status));
    assert.equal(s.requests.length, before + 1);
    assert.ok(!JSON.stringify(result).includes("user:secret"));
  }
});

test("a stale but real provider PR address is returned without claiming current-head convergence", async (t) => {
  const s = setup(t),
    body = s.ready();
  body.external_projections[0].last_synced_sha = "b".repeat(40);
  const result = await s.run(body, { waitSeconds: 5 });
  assert.equal(result.forgejo.status, "pending");
  assert.equal(result.forgejo.currentHead, false);
  assert.equal(result.forgejo.number, 23);
  assert.equal(s.requests.length, 1);
});

test("ambiguous provider mappings cannot produce a guessed link", async (t) => {
  const s = setup(t),
    body = s.ready();
  body.external_projections.push({ ...body.external_projections[0], external_number: 24 });
  const result = await s.run(body);
  assert.equal(result.forgejo.status, "conflict");
  assert.equal(result.forgejo.url, undefined);
  assert.equal(result.ags.number, 7);
});

test("cancelling a collector interrupts its in-flight read instead of leaving polling behind", async (t) => {
  const s = setup(t);
  let cancelled = false,
    started = false;
  const effect = collectAssociation(s.input).pipe(Effect.timeout(100));
  await assert.rejects(
    provided(
      s.f,
      effect,
      () =>
        Effect.callback(() => {
          started = true;
          return Effect.sync(() => {
            cancelled = true;
          });
        }),
      s.process,
    ),
  );
  assert.equal(started, true);
  assert.equal(cancelled, true);
});
