# Handle MCP authorization errors

Runmesh checks the current MCP credential and scopes before every tool invocation. Rotation, revocation or a permission change can alter what an existing connection is allowed to do. Use the returned `code` together with `operation_state` to choose the recovery step.

## Choose the next action

The first three rows describe checks before tool invocation. The same code at another point in the request can carry a different operation state.

| Result | Meaning | Next action |
| --- | --- | --- |
| `registry_unavailable`, `operation_state=not_started` | Current authorization could not complete | Check control-plane availability; resume with the existing valid credential after recovery. |
| `authorization_response_invalid`, `operation_state=not_started` | Authorization returned an invalid result before dispatch | Ask the administrator to investigate the control plane. |
| `permission_denied` | The credential or its current authority rejects this request | Check the active credential and intended permissions with the administrator. |
| `internal_error`, unknown operation state | A tool was invoked but its outcome remains unconfirmed | Inspect the original Job or change receipt before proceeding. |

Writes require `coding:write`; shell, input and cancellation require `coding:exec`, together with the appropriate Runner and workspace permissions. Ask an administrator for the specific access needed. See the [permission model](permission-model.md).

For an unknown outcome, inspect existing state first. **Do not automatically repeat a command, patch or input:** an already completed host effect may still be present. Follow the [call recovery guide](mcp-agent-call-contract.md).

## Adapter behavior

Internal 401/403/404 responses and a valid principal-generation mismatch are denial. Timeout, transport errors, 429, 5xx and unexpected statuses indicate unavailability. An invalid successful response is malformed. These internal statuses are distinct from initial public MCP URL authentication.

Each revalidation makes a fresh bounded check: five-second request deadline, 16 KiB response-body budget and at most 256 reads. It uses allowed identity/scope fields and sanitizes errors. A successful result proceeds to RunnerDO's final authorization and send checks. Authorization is neither cached nor automatically retried.
