# Release transitions

## Compatible dev.3 to dev.4 v2 upgrade

The dev.4 candidate preserves the existing v2 namespace, administrator settings,
sessions, Runner records, policies and Jobs. It adds the source-throttle table
when missing and runs a one-time metadata-only audit migration which deletes
old MCP audit history. It does not import retired namespaces or rewrite core
schemas. Confirm migration completion and review provider backup/PITR copies
after deployment; do not restore content-bearing history without cleanup.
First setup has no additional bootstrap token and is not reopened for existing
instances. Publish a new immutable signed dev.4 Runner before activating its
empty production distribution gate. Host upgrades remain separately authorized.

## Earlier clean-break transition into v2

This release starts a new data, profile, and Runner/Worker protocol boundary. It does not inspect, import, repair, or translate data from an earlier layout. The `v2` Durable Object migration binds the Worker to fresh `RegistryDOv2` and `RunnerDOv2` classes; any retired namespace remains isolated and is never upgraded in place.

Local profiles, state directories, and service manifests are likewise release-specific. The Runner does not discover or import files from another installation. Keep any earlier installation stopped and separately backed up, then enroll a new Runner and review its policy in the Admin Panel.

## Required transition

1. Record and protect the previous deployment and host data separately. A backup is for audit or archival purposes; it is not an input to an automatic migration.
2. Apply the checked-in `v2` Durable Object migration during deployment (it provisions fresh Registry/Runner storage) and configure `ADMIN_TOKEN`, `RUNNER_TOKEN_PEPPER`, and `INTERNAL_CONTROL_SECRET`.
3. Complete first-time administrator setup.
4. Create each Runner in the Admin Panel with an explicit `execution_mode`, generate a one-time enrollment code, and enroll the current Runner package.
5. Configure approved workspace roots and permissions in the Admin Panel. Central management starts with zero local workspaces; the local CLI exposes `workspace list` for inspection only.
6. Create MCP clients with least-privilege scopes and distribute each one-time URL through a protected channel.
7. Wait for a policy acknowledgement, run `runmesh doctor --json` on each host, and verify a representative read/edit/job workflow before opening access to users.

There is no supported in-place schema repair, data import command, profile conversion command, or automatic credential transfer. Re-enrollment issues new credentials and does not infer workspace roots, execution mode, or permissions from a previous installation.

## Profile and service requirements

The current profile format must contain a valid `execution_mode` (`dedicated_user` or `privileged_host`), `management_mode: central`, and no local workspace entries. An incomplete or otherwise incompatible profile is rejected and must be replaced by a fresh enrollment. System installation requires an explicit execution mode; `privileged_host` also requires the visible confirmation acknowledgement.

Use the current Runmesh package and the profile path printed by the enrollment flow. Do not copy a profile or service manifest between releases, and do not point `runmesh start` at local workspace flags. Workspace roots and permissions are authoritative in the Admin Panel and are delivered only in authenticated policy frames.

## Rollback and recovery

Treat this boundary as a new installation, not a rolling schema upgrade. Keep the previous deployment available for independent rollback only while its own namespace and hosts remain intact; never run older code against this release's namespace or newer code against an incompatible namespace. A failed local package or service activation may be recovered from the host's verified package backup and managed service pointer, but this does not restore a redeemed enrollment code or Runner credential.

If access must be withdrawn, revoke or rotate Runner credentials and MCP client URLs, regenerate enrollment codes, stop host services, and inspect already-running local jobs separately. Removing a hosted-bootstrap acknowledgement only prevents future installer rendering; it does not revoke credentials or terminate host processes.

## Release gates

Hosted bootstrap is available only when the immutable release has been independently verified, the Worker has the exact release acknowledgement, and `RUNMESH_PUBLIC_ORIGIN` is a canonical external HTTPS origin. Otherwise use the portable artifact, verify its signature and checksums from an independent trust path, then run `runmesh enroll --server ... --code-stdin` followed by `runmesh install`.

Before rollout, run the repository's version, format, license, architecture, typecheck, unit-test, package, and Worker dry-run checks. Local checks do not prove provider quotas, edge-log redaction, native service lifecycle behavior, or external MCP-client acceptance; perform those as separate deployment acceptance tests.

## Security boundary

Central policy must be acknowledged before protected operations are authorized. Internal Worker/DO requests use versioned, timestamped, nonce-bound HMAC and reject duplicate nonces. Retained Registry metadata can support bounded offline inspection, but it never grants live host access; filesystem, execution, complete logs, input, and cancellation require live Runner admission.
