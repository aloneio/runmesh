# Handle MCP authorization errors

Runmesh checks the current MCP credential and scopes before each tool invocation. A URL that worked earlier can stop authorizing an operation after rotation, revocation or a permission change. Read the returned error code and `operation_state` before deciding whether to retry.

The first three rows below describe the check **before tool invocation**. The same error code elsewhere in the request path may have an unknown outcome. Always use the actual returned `operation_state`; the code alone is not permission to replay an operation.

| Result | Meaning | What to do |
| --- | --- | --- |
| `registry_unavailable`, `operation_state=not_started` | The current authorization check could not complete | Check control-plane availability. When it recovers, use the existing valid credential; this error alone does not require re-enrollment. |
| `authorization_response_invalid`, `operation_state=not_started` | The authorization service returned an invalid result | Ask the administrator to investigate the control plane. No tool was dispatched by this failed check. |
| `permission_denied` | The credential or its current authority no longer permits this request | Check the active credential and intended permissions with the administrator. |
| `internal_error`, unknown operation state | The tool was invoked but its outcome could not be confirmed | Inspect the existing Job or change receipt before taking further action. |

Read-only scopes cannot invoke writes, shell, input or cancellation. Changing the client cache or reconnecting cannot grant these permissions. See the [permission model](permission-model.md) for the client, Runner and workspace checks.

Do not blindly repeat a command, patch or input after an unknown outcome. Authorization failures before dispatch and failures after tool invocation have different recovery requirements. Completed operating-system effects cannot be assumed to roll back; follow the [call recovery guide](mcp-agent-call-contract.md).

## Integration details

The internal revalidation adapter distinguishes validated allowance, denial, unavailable service and malformed success. Internal 401/403/404 responses or a valid principal-generation mismatch are denial; timeout, transport errors, 429, 5xx and unexpected statuses indicate unavailability. An invalid successful response is malformed. These are internal endpoint statuses, separate from the public MCP URL's initial authentication response.

Revalidation has a five-second request deadline, a 16 KiB response-body budget and at most 256 reads. It does not retry or cache authorization. Only allowed identity/scope fields are used; raw error bodies, secret URLs and exception details are not forwarded. A successful revalidation still does not bypass the RunnerDO's final authorization and send checks.
