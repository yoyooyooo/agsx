# Security and release boundaries

This repository is an unpublished independent rebuild. It must not replace an existing AGS client, mutate a running AGS deployment, or publish a package without a separate maintainer decision.

## Protected boundaries

Credentials are selected only by an explicit AGS Context or operator manifest. Native Human/service credentials and task-scoped workload credentials must not be mixed. API calls do not fall back to GitHub/provider accounts, another endpoint, or broad administrator authentication.

Configuration and secret files must be canonical owner-controlled files. Symbolic links, group/world-readable secrets, ambiguous origins, unknown input fields and unsafe local install destinations fail closed. Non-loopback plaintext HTTP requires explicit opt-in; encrypted private networking is an operator responsibility, not inferred by the CLI.

Writes require explicit execution, and ordinary business HTTP requests are never automatically replayed. Unknown outcomes remain durable local records until they can be reconciled. A local invocation record is not a distributed transaction or proof of server-side idempotency. Provider operations are not atomically coordinated across services.

The Git adapter uses a temporary exact-host/repository credential helper, rejects arbitrary remote executables/config overrides, and removes the temporary file on exit. Existing global Git configuration is not overwritten. Git operations remain real Git operations: local hooks and explicitly requested local commands run in the user's own authority. This CLI is not a sandbox for untrusted repositories. Review a repository's hooks and config before running local commit/rebase operations.

Cancellation and timeouts clean up owned HTTP sockets, subprocess groups and temporary directories. Downloads, server fixtures, Git clones and install candidates have explicit owners and lifetimes. Authoritative server data is never swept by a generic client cleanup routine.

## Disclosing an issue

No public hosting or security contact has been established for this development repository. Until the project is published, report suspected issues directly through the maintainer's existing private collaboration channel. Do not create an invented public security address.

Provide a minimal synthetic reproduction, affected source/build identity and the boundary that was crossed. Do not include tokens, personal topology, private repository contents, production database copies or full unsanitized logs.

## Before public release

Complete license/contribution ownership review, independent source/history and artifact secret scanning, exact release provenance/signing, platform acceptance, workload/provider interoperability, and a separately authorized migration plan. The local build manifest verifies content identity only; it does not attest a publisher or authorize remote code.

The default tests are isolated and do not require production services. The optional real-server fixture is a pinned public artifact, starts only in a private user/network namespace and uses disposable credentials/data. Failure to obtain that isolation is a failed prerequisite, never permission to use ordinary networking.
