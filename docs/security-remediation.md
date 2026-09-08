# Security remediation and rollout notes

## Candidate and deployment boundary

The source candidate is `0.1.0-dev.4`, distinct from immutable `0.1.0-dev.3`.
Workspace versions, generated modules, fixed installer and release workflow
must agree. Production distribution acknowledgement is empty until a new
signed release is authorized, published and independently verified. Local
checks do not deploy a Worker or upgrade an installed Runner. Never overwrite
an existing immutable asset.

Development requires Node 22.23.2 and npm 10.9.3. The portable Runner retains
Node `>=20`. Default Wrangler targets `runmesh-development`; intentional
production commands use `--env production`.

## First setup: explicit product decision

No separate bootstrap token is required. The first valid submission atomically
sets the administrator password; later setup attempts are rejected. Password
confirmation, CSRF, same-origin checks and bounded authentication attempts
remain. Existing initialized instances retain their passwords and sessions.
The removed bootstrap-token variable is no longer consulted.

An uninitialized public instance can be claimed by its first successful visitor.
This is the requested product behavior, not a risk claimed to be eliminated.
Complete setup before exposing the instance to untrusted traffic. Optional edge
controls can protect that interval without introducing an application token.

New Runners default to `dedicated_user`; new MCP clients to `coding:read`.
Existing authorizations are not rewritten. `privileged_host` is an explicitly
confirmed advanced option, not a sandbox.

## Metadata-only audit and legacy cleanup

Requested tool output is relayed through the Worker to the authenticated client,
not stored as audit content. Durable audit rows contain call, Runner, client,
method, workspace/job identifiers, status/error code, timing and connection
metadata. They contain no file paths, commands, file or log text, queries,
patches, diffs or input data. Retention is 1,000 records per Runner and seven
days; expired records are hidden immediately and cleaned during maintenance.

The first upgraded Registry construction runs the `mcp-metadata-only-v1`
transaction: delete legacy MCP audit history, then mark completion. It does
not delete administrator credentials, sessions, Runners, policies or Jobs.
Read-side projection also suppresses any legacy payloads. A quota failure
raises an audit-health warning and must be checked after rollout.

This is a migration for the next deployment, not proof that live Cloudflare
storage has already been cleaned. Review backups, point-in-time recovery and
exported logs separately. Live SQL deletion does not erase historical copies.
Do not restore an old snapshot without reapplying cleanup or roll back to a
payload-recording build.

## Enrollment credentials

Hosted copied commands intentionally include the single-use enrollment code for
convenience: copy and execute once, with no second code entry. The scripts accept
a positional code, `--code CODE`, and `--code=CODE`. Omitting the code retains the
hidden terminal prompt; the manual portable-artifact route is still available.
The downstream Runner receives the code through standard input, and no temporary
credential input file is created.

This explicitly accepts exposure of the complete command to command history,
process arguments and terminal/command capture. Treat it as a one-time credential,
keep it private, and regenerate the enrollment code when it has been disclosed.
This product choice does not restore administrator setup tokens, payload audit
logging, old release identities, or weaker artifact verification.

Re-enrollment through a managed existing install requires the exact fixed version. An older Runner requires a verified manual upgrade before code input. The Windows managed-marker check uses the Boolean result of Select-String, not a null comparison.

Worker HTTPS delivery remains the bootstrap trust root. An independently
verified portable artifact is the higher-assurance route.

## Authentication and availability

Session issuance atomically compares the generation whose password was verified.
An old-password login spanning rotation cannot obtain a new-generation session.
Registry settings errors, malformed responses and stalled reads return 503
before reserving a password attempt, so recovery is not followed by a false
password lockout. The settings request has a five-second abortable deadline.

Real KDF work remains limited: five initial attempts per HMAC-derived source,
backoff from 30 seconds to 15 minutes, and 120 attempts per minute for each
login/setup kind. Only trusted `CF-Connecting-IP` is used; raw IPs are not
stored and `X-Forwarded-For` is not trusted. Blocked-source checks are read-only.
Cleanup is sampled at most once per minute; full capacity evicts the oldest
unblocked source without resetting global CPU budgets. All-blocked capacity
or a saturated global budget still rejects admission. Memory fallback is
bounded but does not survive eviction. Distributed denial of service remains
an external Access/WAF/rate-limiting concern.

## Local boundaries and remaining acceptance

Linux directory enumeration pins a validated procfs directory handle. Search
counts actual bytes even for binary/invalid UTF-8 data, with file/entry/time
bounds. Its deadline is cooperative, not kernel-I/O cancellation. Windows/macOS
still require a reviewed native adapter for equivalent hostile-local-mutator
protection. A workspace is not an OS sandbox.

Git discovery verifies ownership, permissions, `.git` identity across
canonicalization and canonical confinement. The targeted replacement is rejected;
this is not proof that all later metadata accesses resist every local ABA race.

Administrator pages, including throttle errors, use fresh script nonces.
Inline styles still require `style-src 'unsafe-inline'`. CI pins Node/npm and
adds production validation, three native Runner platforms and Node 20 checks.
Adding CI jobs is not evidence those remote jobs have already passed.

New signed assets, production cleanup, Access/MFA/WAF, URL-log redaction,
backups, branch protection, Windows ACLs and macOS service lifecycle need
separate deployment acceptance. KDF migration, idle expiry, application step-up,
style extraction, module decomposition and measured coverage thresholds remain
follow-up work rather than completed claims.
