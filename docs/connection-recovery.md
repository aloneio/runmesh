# Recover a Runner connection

[Documentation](README.md) · [Troubleshooting](troubleshooting.md) · [Upgrade guide](upgrading.md)

When a Runner disconnects, keep its selection and any Job receipts. A lost connection does not stop an already-started command, and an unavailable history page does not mean the command never ran.

## Find the failing layer

1. Use `runner_current` to confirm the selected Runner. Do not switch machines while following an existing Job.
2. If your client exposes it, call `inspect` with `{"action":"diagnostics","workspace_id":"your-workspace-id"}`. Read the observation time and individual checks for selection, workspace access, policy alignment and live Runner RPC. An `unknown` check means the dependency could not be confirmed.
3. On the host, check the service manager. Using the service's actual executable, run `runmesh --version` with no other arguments, then `runmesh doctor --json`. Add `--profile` to `doctor` for a custom profile or `--user` for a user service. A different CLI on `PATH` may inspect another installation.
4. Check outbound HTTPS/WebSocket access to the Worker, system time and the configured Worker origin. Runmesh does not require a public inbound port on the Runner.

`doctor` checks local configuration and service state. It does not prove that the Worker can authorize and execute an MCP operation. Conversely, a healthy Worker endpoint does not prove that a particular Runner is connected. If your installed CLI supports it, `runmesh doctor --shareable --json` produces a report without host paths, URLs, credentials, environment values, workspace IDs or raw logs. Review any report before sharing it.

## Interpret connection failures

| Observation | What to do |
| --- | --- |
| Network failure or retryable service response such as HTTP 429/503 or WebSocket 1013 | Let the Runner reconnect and check the network or control-plane service. This is not evidence that its credential needs replacement. |
| Session replaced or stale connection | Check for another service using the same Runner profile. A compatible Runner reconnects with its existing credential; do not launch a duplicate service. |
| Explicit HTTP 401/403 or credential rejection | Ask the administrator to check revocation, rotation and the configured profile. Use recovery enrollment only when a new credential is actually needed. |
| Protocol rejection | Check the supported Worker/Runner versions before changing credentials. |
| Connected but workspace policy is not acknowledged | Check workspace existence, the service account's OS access and the saved policy. Protected work remains unavailable until the policy is valid and acknowledged. |
| Runner authorization period expired | Extend the authorization in the dashboard if access is still intended. The connection can remain available for this recovery. |

A dependency outage must not be treated as a successful authorization check. Wait for service recovery before retrying a read. For an edit, command, input or cancellation with an uncertain result, inspect the original operation before deciding whether to retry.

## Allow time for automatic recovery

Runners with the extended recovery behavior retry ordinary network failures with increasing delays up to 30 seconds. Service outages start at about 30 seconds and increase to five minutes; a server `Retry-After` can extend a wait to fifteen minutes. Logs report the failure class and planned delay. A connection must remain stable for at least one minute before this retry escalation resets.

Older installed Runners may retry sooner. Newly installed systemd services use a 30-second restart delay, but updating Worker code or publishing a package does not rewrite an existing service unit. Check the effective service settings and the [release notes](release-notes.md) before relying on newer recovery behavior. Repeatedly restarting the service can interrupt useful recovery and creates more connection attempts.

## Confirm recovery

Confirm that the original Runner is online and its workspace policy is acknowledged. From the intended MCP client, list its workspaces and read a harmless file. If a Job was already running, query that same `job_id` with its original `workspace_id` and inspect its retained logs. Do not launch a replacement command to test whether the first one completed.

The dashboard loads Job history and logs when requested; it does not continuously refresh them. Check the last-loaded timestamp. An unavailable query is different from an empty result, and a cloud snapshot is not authoritative live process state. Local logs require the Runner to be online and authorized and are returned in bounded pages.

If recovery remains incomplete, provide the failure time, Runner and Worker versions, redacted error code and relevant diagnostic checks. Follow the [connection recovery runbook](runbooks/connection-recovery.md) for a repeatable investigation. Preserve the existing namespaces, credentials, profile and Job state while investigating.
