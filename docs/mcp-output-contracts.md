# Read and validate MCP tool results

The current Worker advertises an output schema for each of its ten public MCP tools in `tools/list`. Use that schema to interpret successful results. Optional observations may be absent when an older Runner cannot supply them; absence is not a zero value or evidence that an operation completed.

Before returning success, the Worker validates the result against the action you requested and projects only allowed fields. Private metadata and raw exception details are not forwarded. Response-size limits still apply, so a successful response may explicitly indicate truncation.

## When a result cannot be trusted

Malformed successful output becomes `tool_result_invalid` with an unknown operation state. Safe existing Job/workspace/correlation identifiers and audit observations are retained when available, but private fields and validation exception details are not exposed. No command, input, patch or cancellation is automatically replayed. Existing error envelopes remain on their existing path. A successful command with unavailable logs still retains its actual status and exit code.

## Compatibility and limits

An explicit bounded truncation envelope remains supported; an empty object is not a successful receipt. Older valid results can omit optional observations, but wrong types, undeclared fields and absent required action evidence are rejected. For example, `job.input` returns the accepted byte count as `accepted` and optional `eof`; it does not return a JobRecord or prove that the process consumed the input.

The aggregate JSON Schema cannot express every dependency on the request's action; the Worker performs that additional validation. A valid output schema does not grant permission or prove support on every Runner. The catalog fingerprint changes when its schemas change, but clients may retain a cached catalog. Refresh the affected connector if its schema is stale; see [capability diagnostics](capability-contracts.md) and [call recovery](mcp-agent-call-contract.md).
