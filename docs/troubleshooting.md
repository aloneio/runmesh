# Troubleshooting

[简体中文](troubleshooting.zh-CN.md) · [Documentation](README.md)

Identify the affected component—administrator page, Worker, Runner service or MCP client—and keep the original operation's receipt.

## Administrator page or login

Check the public HTTPS origin and deployment status. If you configured `RUNMESH_PUBLIC_ORIGIN` for a reverse proxy, verify that override as well.

| Symptom | Action |
| --- | --- |
| Registry or authorization dependency unavailable | Inspect the deployment and wait for recovery, then retry login with the current credential |
| Login throttled after repeated failures | Wait for the throttle window to expire |
| Session expired after a password change | Sign in with the current password |
| Data/schema mismatch | Preserve data, compare deployed code and resource bindings, and follow the [upgrade guide](upgrading.md) |

Complete first administrator setup before exposing a new instance to untrusted visitors. Older data-boundary changes have their own [migration procedure](migration.md).

## Runner stays offline

Check the host service, outbound HTTPS/WebSocket access to the Worker, and system time. Use the service's actual executable to run `runmesh --version` alone, then `runmesh doctor --json`. Add `--profile` to `doctor` for a custom profile or `--user` for a user service. Where supported, `--shareable` provides a report suitable for support.

Check the dashboard's Runner authorization period and credential status. Extend an expired authorization period if access is still intended. A revoked or replaced credential needs the administrator's recovery enrollment procedure; network and dependency failures need connectivity or service recovery.

For an online Runner with rejected policy, check workspace existence and the service account's OS permissions. See [connection recovery](connection-recovery.md) for timing and layered diagnostics.

## Installation fails or is unavailable

Use the administrator enrollment page's command in the appropriate elevated terminal. Resolve `RMI_*` errors with [installer prerequisites](installer-prerequisites.md).

Check [release status](release-readiness.md) when hosted distribution is unavailable. The reviewed 0.1.4 source enables stable hosted distribution. Check the deployed Worker commit, its release descriptor and any explicit installer-disable override. An applicable verified package can be installed through the [portable procedure](portable-runner-installation.md), keeping TLS, signature and hash checks enabled.

If another install or removal is active, wait for it to finish. After a crash, have the administrator inspect processes and remaining files before handling a stale lock. If enrollment may have completed, check the dashboard and local profile before obtaining a replacement code.

## MCP connection or tool parameters

Use the complete authorized URL ending in `/mcp` with a Streamable HTTP client. Remove accidental quotes, spaces or line breaks and use URL authentication without an added Bearer token.

After a Worker update, refresh the client's Runmesh tool catalog. If a Job follow-up rejects `workspace_id`, compare the Worker, Runner and client definitions using [catalog refresh](mcp-connector-refresh.md).

`runner_upgrade_required` calls for a compatible installed Runner. For Context `storage` and `prune`, upgrade from 0.1.3 to a verified release containing those actions, then reconnect so the Worker can recognize support. Follow the [upgrade guide](upgrading.md).

## Workspace missing or permission denied

Confirm `runner_current` and the workspace ID from `workspace_list`. Ask the administrator to check client scopes and Runner restrictions, the authorization period, workspace permissions and policy acknowledgement. The Runner's service account also needs OS access.

Use the [permission runbook](runbooks/permission-denial.md) to identify the denying layer before changing access. An unavailable dependency leaves that part of the diagnosis unresolved.

## Job still running or absent from cloud history

Keep the original `job_id`, `workspace_id` and Runner selection. A foreground call can return while the command continues. Follow it with workspace-bound live queries; the Runner can retain a Job whose cloud history is disabled, delayed, expired or unavailable.

For `job_history_unavailable` or an older `not_found`, ask the administrator to recover the original follow-up chain. Check that Job's state before launching another command.

## Cancellation, recovery or input is uncertain

Wait for a final Job status after cancellation. For recovered `unknown` processes, have an administrator verify process identity on the host; the execution slot remains reserved until reconciliation.

After an input delivery error or timeout, inspect the process before sending the data or end-of-input again. Read `operation_state`, `next_action` and `recovery_hint` together. See the [user guide](user-guide.md) for the full state list.

## Output is incomplete

A positive foreground output offset means the response contains a later fragment; use the `job` tool's `logs` action to page through retained bytes. `output_truncated` may indicate permanently discarded output. Check application logs too if your application collects them separately.

## Report a remaining problem

Provide the time, tool/action, component versions, redacted error code and relevant diagnostic checks. Remove credentials, real workspace paths and private content before sharing. Send security issues privately through [SECURITY.md](../.github/SECURITY.md).
