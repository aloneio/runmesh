# Upgrade an existing installation

[简体中文](upgrading.zh-CN.md) · [Documentation](README.md)

This guide applies to an existing protocol-v2 deployment. A code update is not a new installation. Do not reset Durable Object namespaces, replace D1, rotate secrets, delete Runner profiles or re-enroll healthy Runners merely to update code. Only use [legacy migration](migration.md) when its explicitly named older data boundary applies.

## Check what is actually changing

| Component | What an update changes | What it does not change |
| --- | --- | --- |
| Worker | Control-plane code and available server tools | Installed Runner executable or host service |
| Signed Runner package | The executable selected for that host | Other hosts or the production Worker |
| MCP client catalog | The client's cached tool definitions | Server code, permissions or credentials |
| Release publication | Downloadable versioned assets | Any already-running installation |

Read the [release notes](release-notes.md) and [release status](release-readiness.md). A version marked candidate is not a published stable package. Changes marked not yet published are not included in an existing stable archive, and a Worker deployment does not add them to an installed Runner. Use a verified stable package for production; development prereleases belong in a separate test environment.

## Before changing production

Record the Worker deployment and source identity, installed Runner version, service executable path and current tool catalog. On each host, use the actual service executable to run `runmesh --version` with no other arguments, then `runmesh doctor --json`; a different CLI on `PATH` may report a different installation. Add `--profile` to the `doctor` command for a custom profile, or `--user` for a user service. Review diagnostic output before sharing it.

Protect the existing deployment configuration, Worker secrets, control-plane data, Runner profile/state, service manifest, verified package and project backups. Runmesh does not provide an in-app full backup or automatic rollback. Use the recovery procedures supported by your storage and deployment, and rehearse them on a separate test instance before relying on them.

Coordinate a maintenance window. Stop submitting new work, drain queued/running Jobs and resolve recovered `unknown` or `cancelling` Jobs before restarting a Runner. Browser closure and access revocation are not process shutdown. Record active Job IDs so an uncertain response does not lead to duplicate execution.

## Update in separate steps

1. **Rehearse first.** Verify the target signed release and test the intended Worker/Runner pair, service account and MCP client without production credentials or data.
2. **Deploy the reviewed Worker.** Use the existing production `main` deployment path and preserve its resource bindings and secret values. `INTERNAL_CONTROL_SECRET` and `RUNNER_TOKEN_PEPPER` remain independent; regenerating the pepper invalidates existing Runner credentials. See [deployment](deployment.md).
3. **Update each Runner explicitly.** Verify the target archive using the trusted source keyring and follow the release's applicable service-update procedure. Keep the existing profile/state and the previous verified package available for recovery. Do not delete the current installation to force an installer to proceed.
4. **Refresh the MCP catalog.** After the server update, reload the Runmesh connection/tool definitions in each client. A refresh cannot add capabilities that the installed Runner lacks.
5. **Verify the complete path** before allowing ordinary workloads again.

The [portable installation examples](portable-runner-installation.md) are first-install procedures and deliberately stop when an installation already exists. They are not a generic in-place updater. If a target release does not supply a procedure applicable to your existing layout, stop and request an operator-reviewed upgrade plan; do not use uninstall/purge, re-enrollment or manual link replacement as an improvised update.

A mixed-version installation can keep supported operations available while newer ones remain unavailable. For example, the published 0.1.3 Runner lacks Context `storage` and `prune`. A compatible newer Worker returns `runner_upgrade_required` before sending those actions. Upgrade the Runner explicitly before using them; if a compatible Runner was already connected during the Worker update, it may need to reconnect so the Worker can learn its supported actions. Coordinate any service restart with active Jobs.

## Acceptance checks

Confirm the expected Worker version/source, then check each actual service executable and `doctor --json`. Confirm the Runner reconnects and acknowledges workspace policy. From the intended MCP client, confirm the selected Runner, list workspaces, read a harmless file, and run a harmless command in an approved test workspace. Save the receipt and retrieve that same Job and its retained logs using the workspace-bound contract when available. Check an expected permission denial too.

Test input, cancellation, queueing and optional history settings in a controlled task when your workflow relies on them. Check that a client catalog refresh exposes the server's expected actions. A healthy HTTP endpoint, green source CI or a successful package download alone does not establish this end-to-end result.

## Stop or recover safely

On signature, checksum, version or source mismatch, stop before activation. After an uncertain command result, inspect the original Job rather than relaunching it. On service or compatibility failure, preserve the logs and current state; restore only a tested compatible package/deployment/state combination through the reviewed recovery plan. A previous binary may not understand newer state or history preferences.

Never delete a namespace, force a stale service manifest, restore an exposed credential or overwrite an immutable release to make a check pass. Credential rotation and recovery enrollment are separate actions for confirmed credential loss, expiry or revocation, not ordinary upgrade steps.
