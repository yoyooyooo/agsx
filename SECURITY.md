# Security boundaries

This is an npm-distributed companion, not an authentication authority, policy engine,
OS sandbox or replacement GitHub CLI. Report defects privately to the repository
owner before publication; do not include credentials or production transcripts.

## Credentials and targets

- Official gh owns host login state. Setup changes only one explicitly selected
  AGS host after verifying its native account; GitHub login remains gh's own flow.
- No GH_TOKEN/GITHUB_TOKEN/GH_ENTERPRISE_TOKEN fallback is used by companion API
  requests. It asks official gh for the selected host's credential, captures that
  output internally, and never serializes raw stdout on failures.
- No request redirects to another origin. Custom CA is explicit; certificate
  checks cannot be disabled. Display/provider URLs never select authentication.
- Explicit `api_host` supports a trusted API gateway with official gh 2.100+.
  The canonical Git host remains the credential owner. Both endpoints must be
  trusted: official gh calls this experimental and not a security boundary.
  Setup binds the chosen API host into its plan; sessions preserve that endpoint
  for readback/revocation and reject an installed gh that cannot honor it.
- Hostnames are canonical and port-free for standard HTTPS APIs. Auxiliary
  association queries require a canonical origin. SSH alias handling and complete
  multi-remote selection remain official gh responsibilities.
- Credential files are bounded owner-only regular files, with no symlink traversal.
  Official gh config directories can be readable but cannot be group/world-writable.
  Companion-owned task directories are private. Setup uses its own lock and stale
  checks; users must not concurrently mutate the same file through gh auth itself.

## Task sessions

The server inherits a real native actor and live parent credential; metadata does
not create another principal, membership or permission. Run tokens are short-lived,
stored only by hash server-side, and revoked when their parent is removed. They
cannot read/mint durable account credentials. Task metadata may be incomplete and
is labelled honestly; missing association does not block an already authorized PR.

Session setup is once at the task launch boundary. environment.json contains
paths and standard Git helper settings, never a token or PATH shim. Only the
selected task's gh/hosts.yml stores its run token. Parallel tasks have independent
credentials, directories and run IDs. The native parent token is not copied.

Git's standard credential helper protocol is target scoped and does not execute
Git commands. It ignores repeated non-target negotiation fields, rejects duplicate
target coordinates, and returns nothing outside the explicitly recorded Git/API
transport and repository scopes. Neither
this helper nor GH_CONFIG_DIR is an OS sandbox: code running as the same OS user
may independently access that user's other files or credential stores. The
component does not claim system keyring isolation or containment of malicious
agents; it prevents unintended identity/routing conflation in the supported flow.

A caller-generated UUID allows a lost setup result to be revoked without reissuing
credentials. Unknown writes are never retried automatically. Local cleanup touches
only known owned files, not the entire caller directory or parent credential.
Session renewal/rotation is not automatic; the task launcher owns TTL selection,
termination and any future explicit lifecycle extension. No hidden background agent
or daily-command grant loop is installed.

## Build and installation

Bun only installs pinned dependencies. Node runs build, tests and the client.
Candidates have file digests, source identity and license notices, but a self-held
manifest is not a publisher signature. Installation uses one slot, a lock and an
interruption marker. It does not manage global npm, replace official gh/git, or
retain historical release directories. Publication is blocked until explicitly
approved.

Default tests use local synthetic resources. Real-client acceptance runs current
AGS and pinned official gh inside an isolated loopback-only namespace, with no
production DB, credentials or CI jobs. Public source/CI logs must not include real
machine addresses, source tokens, task payloads or private operator manifests.
