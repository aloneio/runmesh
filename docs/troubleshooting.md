# Troubleshooting

[简体中文](troubleshooting.zh-CN.md) · [Documentation](README.md)

Identify the failing component first: admin UI, Worker, Runner service or MCP client. Preserve the original operation's receipt. Never include passwords, MCP URLs, enrollment commands, tokens or private output in a report.

## Admin page or login is unavailable

Check the deployment's public HTTPS origin and status. Ordinary direct production deployment does not require `RUNMESH_PUBLIC_ORIGIN`; verify it only when you deliberately set an override, such as for a reverse proxy. Complete first setup before exposing an uninitialized instance to untrusted visitors.

For a Registry outage or invalid dependency response, wait for service recovery and inspect the deployment; do not assume the password is wrong or rotate secrets. After genuine repeated failed logins, allow the throttle window to expire. Password changes invalidate old sessions, so sign in again when appropriate.

A schema mismatch needs investigation of the deployed code and bindings. Do not create fresh namespaces, delete D1 or rerun first setup as a generic fix for an existing v2 installation. Preserve data and use the [upgrade guide](upgrading.md); [legacy migration](migration.md) is a separate, explicitly scoped procedure.

## Runner stays offline

Check the actual host service, outbound HTTPS/WebSocket access to the Worker and the system clock. Run `runmesh --version` and `runmesh doctor --json` with the executable used by that service. A different local CLI or a green Worker health page does not prove the service is connected.

Check Runner authorization, policy acknowledgement and any explicit credential rejection. An expired Runner authorization period can be extended by the administrator without treating a network outage as credential loss. For a confirmed revoked/replaced credential or incompatible profile, use the administrator's reviewed recovery enrollment flow. Do not re-enroll a healthy existing Runner merely because a request timed out.

No public inbound port is required. Do not expose the Runner or add SSH solely for its connection.

## Installer fails or reports unavailable

Use the platform's elevated shell and the exact command from the enrollment page. Follow [installer prerequisites](installer-prerequisites.md) for `RMI_*` codes. Do not blindly retry a code that may already have been consumed.

An unavailable installer can mean the signed release or required deployment checks are unavailable. Follow [portable verification](portable-runner-installation.md) only for an applicable verified artifact; do not substitute a package name from a registry, a branch build or an unverified mirror. Never disable TLS or signature/checksum checks. Existing installation or service-manifest conflicts require operator inspection, not forced overwrite or purge.

## MCP connection or tool schema differs

Use the complete URL ending in `/mcp`, without added quotes, spaces or a Bearer token. Confirm Streamable HTTP support and that the URL is the currently authorized one.

After a Worker update, refresh the client's Runmesh connection and cached tool definitions. A missing action or rejection of `workspace_id` on Job follow-up calls can indicate a catalog/component mismatch. Compare the deployed Worker, installed Runner and authenticated tool catalog. Current-source examples do not grant an older component capabilities it lacks. See [catalog refresh](mcp-connector-refresh.md).

## Workspace missing or permission denied

Client, Runner and workspace policies must all allow the operation. Check current client scopes, Runner restrictions, authorization period and acknowledged workspace policy, then confirm `runner_current` and `workspace_list`. Do not broaden permissions to treat a dependency outage, or bypass a denial using absolute paths, symlinks or shell commands.

## Shell returned, but the Job is still running or missing from history

The foreground wait is not a command deadline. Keep its `job_id` and `workspace_id`, remain on the same Runner and query the original Job. A missing cloud record (`job_history_unavailable` or a legacy `not_found`) is not proof that execution never happened. Use the supported workspace-bound live query and ask the administrator to reconcile a broken follow-up chain; do not relaunch the command.

Cloud history may be disabled, delayed, expired or unavailable. Live local output requires an authorized online Runner. Previously archived metadata is only a recent snapshot, not an authoritative live process status or full log archive.

## Cancellation, recovery or input is uncertain

`queued`, `running`, `cancelling` and `unknown` are not successful completion. A cancellation request does not prove immediate exit. After a restart, an unverified process may retain its execution slot until reconciled; do not delete metadata or signal a guessed PID to free it. Inspect it on the host through an administrator.

Input delivery errors and timeouts do not prove zero bytes were consumed. Check the original process before resending data or end-of-input. Follow `operation_state`, `next_action` and `recovery_hint` when present, not the error code alone. See the [user guide](user-guide.md) for all Job states.

## Output is incomplete

A positive foreground output offset can mean only the response tail was returned; paginate retained logs from the original Job. `output_truncated` can also mean the storage cap discarded bytes. Runmesh cannot recover discarded bytes; inspect separately configured application logs when they exist. Reading logs does not enable cloud recording.

## Report a remaining problem

Provide time, tool/action, versions, a redacted error code and non-sensitive diagnostic checks. Exclude credentials, full URLs, real workspace paths and private content. Report security issues privately through [SECURITY.md](../.github/SECURITY.md).
