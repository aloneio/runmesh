# Read and validate MCP tool results

Use the output schema in `tools/list` to interpret each of Runmesh's ten public tools. The Worker validates a successful result against the requested action and returns allowed fields within its response-size budget. Truncated results carry explicit truncation information.

## Interpret a receipt

Older Runners may omit optional observations. Treat those fields as unavailable and use the evidence that is present. For example, `job.input` returns the accepted byte count in `accepted` and optional `eof`; these describe input delivery, while the Job's subsequent output/status show how the process handled it.

Action-specific required evidence must be present. Wrong types, undeclared fields, missing required evidence and empty success objects produce `tool_result_invalid`. The Worker performs these checks in addition to the aggregate JSON Schema published for the tool.

## Recover from an invalid result

`tool_result_invalid` has an unknown operation state. Preserve available Job/workspace/correlation identifiers and inspect the original operation before deciding what to do next. **Do not automatically replay commands, input, patches or cancellation after an unknown outcome.** Error details are limited to safe metadata.

If a command finished but inline log retrieval failed, use its actual status and exit code, then retry the log query. See [call recovery](mcp-agent-call-contract.md).

## Refresh a stale catalog

The catalog fingerprint changes with its schemas. Compare the catalog actually loaded by your MCP client with the deployed Worker's catalog and refresh the affected connector when needed. [Capability diagnostics](capability-contracts.md) also separates Runner support from current permissions; every operation still needs both.
