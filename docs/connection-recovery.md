# Recover a Runner connection

[Documentation](README.md) · [Troubleshooting](troubleshooting.md) · [Upgrade guide](upgrading.md)

When a Runner disconnects, keep its selection and Job receipts. Already-started commands can continue; use those receipts to inspect them after recovery.

## Find the failing layer

1. Use `runner_current` to confirm the selected Runner and keep that selection while following an existing Job.
2. If your client exposes it, call `inspect` with `{"action":"diagnostics","workspace_id":"your-workspace-id"}`. Read the observation time and individual checks for selection, workspace access, policy alignment and live Runner RPC. An `unknown` check means the dependency could not be confirmed.
3. On the host, check the service manager. Using the service's actual executable, run `runmesh --version` with no other arguments, then `runmesh doctor --json`. Add `--profile` to `doctor` for a custom profile or `--user` for a user service. A different CLI on `PATH` may inspect another installation.
4. Check outbound HTTPS/WebSocket access to the Worker, system time and the configured Worker origin. The Runner initiates the connection from the host to the Worker.

Use `doctor` for local configuration and service state, the dashboard for Runner connectivity, and an MCP read for the complete path. With the current Runner, `runmesh doctor --shareable --json` produces a report containing diagnostic fields suitable for sharing. Review other reports for private data before sending them.

## Interpret connection failures

| Observation | What to do |
| --- | --- |
| Network failure or retryable service response such as HTTP 429/503 or WebSocket 1013 | Keep the current credential, let the Runner reconnect, and check the network or control-plane service. |
| Session replaced or stale connection | Check for another service using the same Runner profile and keep a single active instance. A compatible Runner reconnects with its existing credential. |
| Explicit HTTP 401/403 or credential rejection | Ask the administrator to check revocation, rotation and the configured profile. Use recovery enrollment only when a new credential is actually needed. |
| Protocol rejection | Check the supported Worker/Runner versions before changing credentials. |
| Connected but workspace policy is not acknowledged | Check workspace existence, the service account's OS access and the saved policy. Wait for the Runner to acknowledge the valid policy before resuming work. |
| Runner authorization period expired | Extend the authorization in the dashboard if access is still intended. The connection can remain available for this recovery. |

After dependency recovery, retry a read to verify access. For an edit, command, input or cancellation with an uncertain result, inspect the original operation before retrying.

## Separate transport, observation and authority

A compatible Runner negotiates an independent text `ping`/`pong` keepalive after its authenticated welcome. It probes every 25 seconds with at most one outstanding probe and retires an unanswered transport after 75 seconds. Cloudflare's WebSocket auto-response handles this probe without a Registry request. A pong proves transport reachability only: it does not prove current credentials, policy, persistence or permission to execute.

The same welcome negotiates a 120-second heartbeat persistence interval. Older Workers keep the Runner's 30-second compatibility cadence; an updated Worker also coalesces healthy 30-second heartbeats from older Runners before calling Registry. Only a completed Registry `204` receipt advances the persistence clock. The clock and bounded retry metadata survive Durable Object hibernation through the socket attachment, without adding SQL, KV or maintenance-alarm writes to each incoming frame.

Registry snapshots expire after 180 seconds without a persisted heartbeat. This is an observation-freshness window, not a guarantee that the WebSocket is connected or authorized. `stale` can mean persistence is unavailable while the transport remains attached. Public Runner reads compute that observation without writing a stale transition; independent maintenance may persist it later. Failed or stale observations never grant permission to dispatch.

An established connection is retained during temporary heartbeat, session-check, policy-acknowledgment and optional history dependency failures. Every affected frame stops at its own authorization boundary: unverified replies are not delivered, new protected work remains denied, and a policy is not treated as applied without its real acknowledgment and admission reconciliation. Explicit credential rejection, session replacement, invalid identity and protocol errors retain their close behavior. Initial authentication and hello admission must still complete successfully before a session is usable.

Optional Job history uses separate bounded retry lanes and does not emit a successful upload acknowledgment for a skipped or failed request. MCP audit fetch and body reads have a 750-millisecond observation budget, independent of the longer mandatory authorization budget. A missing audit receipt is reported as `audit_status: "unknown"`, not as recorded, and cannot replace an already verified tool result. Do not repeat a command merely to obtain an audit receipt.

## Roll out without weakening authorization

Update the Worker first, validate an older Runner against it, and then update a development Runner to verify keepalive and the negotiated heartbeat cadence. A newer Runner connecting to an older Worker must remain on the 30-second fallback. Retain existing Runner identity, credentials and Job receipts throughout the rollout.

The optional emergency `RUNMESH_HEARTBEAT_FAILURE_MODE=reconnect` switch restores heartbeat-failure reconnect behavior only. It does not bypass authorization, promise recovery from exhausted storage, or undo the low-frequency persistence cadence. Prefer reverting the reviewed Worker/Runner candidate when a complete rollout rollback is needed; do not change credentials to work around an unavailable dependency.

Run the heartbeat persistence, heartbeat budget, transport outage, read-only presence, optional audit and Runner keepalive regressions before promotion. Local simulated-time SQLite measurements are development evidence, not a provider billing export or proof of production stability. Collect live usage and reconnect evidence separately as described in the [cost baseline](cost-baseline.md).

## Allow time for automatic recovery

Runners with the extended recovery behavior retry ordinary network failures with increasing delays up to 30 seconds. Service outages start at about 30 seconds and increase to five minutes; a server `Retry-After` can extend a wait to fifteen minutes. Logs report the failure class and planned delay. A connection must remain stable for at least one minute before this retry escalation resets.

Check the installed Runner version and effective service settings when comparing retry timing. New systemd manifests use a 30-second restart delay; existing units retain their installed settings. Allow the configured retry window to finish before intervening. Version-specific behavior is described in the [release notes](release-notes.md).

## Confirm recovery

Confirm that the original Runner is online and its workspace policy is acknowledged. From the intended MCP client, list its workspaces and read a harmless file. If a Job was already running, query that same `job_id` with its original `workspace_id` and inspect its retained logs. Use its recorded status and output to determine the result.

Click Load / Refresh for a new dashboard observation and check its timestamp. For current process state and local logs, query the online, authorized Runner. Cloud history provides the most recently stored snapshot, while an unavailable query needs service recovery before you can interpret it.

If recovery remains incomplete, provide the failure time, Runner and Worker versions, redacted error code and relevant diagnostic checks. Follow the [connection recovery runbook](runbooks/connection-recovery.md) for a repeatable investigation. Preserve the existing namespaces, credentials, profile and Job state while investigating.
