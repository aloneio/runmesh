# Understand permissions and diagnose access

An operation needs the appropriate MCP scope, effective Runner/workspace permission and host access. Use this page to identify the specific requirement behind an authorization error.

## Choose the required access

| Operation | MCP scope | Workspace permission |
| --- | --- | --- |
| Read, inspect, Job metadata/logs, Context reads | `coding:read` | Read |
| Patch and Context checkpoint/rebuild/prune | `coding:write` | Edit |
| Shell execution | `coding:exec` | Host shell |
| Job input or cancellation | `coding:exec` | Job control |

Effective permission is the intersection of the client scope ceiling, any client-to-Runner override, the active Runner policy and the enabled workspace policy. Stored permission dependencies require read before edit/job-control, and read+edit+job-control before Host shell. Public tool scopes are checked separately: an edit still requires `coding:write` even when the policy supports execution.

`workspace_list` shows the requesting client's effective policy permissions. An absent override inherits the other limits; an invalid stored override locks access and needs administrator repair.

## What each request checks

The Worker validates the secret URL and captures the client ID and credential generation. Each tool rechecks that generation and current scopes. Runner-selection updates check the generation at the update itself, so rotation or revocation rejects requests from the old credential.

Before live dispatch, Registry checks the client, scope, selected Runner, method, workspace/Job identity and active policy revision/checksum. RunnerDO repeats authorization after reconciling access and policy, then checks the current session immediately before send. The Runner enforces its own workspace/path policy and the actual Job workspace. Raw MCP secrets remain at the Worker authentication boundary.

Local policy checks surround filesystem reads, Job admission and patch baseline validation. A policy change can reject a read before return or stop queued work before launch. Keep both Worker and Runner current when these checks are required.

Revocation applies to subsequent authorization decisions. Work already admitted can have lasting effects: cancel a running Job explicitly and inspect existing file changes before deciding on recovery. See [call recovery](mcp-agent-call-contract.md).

## Shared Jobs and host permissions

Jobs are shared within the authorized workspace. A client with read access can inspect another client's Job and logs; input/cancellation require the exec scope and effective job-control permission. Creator identity is audit metadata.

Host shell runs with the Runner's OS identity. The workspace sets its initial directory and application permissions; the command's further access follows host permissions. Treat a root/SYSTEM `privileged_host` Runner as a host-administration capability. Grant a dedicated service account only the host access required for the intended work.

Trusted HMAC operator RPCs are a separate privileged control-plane interface. Restrict their signing secret to operators.

## Diagnose in order

1. Check the deployed Worker and installed Runner versions, selected Runner and current connection state.
2. Compare desired, applied and reported policy revision/checksum. Wait for reconciliation when the result is `policy_pending` or `stale_policy`.
3. For `insufficient_scope`, check the exact tool scope. For `readonly_workspace` or `permission_denied`, check the client override, Runner policy and enabled workspace permissions.
4. For `busy` or `runner_offline`, resolve capacity or connectivity. For an OS access failure, check the service identity and filesystem permissions on the host.

When asking for help, include the timestamp, stable error code and safe Runner/workspace identifiers; keep secret URLs and Runner tokens private. A last-known online state should be followed by a live diagnostic if reachability is uncertain.

Upgrade the Worker and Runner as separate steps, with independent host access available during the service restart. See [upgrading](upgrading.md).
