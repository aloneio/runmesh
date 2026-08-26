# Runmesh Migration Guide

## Current baseline

This branch preserves the existing `remote-coding-runtime` layout for installed systems and adds explicit execution-mode and policy hardening. Existing profiles without `execution_mode` are treated as legacy privileged-host profiles; they are not silently rewritten. Re-enrollment changes credentials and connection metadata only.

## Upgrade sequence

1. Back up the deployed Worker and Registry Durable Object data.
2. Configure `SETUP_TOKEN` or preferably `SETUP_TOKEN_HASH` before first setup on a new instance.
3. Deploy the Worker and allow its additive SQLite schema repair to run.
4. Inspect old Runner records and profiles. Do not treat local synchronized workspaces as central authorization.
5. Enroll or re-enroll the Runner, then explicitly review managed Workspace paths and permissions in the Panel.
6. Select `dedicated_user` for the system service after provisioning the `runmesh` account/group and granting only required directory access.
7. Apply the central policy and wait for the Runner policy acknowledgement before using MCP workspace operations.
8. Run `coding-runner doctor --json` and confirm required checks are healthy.

## Rollback

Application rollback is safe only when the previous Worker code remains compatible with the additive schema. Take a database backup before deployment. Runner service manifests are hash-marked and refuse unmanaged replacement. If a package installation or service activation fails, retain the previously active package and restore it using the operator's package backup. Do not delete Registry data as a rollback mechanism.

## Compatibility

The old `remote-coding-runtime` package and system directory names remain compatibility paths in this release. New package names are `@aloneio/runmesh-protocol` and `@aloneio/runmesh-runner`. The compact public MCP catalog includes `inspect` in addition to the previous eight-tool surface; legacy narrow RPC names remain internal.

## Security changes

Central policy must be acknowledged before authorization. Internal Worker/DO requests use versioned, timestamped, nonce-bound HMAC and duplicate nonces are rejected. Host shell is not a workspace sandbox. Setup requires the deployment setup token and administrator password.
