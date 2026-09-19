# Configure Git access and recover Runner sessions

[简体中文](git-isolation-and-session-recovery.zh-CN.md)

Runmesh's read-only Git operations use a trusted Git installation outside the selected workspace. If Git inspection returns `git_unavailable`, check the workspace root and the host's Git installation before trying the operation again.

## Configure a dedicated workspace

Use a repository directory such as `/workspace/project` as the workspace root. Filesystem roots, drive roots and equivalent canonical roots are rejected by Git inspection: they leave no separate location for a trusted Git executable. This applies to status, diff, log, show and blame. Other tools continue to follow their own workspace permissions.

An authorized administrator changes centrally managed workspace paths in the control plane. After saving, wait for desired, applied and reported policy revision/checksum to agree, then repeat the Git request.

The trusted Git path must lie outside the workspace both as written and after resolving its canonical path. This applies even to a machine-wide installation that falls inside an overly broad workspace. POSIX also checks executable ownership and safe ancestor/file modes; Windows uses trusted system installation locations. If trusted executable discovery fails, install or select a suitable Git installation and retain the workspace isolation boundary.

MCP returns a bounded `git_unavailable` hint. Use local diagnostics for host-specific installation details and keep those private paths out of shared reports.

## Interpret a connection close

| Registry result | WebSocket close | Recovery |
| --- | --- | --- |
| `401` or `403` | `4001`, `runner credentials rejected` | Check the Runner credential; its current connection loop stops. The service manager may subsequently restart the process. |
| `409` | `4000`, `stale runner session` | Reconnect with the existing credential and complete a fresh handshake. |
| Availability failure, including `429` and `5xx` | `1013`, `control plane temporarily unavailable` | Allow the slower service-unavailable reconnect backoff while checking the control plane. |

These categories cover connection setup, heartbeat, sync, Job events, policy acknowledgements and session checks before replies. A stale session's pending replies are rejected. Pre-welcome frames and protocol mismatches have their own transport errors; diagnose them separately from credential rejection.

For retryable `4000`, the Runner records `session_conflict` and uses jittered reconnect backoff while retaining the credential. The close code determines handling. Use the timestamp and actual close code when investigating an earlier disconnect.

## Retry the appropriate operation

`git_unavailable` is an availability error with a default `operation_state=not_started`; an explicit state reported by the Runner takes precedence. Correct the installation/workspace configuration, then repeat the read-only Git request. If the outcome is `unknown`, follow [call recovery](mcp-agent-call-contract.md) for the operation that produced it.

Check the deployed Worker and installed Runner versions while diagnosing compatibility. Install a verified Runner release when its local behavior needs an upgrade, and retain independent host access during the service restart. See [upgrading](upgrading.md).
