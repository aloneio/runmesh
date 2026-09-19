# Connection recovery

Version: 1
Applies to: Runner transport and control-plane connectivity
Required permissions: `coding:read` for MCP diagnostics; administrator access only for separate service-manager inspection

## Goal

Find whether the connection problem comes from the local service, network, authentication, policy synchronization or workspace access. Keep the selected Runner and any existing Job receipts while investigating.

## Procedure

1. Call `runner_current` and record the Runner ID. If there is no selection, identify the intended Runner before continuing. Keep that selection while investigating.
2. If available in your client catalog, call `inspect` with `{"action":"diagnostics","workspace_id":"your-workspace-id"}`. Record `observed_at_ms` and the checks for Runner selection, workspace authorization, policy alignment and live RPC. Preserve an `unknown` result when a dependency cannot be checked. If the action is unavailable, continue with administrator and host checks.
3. On the host, use the actual service executable and profile for `runmesh doctor --json`. Pass `--profile` for a custom profile or `--user` for a user service. When the installed CLI supports it, `runmesh doctor --shareable --json` omits host paths, URLs, credentials, environment values, workspace IDs and raw logs. Review other diagnostic output before sharing.
4. If the service is inactive, inspect the native service manager as an administrator. If it is active, check outbound HTTPS/WebSocket connectivity, system time and the configured Worker. After local checks, verify access through the intended MCP client.
5. For an explicit revoked or replaced credential, follow the administrator's recovery enrollment procedure. For an expired Runner authorization period, extend the period in the dashboard if access is still intended. For a temporary network or Registry failure, retain the credential and restore connectivity.
6. If a Job may already have started, query it with the original `job_id` and `workspace_id` on the same Runner. Establish the outcome before submitting another write or command. See [connection recovery](../connection-recovery.md) for retry timing and recovery checks.

## Exit conditions

- The investigation is complete when the failing layer is identified with a timestamped observation and the selected Runner remains unchanged.
- Stop and escalate when the operation state is unknown, policy state is ambiguous, or service identity cannot be verified.
- Confirm recovery through the intended MCP client after the affected service is restored.
