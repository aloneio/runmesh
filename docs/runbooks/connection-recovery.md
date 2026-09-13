# Connection recovery

Version: 1  
Applies to: Runner transport and control-plane connectivity  
Required permissions: `coding:read` for MCP diagnostics; administrator access only for separate service-manager inspection  

## Goal

Identify whether an unavailable Runner is failing at local service state, network transport, authentication, policy synchronization, or workspace authorization without changing credentials, switching Runners, or retrying a side-effecting operation.

## Procedure

1. Read the current Runner selection and keep the stable Runner ID fixed. Do not automatically select another Runner when the selected one is offline.
2. Use the layered diagnostics result and record its observation time. Distinguish `offline`, `stale`, dependency availability failures, authentication failures, and policy revision mismatch.
3. On the host, run `runmesh doctor --shareable --json` when a support-safe report is needed. The shareable form deliberately omits host paths, URLs, credentials, environment values, workspace IDs, and raw log text.
4. If the service is inactive, inspect the native service manager through the documented administrator path. Do not reinstall or re-enroll merely to make a health check pass.
5. If authentication is explicitly revoked, use the normal enrollment workflow. A temporary network or Registry failure is not evidence that credentials should be rotated.
6. If a Job may already have started, recover it from its receipt or Job ID. Do not resubmit a write or shell operation whose state is `unknown`.

## Exit conditions

- Stop successfully when the failure layer is identified with a timestamped observation and the selected Runner remains unchanged.
- Stop and escalate when the operation state is unknown, policy state is ambiguous, or service identity cannot be verified.
- Do not claim production recovery has been verified from a local-only probe.
