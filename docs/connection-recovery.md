# Recover a Runner connection

[Documentation](README.md) · [Troubleshooting](troubleshooting.md) · [Upgrade guide](upgrading.md)

When a Runner disconnects, keep its selection and Job receipts. Already-started commands can continue; use those receipts to inspect them after recovery.

## Find the failing layer

1. Use `runner_current` to confirm the selected Runner and keep that selection while following an existing Job.
2. If your client exposes it, call `inspect` with `{"action":"diagnostics","workspace_id":"your-workspace-id"}`. Read the observation time and individual checks for selection, workspace access, policy alignment and live Runner RPC. An `unknown` check means the dependency could not be confirmed.
3. On the host, check the service manager. Using the service's actual executable, run `runmesh --version` with no other arguments, then `runmesh doctor --json`. Add `--profile` to `doctor` for a custom profile or `--user` for a user service. A different CLI on `PATH` may inspect another installation.
4. Check outbound HTTPS/WebSocket access to the Worker, system time and the configured Worker origin. Runmesh does not require a public inbound port on the Runner.

Use `doctor` for local configuration and service state, the dashboard for Runner connectivity, and an MCP read for the complete path. If supported by your CLI, `runmesh doctor --shareable --json` keeps only the diagnostic fields suitable for sharing. Review other reports for private data before sending them.

## Interpret connection failures

| Observation | What to do |
| --- | --- |
| Network failure or retryable service response such as HTTP 429/503 or WebSocket 1013 | Keep the current credential, let the Runner reconnect, and check the network or control-plane service. |
| Session replaced or stale connection | Check for another service using the same Runner profile and keep a single active instance. A compatible Runner reconnects with its existing credential. |
| Explicit HTTP 401/403 or credential rejection | Ask the administrator to check revocation, rotation and the configured profile. Use recovery enrollment only when a new credential is actually needed. |
| Protocol rejection | Check the supported Worker/Runner versions before changing credentials. |
| Connected but workspace policy is not acknowledged | Check workspace existence, the service account's OS access and the saved policy. Protected work remains unavailable until the policy is valid and acknowledged. |
| Runner authorization period expired | Extend the authorization in the dashboard if access is still intended. The connection can remain available for this recovery. |

After dependency recovery, retry a read to verify access. For an edit, command, input or cancellation with an uncertain result, inspect the original operation before retrying.

## Allow time for automatic recovery

Runners with the extended recovery behavior retry ordinary network failures with increasing delays up to 30 seconds. Service outages start at about 30 seconds and increase to five minutes; a server `Retry-After` can extend a wait to fifteen minutes. Logs report the failure class and planned delay. A connection must remain stable for at least one minute before this retry escalation resets.

Check the installed Runner version and effective service settings when comparing retry timing. New systemd manifests use a 30-second restart delay; existing units retain their installed settings. Allow the configured retry window to finish before intervening. Version-specific behavior is described in the [release notes](release-notes.md).

## Confirm recovery

Confirm that the original Runner is online and its workspace policy is acknowledged. From the intended MCP client, list its workspaces and read a harmless file. If a Job was already running, query that same `job_id` with its original `workspace_id` and inspect its retained logs. Use its recorded status and output to determine the result.

Click Load / Refresh for a new dashboard observation and check its timestamp. For current process state and local logs, query the online, authorized Runner. Cloud history provides the most recently stored snapshot, while an unavailable query needs service recovery before you can interpret it.

If recovery remains incomplete, provide the failure time, Runner and Worker versions, redacted error code and relevant diagnostic checks. Follow the [connection recovery runbook](runbooks/connection-recovery.md) for a repeatable investigation. Preserve the existing namespaces, credentials, profile and Job state while investigating.
