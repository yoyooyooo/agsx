import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { presentUrls } from "../dist/application/presentation.js";
import { fixture, configure, call, child, TOKEN } from "./helpers.mjs";

test("Context display origins never become transport or credential selectors", () => {
  const target = {
    contextName: "test",
    context: {
      endpoint: "https://primary.example.test",
      instanceId: "test",
      aliases: ["http://127.0.0.1:6666"],
      publicUrls: { forgejo: "https://forge.example.test" },
    },
    identity: "human",
  };
  const source = {
    url: "http://127.0.0.1:6666/team/project/pull/1",
    body: "Do not rewrite user-authored text: http://127.0.0.1:6666/",
    external_projections: [
      { provider: "forgejo", external_url: "http://127.0.0.1:3000/team/project/pulls/77" },
    ],
    unsafe: { url: "https://user:password@primary.example.test/repo" },
    signed: { url: "https://primary.example.test/?token=sensitive" },
  };
  const result = presentUrls(source, target);
  assert.equal(result.url, "https://primary.example.test/team/project/pull/1");
  assert.equal(
    result.external_projections[0].external_url,
    "https://forge.example.test/team/project/pulls/77",
  );
  assert.equal(result.body, source.body);
  assert.equal(result.unsafe.url, null);
  assert.equal(result.signed.url, null);
  assert.equal(target.context.endpoint, "https://primary.example.test");
  assert.equal(
    source.external_projections[0].external_url,
    "http://127.0.0.1:3000/team/project/pulls/77",
  );
});
test("context show uses the repository origin without reading an unsafe token or global default", async (t) => {
  const f = fixture(t);
  configure(f, "http://127.0.0.1:6666");
  const run = async (args) => {
    const result = await child("/usr/bin/git", args, { cwd: f.cwd, env: f.env });
    assert.equal(result.code, 0, result.stderr);
  };
  await run(["init"]);
  await run(["remote", "add", "origin", "http://127.0.0.1:6666/team/project.git"]);
  // Incorrectly permissioned token must remain unread for route-only inspection.
  const config = JSON.parse(readFileSync(join(f.home, "config.json"), "utf8"));
  config.contexts.other = { endpoint: "https://other.example.test", instanceId: "other" };
  config.defaultContext = "other";
  writeFileSync(join(f.home, "config.json"), JSON.stringify(config), { mode: 0o600 });
  const result = await call(f, "context.show");
  assert.equal(result.result.data.context, "test");
  assert.equal(result.result.data.repository, "team/project");
  assert.equal(result.result.data.source, "origin");
  assert.equal(result.result.data.credentialRead, false);
  await assert.rejects(
    call(f, "context.show", { context: "other" }),
    (error) => error.code === "conflict",
  );
});
