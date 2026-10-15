# Read and validate MCP tool results

Use the output schema in `tools/list` to interpret each of Runmesh's eleven native tools. The Worker validates a successful native result against the requested action and returns allowed fields within its response-size budget. Runner-backed paged results use their explicit truncation envelope; `bootstrap` is independently bounded and reports directory truncation through its manifest fields. Shared MCP and Skill tools add separate entries to the active catalog; use each entry's schema and returned content for those calls.

## Interpret a receipt

Older Runners may omit optional observations. Base your decision on the fields returned by the installed Runner. For example, `job.input` returns the accepted byte count in `accepted` and optional `eof`; these describe input delivery, while the Job's subsequent output/status show how the process handled it.

Action-specific required evidence must be present. Wrong types, undeclared fields, missing required evidence and empty success objects produce `tool_result_invalid`. The Worker performs these checks in addition to the aggregate JSON Schema published for the tool.

## Read process exit codes

With compatible Worker and Runner versions of 0.1.8 or later, `shell`, detailed `job` results and Context evidence preserve the host's complete exit code, including Windows values such as `3010` and `3221225477`. Interpret the code using the executed program's documentation and keep it with the Job's status and logs. Use a workspace-bound `job` query when you need the complete process result after a lifecycle notification.

## Recover from an invalid result

`tool_result_invalid` has an unknown operation state. Preserve available Job/workspace/correlation identifiers and inspect the original operation before deciding what to do next. **Do not automatically replay commands, input, patches or cancellation after an unknown outcome.** Error details are limited to safe metadata.

If a command finished but inline log retrieval failed, use its actual status and exit code, then retry the log query. See [call recovery](mcp-agent-call-contract.md).

## Refresh a stale catalog

The catalog fingerprint changes with its schemas. Compare the catalog actually loaded by your MCP client with the deployed Worker's catalog and refresh the affected connector when needed. [Capability diagnostics](capability-contracts.md) also separates Runner support from current permissions; every operation still needs both.
