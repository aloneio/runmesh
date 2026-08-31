# Runmesh Migration Guide

## Current baseline

This branch uses Runmesh-specific layouts for new installations. The Runner does not automatically discover, import, or move legacy `remote-coding-runtime` / `RemoteCodingRunner` profiles, state directories, or service manifests; those names are manual migration references only, not automatic compatibility paths. Before installing the Runmesh service, inspect, back up, and stop or disable any legacy service. Either perform a fresh enrollment or explicitly point the CLI at a reviewed profile with `--profile`, `RUNMESH_RUNNER_PROFILE`, or `CODING_RUNNER_PROFILE`.

Profiles that omit `execution_mode` or `management_mode` are reported as `migration_required`; they are not silently treated as privileged-host or legacy-manual profiles. Choose `dedicated_user` or explicitly acknowledge `privileged_host` with `--confirm-privileged-host` before system installation, and run `coding-runner workspace migrate --management-mode central` or `coding-runner workspace migrate --management-mode legacy_manual` to choose the workspace authority model. Re-enrollment changes connection credentials and metadata only and does not migrate old workspace roots automatically. Hosted bootstrap is unavailable in `v0.1.0-dev.2`: download and verify a portable artifact, then use the Panel-generated one-time code with `coding-runner enroll` followed by `coding-runner install`.

## Migration behavior

Runner policy migration is additive and fail-closed. After schema repair, an old applied row is retained only when its complete immutable snapshot and desired/applied/reported revision/checksum identities can be validated. Otherwise the Registry creates a newer desired snapshot from current administrative configuration, clears trusted applied/reported identity, and marks the Runner pending or offline_pending until a fresh acknowledgement. The operation is idempotent and does not delete Runner, Client, Workspace, or Job data.

1. Back up the deployed Worker and Registry Durable Object data.
2. Configure the setup token (`SETUP_TOKEN`) or preferably its SHA-256 verifier (`SETUP_TOKEN_HASH`) before first setup on a new instance.
3. Deploy the Worker and allow its additive SQLite schema repair and policy migration to run.
4. Inspect old Runner records and profiles. Do not treat local synchronized workspaces as central authorization.
5. Enroll or re-enroll the Runner, then explicitly review managed Workspace paths and permissions in the Panel.
6. Apply the central policy and wait for a valid Runner policy acknowledgement before using live MCP workspace operations.
7. For offline metadata, use only the retained Registry snapshot; logs and host operations require live Runner admission.
8. Run `coding-runner doctor --json` and confirm required checks are healthy.



Application rollback is safe only when the previous Worker code remains compatible with the additive schema. Take a database backup before deployment. Runner service manifests are hash-marked and refuse unmanaged replacement. If a package installation or service activation fails, retain the previously active package and restore it using the operator's package backup. Do not delete Registry data as a rollback mechanism.

## Compatibility

The old `remote-coding-runtime` package and system-directory names are not auto-detected or migrated in this release. Treat them as manual migration inputs only: back up their profile and state, stop or disable the old service, and explicitly select a reviewed profile or perform a fresh enrollment. New package names are `@aloneio/runmesh-protocol` and `@aloneio/runmesh-runner`. The compact public MCP catalog includes `inspect` in addition to the previous eight-tool surface; legacy narrow RPC names remain internal.

## Security changes

Central policy must be acknowledged before authorization. Internal Worker/DO requests use versioned, timestamped, nonce-bound HMAC and duplicate nonces are rejected. Snapshot authorization for Runner/job metadata does not grant live host access; host operations require live Runner admission. Setup requires the configured setup token and administrator password.
