# Contributing

## Scope

Improve the smallest necessary companion boundary. Ordinary repository, PR and CI
commands belong to official gh; standard API defects belong to AGS. Do not add a
second `pr` command tree, hidden gh/git shim, private host registry, grant control
plane or provider credential fallback.

The independent project does not reorganize the AGS Fork or couple its upstream
sync to a JavaScript monorepo. Changes to the server live in that repository; this
project consumes its published protocol and tests explicitly selected source pairs.

## Development

```bash
bun install --frozen-lockfile
node scripts/task.mjs check
node scripts/task.mjs format-check
```

Node.js 22.18+ runs build, tests and runtime. Bun is dependency-installation only.
All versions belong to the package catalog and bun.lock. Keep Effect beta packages
aligned. `node scripts/task.mjs format` formats source; no unrelated lockfile.

## Boundary tests

Tests should demonstrate outcomes: host configuration isolation, actual Git
credential protocol, ordinary official gh behavior, association vs permission,
unknown setup cleanup, revoked identity, preserved other accounts and single-slot
installation. Do not restore tests whose only purpose is preserving retired PR or
grant command shapes. Fixtures use example.test/loopback and synthetic identities.

For joint acceptance, build the candidate and run:

```bash
node scripts/compat.mjs --server-checkout /absolute/path/to/agent-git-service
```

The selected Fork must contain `scripts/gh-native-acceptance.mjs`. It builds that
source and downloads a hash-pinned official gh; worker effects run in a new Linux
user+network namespace with loopback only. Missing namespace support is a hard
failure, not permission to test against production. This is opt-in because it
requires Go, Git, OpenSSL, curl, tar, ip and Linux namespace support. No signed
release or actual cloud-provider workload is implied by synthetic backend tests.

## Contribution and publication

Keep linear, reviewable commits. Source provenance and actual runtime version are
separate facts. Do not copy private rollout transcripts, source tokens or machine
coordinates into the repository. A local branch is not a remote release; source
changes do not imply installing a new client for the team.

The public repository is https://github.com/yoyooyooo/agsx. Issues go there.
`0.2.0` was published from a maintainer machine so the npm name could exist.
Later versions are not published locally.

From a clean `main` that matches `origin/main`:

```bash
bun run release:precheck -- 0.2.1
bun run release -- 0.2.1
```

`release` pushes only the annotated tag `v0.2.1`. It does not push `main` and
does not run `npm publish`. GitHub Actions `publish.yml` builds the standalone
package, rejects a tarball that still contains `catalog:`, and publishes it
with Trusted Publishing. The GitHub environment name is `npm-publish`. A pushed
tag is immutable. If that attempt fails and `npm view` still returns 404 for
the version, choose a new version. Do not move the tag. A GitHub Release is
created only after the registry readback succeeds. If publish succeeded and
only the Release failed, rerun the workflow on that same tag.
