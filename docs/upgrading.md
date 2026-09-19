# Upgrade an existing installation

[简体中文](upgrading.zh-CN.md) · [Documentation](README.md)

For a compatible protocol-v2 upgrade, keep the current Worker, Durable Object namespaces, D1 database, secrets, Runner profiles and service layout. Use [legacy migration](migration.md) only for the older data boundary it names.

## Choose the target version

Read the [release notes](release-notes.md) and [release status](release-readiness.md). Production upgrades use published, independently verified signed packages; candidate and development prereleases belong in a separate test environment.

Plan these updates separately:

| Component | Update action |
| --- | --- |
| Worker | Deploy the reviewed control-plane code |
| Runner | Install the verified package on each host using its applicable service-update procedure |
| MCP client | Refresh cached tool definitions after the Worker update |

Capabilities depend on the complete combination. For example, Context `storage` and `prune` need a Runner newer than the published 0.1.3 package. A compatible Worker returns `runner_upgrade_required` for an unsupported action. A supported Runner already connected during a Worker update may need to reconnect so its capabilities are recognized.

## Prepare a maintenance window

Record the expected Worker commit, each installed Runner version, service executable path and client tool catalog. Use the actual service executable for `runmesh --version`, with no additional arguments. Then run `runmesh doctor --json`; add `--profile` for a custom profile and `--user` for a user service.

Back up deployment configuration, secrets, control-plane data, Runner profile/state, service manifests, verified packages and project data. Rehearse restoration in a separate test instance.

Pause new submissions and drain queued/running Jobs before restarting a Runner. Inspect recovered `unknown` or `cancelling` processes on the host, and retain their Job IDs for follow-up. After revoking access, inspect running Jobs and their effects on the host.

## Apply the upgrade

1. **Rehearse the target combination.** Verify the signed release and exercise the Worker, Runner, service account and intended MCP client in a test environment.
2. **Deploy the Worker.** Use the existing production `main` deployment path, preserving resource bindings and secret values. Replacing `RUNNER_TOKEN_PEPPER` invalidates enrolled Runner credentials.
3. **Update each Runner.** Verify its archive against the trusted source keyring and follow that release's service-update procedure. Preserve profile/state and keep the previous verified package available for recovery.
4. **Refresh the client catalog.** Reload the Runmesh connection and tool definitions in each MCP client.
5. **Complete acceptance checks**, then resume ordinary workloads.

The [portable installation examples](portable-runner-installation.md) are for a fresh installation and stop when an existing layout is found. If the target release lacks an update procedure for your layout, have an administrator prepare one before changing installed files. Keep uninstall/purge and recovery enrollment for their intended maintenance operations.

## Accept the result

Confirm the Worker's expected commit, then each actual service executable's version and `doctor --json` checks. Confirm Runner connectivity and workspace-policy acknowledgement.

From the intended MCP client, verify the selected Runner, list workspaces, read a harmless file and run a harmless command in an approved test workspace. Save the receipt, then query the same Job and its retained logs with the original `job_id` and `workspace_id`. Include an expected permission-denial check.

If your workflow uses input, cancellation, queueing or optional history, exercise those on controlled test Jobs. Record the component versions and the results before restoring ordinary work.

## Recover a failed step

| Observation | Action |
| --- | --- |
| Signature, hash, version or source mismatch | Stop activation and obtain a matching verified artifact |
| Uncertain command or edit result | Inspect the original Job or files before retrying |
| Service or compatibility failure | Preserve logs and state, then restore a tested compatible package/deployment/state combination |
| Credential loss, expiry or revocation | Use the appropriate access-extension, rotation or recovery enrollment procedure |

Restore data and binaries together according to the rehearsed plan. Older binaries may interpret newer state or history settings differently. Keep durable state and immutable release assets intact while investigating.
