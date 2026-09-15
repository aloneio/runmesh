# Public MCP output contracts (AR05)

The ten existing public tool names and their input schemas remain stable. Every tool now has an explicit closed output schema instead of falling back to an arbitrary passthrough object. Existing allow-list projectors remain the owner of secret/path removal and response budgets.

`mcp/output-contracts.ts` describes public metadata and aggregate tool output shapes. Legacy observations are optional rather than invented. `mcp/action-output-contracts.ts` supplies required evidence and closed variants for each action in the existing `MCP_RPC_ACTIONS` map; the map's keys are checked by TypeScript and regression tests. The stable aggregate schema is advertised in `tools/list`, while input-aware validation runs before successful results leave the tool wrapper.

`mcp/handler-registry.ts` requires exactly one own data-property callback for each public tool. Missing, extra, inherited or getter-backed handlers fail before registration. The server still owns fresh per-request scope and credential revalidation; this registry neither caches nor grants authorization.

Malformed successful output becomes `tool_result_invalid` with an unknown operation state. Safe existing Job/workspace/correlation identifiers and audit observations are retained when available, but private fields and validation exception details are not exposed. No command, input, patch or cancellation is automatically replayed. Existing error envelopes remain on their existing path. A successful command with unavailable logs still retains its actual status and exit code.

## Compatibility and limits

An explicit bounded truncation envelope remains supported; an empty object is not a successful receipt. Older valid results can omit optional observations, but wrong types, undeclared fields and absent required action evidence are rejected. For example, `job.input` returns `accepted` bytes and optional `eof`, not a JobRecord; the old broad test mock is corrected and a negative regression preserves that distinction.

The public aggregate JSON Schema cannot express the dependency on a separate request's action; the action validators enforce that relationship. This is not a complete shared Worker/Runner typed-RPC redesign, capability-disable implementation or automatic client-cache refresh. The advertised catalog fingerprint changes when its output schemas change. No new public tool, required runtime variable, RPC, persistent record or timer is added, but schema validation and the larger catalog have CPU/transport costs that must not be described as zero.

Validation includes fixed valid/invalid result fixtures, exact handler/action coverage, current real MCP transport tests, no-record/permission regressions and packaged end-to-end checks. Source, test, published asset and production activation are separate acceptance stages.
