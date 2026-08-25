# Protocol contract

The authoritative TypeScript contract is in `packages/protocol/src/schema.ts`; the generated language-neutral artifact is `packages/protocol/schema/wire-message.schema.json`.

## Frame rules

- JSON text or UTF-8 bytes only.
- Maximum encoded frame: 1 MiB, enforced before parsing and again when encoding.
- Every frame has `protocol_version`.
- Correlated requests/replies/events have a bounded `request_id`.
- RPC request parameters/results are JSON values with bounded depth/node validation.
- Unsupported or malformed frames are rejected; unknown request IDs are ignored.
- Same-major optional behavior belongs under the explicit `extensions` field rather than silently adding top-level fields.

## Negotiation

A Runner sends `runner.hello` with a supported min/max range. The Worker responds with `runner.welcome` and the highest overlapping version. All later frames must use the negotiated version. If no overlap exists, the connection closes with an unsupported protocol error.

## Runner connection messages

```text
runner.hello       Runner → Worker; metadata, supported range, correlation
runner.welcome     Worker → Runner; session and negotiated version
runner.heartbeat   Runner → Worker; liveness and active job IDs
runner.sync        Runner → Worker; monotonic snapshot sequence, workspace/job metadata
```

Workspace metadata contains only `workspace_id`, persistence, revision, and labels. A host root is never sent over the wire.

## RPC and timeout contract

```json
{
  "type": "rpc.request",
  "protocol_version": 1,
  "request_id": "bridge-uuid",
  "method": "fs.read",
  "params": {
    "workspace_id": "zero",
    "path": "src/index.ts",
    "cursor": "0",
    "limit": 32768
  }
}
```

A successful response is `rpc.response` with the same request ID. A rejected call is `rpc.error` with a bounded `{code,message,details?}`. The Worker never interprets coding RPCs; it validates/authenticates and forwards them to the current Runner socket.

The shared deadline constants are:

```text
LOCAL_RUNNER_OPERATION_TIMEOUT_MS = 8000
WORKER_BRIDGE_TIMEOUT_MS          = 12000
```

The local limit applies to `exec_run` and Git. The larger bridge limit reserves time for the response to cross the RunnerDO/WebSocket path. Long work uses `exec_start` and the persistent Job API.

## Jobs

`job.started`, `job.status`, and `job.completed` persist bounded metadata upstream. `job.output` is best-effort and is not a substitute for Runner-local logs. Full logs remain local and are read through `job.logs` pages.

The durable compatibility API is:

```text
exec_start → job_id
job_list(runner_id, workspace_id?, status?, limit?)
job_get(job_id)
job_logs(job_id, cursor/offset/limit/tail)
job_cancel(job_id)
job_input(job_id, data/close_stdin)
```

`job_list` reads bounded Registry snapshots, so historical metadata remains available while a Runner is offline. It never exposes local cwd, command, PID, or host root.

MCP Tasks (`io.modelcontextprotocol/tasks`) is not claimed by this MVP. A future adapter can map an MCP Task handle to the same local Job Manager without changing the Runner job lifecycle.

## Versioning guidance

A new implementation in Go/Rust should consume the JSON Schema and implement the same semantic checks. The generated schema cannot represent every cross-field invariant, so also implement:

- `min_protocol_version <= max_protocol_version`;
- `runner.welcome.negotiated_protocol_version` equals the frame version and is in the hello overlap;
- terminal `job.completed` status/outcome consistency;
- unique IDs in a complete `runner.sync` snapshot;
- monotonic `sync_sequence` per Runner session;
- monotonic job `updated_at_ms` when applying sync/events;
- `created_by_client_id`, when present, is metadata only and does not change job ownership semantics.
