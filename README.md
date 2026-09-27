# agsx

[English](./README.md) | [中文](./README.zh-CN.md)

agsx connects an AGS host to the official `git` and `gh` you already use. It does not replace them.

```bash
npm install -g @yoyooyoooyoooo/agsx
agsx --version
agsx schema
```

Requires Node.js 22.18 or newer, Git, and official GitHub CLI.

## The problem

`git` and `gh` already create repositories, pull requests, and CI runs. An AGS host still needs three extra things: a one-time host entry in official gh, a task-scoped login that does not overwrite your normal GitHub login, and a read-only lookup of the Forgejo link after `gh pr create`. Wrapping gh to get those would become a second CLI, with its own PR commands and its own credentials.

## What you get

- `setup plan` shows the host change. `setup apply` writes one official gh host after checking the native account.
- `doctor` reports origin, gh config, and override variables. It stays offline unless you pass `--network`.
- `session start` prepares one task identity. `session end` revokes that run credential.
- `association collect` reads the AGS and Forgejo links for a pull request gh already created.
- `ci backend` shows which CI backend the server selected. It does not proxy checks or logs.

agsx has no pull request, CI, install, upgrade, or self-update commands.

## How it works

The npm package is one bundled Node program. The repository root is a private Bun workspace used for development. npm does not install that workspace.

agsx calls the `gh` binary on your machine. Setup changes one host in gh's own config and leaves every other host alone. A task session gets its own `GH_CONFIG_DIR` and a normal Git credential helper. It does not change `PATH`. Association only sends GET requests for a pull request that already exists. If the Forgejo projection is still pending, the result says so. It does not run `gh pr create` again.

## Install

```bash
npm install -g @yoyooyoooyoooo/agsx
```

Pin a version with `npm install -g @yoyooyoooyoooo/agsx@0.2.0`. Upgrade and remove it with npm. Installing the package does not switch accounts, rewrite remotes, or upgrade an AGS server.

An explicit API hostname in gh config needs official gh 2.100 or newer. That setting is not a security boundary.

## Quick start

From a repository whose `origin` is the host you want to connect:

```bash
agsx setup plan --host ags.example.test --token-file /private/ags.token
agsx doctor
agsx schema
```

`setup plan` does not write config. Apply only the plan you just reviewed. `agsx schema` prints the command list as JSON.

Create the pull request with gh, then collect the two links:

```bash
git push origin HEAD
pr_url="$(gh pr create --base main --title 'A change' --body 'What changed')" &&
  agsx association collect --url "$pr_url" --wait-seconds 5
```

The `&&` matters. If gh fails, collect does not run. If the projection is not ready, collect returns pending. It does not guess a Forgejo number and it does not open a second pull request.

Command details live in [docs/commands.md](docs/commands.md). The wire contract is [docs/protocol.md](docs/protocol.md).

## Security and limits

Credentials stay with official gh. agsx does not take `GH_TOKEN` as a fallback, and it does not follow a display URL onto another host. A task directory is private to that task. This is not an OS sandbox. See [SECURITY.md](SECURITY.md).

agsx does not manage global npm, replace `git` or `gh`, or retain old installation directories. `0.2.0` was published from a maintainer machine and has no npm provenance. Later versions are published by the tag workflow in `.github/workflows/publish.yml`.

## Develop

```bash
bun install --frozen-lockfile
npm test
npm run format:check
```

Bun only installs the locked development dependencies. Node runs the tests and the CLI. The next npm release is an annotated tag, not a local `npm publish`. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
