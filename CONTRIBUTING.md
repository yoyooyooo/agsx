# Contributing to the independent rebuild

The runtime is Node.js with TypeScript ESM and Effect v4 beta. Bun is used only for installing exact catalog dependencies. The empty workspace package list exists to host Bun's catalog; this is not a server/client monorepo.

```bash
bun install --frozen-lockfile
node scripts/task.mjs check
node scripts/task.mjs format
node scripts/task.mjs format-check
```

`check` runs strict TypeScript, architecture/dependency checks, standalone assembly and Node tests. It never calls a deployed AGS instance. `node scripts/compat.mjs` is an additional opt-in Linux x64 real-server test with a pinned public artifact and mandatory isolated network namespace.

## Ownership

- `src/domain`: schemas, command metadata, public errors and stable types.
- `src/platform`: bounded HTTP/process/filesystem services, injected through Effect Context/Layer.
- `src/application`: native AGS operations, routing, identity and reconciliation.
- `src/operator`: explicitly invoked provider/local-runtime maintenance, never ordinary-user defaults.
- `src/packaging`: local candidate verification and single-slot installation.
- `test`: real isolated filesystem/process/Git/HTTP/TLS fixtures and wire-contract cases.

Keep identity and effect rules server-owned. A feature is not complete because its command appears in help; update its parity row and exercise a real behavior and relevant negative boundary. Never weaken a check merely because a fixture or old server omits the required fact.

Add dependency versions to the root catalog, use `catalog:` references and update only `bun.lock`. No alternate package lock, floating beta, automatic release, private runner or production credential is allowed. Use Node scripts for compilation, formatting, tests and artifact assembly.

Changes to command input/output belong in the shared schema and protocol notes. Prefer concise predictable JSON, explicit target and bounded pagination; do not grow another flag compatibility parser or general plugin platform without a real use case.

All examples use loopback or `example.test`, synthetic identities and fake credentials. Do not copy the predecessor repository history, personal configuration or native binaries. The proposed project license is Apache-2.0; preserve exact bundled dependency licenses in `THIRD-PARTY-NOTICES.txt`.

This stage is local and unpublished. Do not remove `private: true`, weaken the publication guard, create a public remote, tag a release, change current machine installations, or delete the predecessor implementation without explicit authorization.
