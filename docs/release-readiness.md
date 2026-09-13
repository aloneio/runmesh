# Release readiness — 0.1.1 unreleased stable candidate

**State: UNRELEASED. Hosted distribution: DISABLED in this checkout.** A source version is not a published release. No existing immutable preview is overwritten. Live installations remain unchanged until an owner-approved rollout.

## Release identity and authority

The source contract targets `0.1.1`, tag `v0.1.1`, channel `stable`, `prerelease=false`, protocol v2 and `runmesh-runner-0.1.1.tgz`. The signing key remains the independently reviewed `runmesh-preview-2026-01` public-key identity; its name does not determine release channel. Never replace the trust keyring with one downloaded alongside an untrusted artifact.

Only the repository owner may start or rerun publication. Release verification calls the complete reusable CI workflow at the triggering SHA, without inheriting signing secrets. Signing requires all verification jobs to succeed. The aggregate `verify-all` requires the general gate, Ubuntu/Windows/macOS native Runner checks and both supported Node lines. Failed, cancelled or skipped dependencies block publication; external Actions references remain immutable commit pins.

The owner must independently verify live branch/tag protection, require `verify-all`, protect the `release` environment, confirm immutable releases, and save the provider deployment ID/logs for the approved SHA. Source workflows do not prove that GitLab mirroring, Cloudflare build connections or repository administration settings are correct. Do not automatically deploy an unreviewed branch update or reuse a previous SHA's green checks.

## Runtime and deployment secrets

The private bootstrap runtime is **Node 22.23.2**, with six official platform archive hashes pinned in source. External runtimes are restricted to **22.23.2+ within 22.x** or **24.21.0+ within 24.x**. EOL and untested majors are rejected by the CLI. OS-wide Node upgrades do not update Runmesh's private executable.

Official sources: https://nodejs.org/en/blog/release/v22.23.2 and https://nodejs.org/dist/index.json. Recheck supported releases and official SHA256SUMS for every release; passing tests cannot establish that a binary has no vulnerabilities.

`ADMIN_TOKEN`, `INTERNAL_CONTROL_SECRET` and `RUNNER_TOKEN_PEPPER` each require 32–512 randomly generated non-whitespace characters, without HTTP control bytes. Generate independent secrets (for example, 32 random bytes encoded as hex). Length validation rejects obviously invalid configuration; it cannot measure entropy. Privately validate existing production values before deployment. Never print them in logs or Git, or rotate the pepper/internal secret without planning Runner re-enrollment and session impact.

First setup still requires **no extra bootstrap token**. Initialize new instances behind a trusted access boundary before public exposure. Existing `dedicated_user` defaults and explicit `privileged_host` confirmation are preserved. Both modes retain one-command enrollment with a quoted single-use code; omitting it retains the hidden prompt. Commands containing the code must remain private.

## Mutations, pagination and recovery

Patch constructs and validates independent JSON success metadata before staging or committing. Cycle, accessor, unsupported value, depth and node-count validation remain intact. Normal success metadata is capped at 32 KiB, reserving 16 KiB for bounded recovery warnings, so the result fits the 48 KiB budget and MCP envelope. Oversized predicted results are rejected before files change; split large operations rather than blindly retrying them.

Runner read/list/search pages are limited by actual UTF-8 JSON bytes, including escaping, and carry their actual next cursor. Public RPC input is checked with its complete correlation/policy envelope before forwarding. Capacity errors use `busy`, not `invalid_request`.

Preparation may overlap, but canonical-workspace commits, revalidation and rollback serialize within a Runner process. Same-baseline concurrent changes must yield a clean conflict without overwriting a successful update or leaving a backup. This is not a multi-process filesystem lock or distributed exactly-once transaction. Host-local writers, OS failures, lost replies and Runner termination still require rereading state before retrying. Transport errors do not prove that nothing changed; inspect explicit recovery warnings.

Purge checks both lexical and canonical identities of active/previous workspace roots against each deletion target, then rechecks before deletion. Unknown, inaccessible, malformed or overlapping roots fail closed. Test destructive lifecycle behavior only on disposable hosts. Retaining uncertain data is safer than deleting it.

Audit retention has an independent expiry alarm without online Runners. Storage failure can delay physical cleanup and requires operator action. Successful fallback login attempts to clear stale SQL source counters, keeping a bounded pending reset for same-instance recovery if deletion fails. Simultaneous object eviction and total storage failure can lose volatile state; this is not a durable-success guarantee during unavailable storage. Other sources and shared KDF budgets are not reset.

## Controlled rollout

1. Freeze/review the new commit. Run local gates and require same-SHA remote CI, including actual Windows/macOS and supported Node lines. Exercise privileged install/enroll/start/re-enroll/purge/reinstall/failure recovery on disposable hosts, not the Runner serving the only maintenance connection.
2. Keep `RUNMESH_SIGNED_RELEASE_AVAILABLE` empty. Protect backups of Runner profiles, policy/jobs/logs, service/current pointer and verified packages. Verify provider-supported Durable Object backup/restore with an actual rehearsal. Current v2 data is retained; incompatible earlier schemas still require a fresh namespace. No automatic downgrade/import is promised.
3. Owner approval allows new immutable signed assets, never replacement of a preview. Independently verify signature, stable channel, exact commit, tarball hash/size, checksums, notices and trust keyring. Verify the final downloaded artifact, not merely a separate smoke-test pack.
4. Use console/out-of-band access for upgrades. Existing installers reject differently versioned managed installations; cross-version automatic upgrade is not implemented. Do not purge/restart the only maintenance Runner. Verify the new private runtime, CLI, service identity and authenticated write/search/policy canaries before general rollout.
5. Only after publication and independent verification set `RUNMESH_SIGNED_RELEASE_AVAILABLE=0.1.1` with canonical HTTPS `RUNMESH_PUBLIC_ORIGIN`. Save actual provider deployment evidence. Removing the acknowledgement disables future bootstrap but does not revoke credentials, terminate jobs, erase downloaded scripts or reverse redeemed codes.

## Operational acceptance remains separate

Code cannot establish production secret values, provider WAF/Access/log redaction, repository administration or native service lifecycle success. Root/SYSTEM shell remains explicitly unsandboxed. MFA, step-up authentication, backup automation, URL-secret log minimization and organizational approval require separately approved design or documented risk acceptance. Do not claim production GA acceptance before these decisions and rollout evidence are recorded.
