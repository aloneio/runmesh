# Protocol contract

The authoritative TypeScript Runner↔Worker contract is `packages/protocol/src/schema.ts`; the generated language-neutral artifact is `packages/protocol/schema/wire-message.schema.json`. MCP active-Runner routing is Worker/Registry control-plane behavior layered above this wire contract.

## Frame rules

- JSON text or UTF-8 bytes only.
- Maximum encoded frame: 1 MiB, enforced before parsing and again when encoding.
- Every frame has `protocol_version`.
- Correlated requests/replies/events have a bounded `request_id`.
- RPC request parameters/results are JSON values with bounded depth/node validation.
- Unsupported or malformed frames are rejected; unknown request IDs are ignored.
- Same-major optional behavior belongs under the explicit `extensions` field rather than silently adding top-level fields.

## Negotiation

A Runner sends `runner.hello` with a supported min/max range. The Worker responds with `runner.welcome` and the highest overlapping version. All later frames must use the negotiated version. If no overlap exists, the connection closes with an unsupported-protocol error.

## Runner connection messages

```text
runner.hello       Runner → Worker; metadata, supported range, correlation
runner.welcome     Worker → Runner; session and negotiated version
runner.heartbeat   Runner → Worker; liveness and active job IDs
runner.sync        Runner → Worker; monotonic snapshot sequence, workspace/job metadata
```

Workspace metadata contains only `workspace_id`, persistence, revision, and labels. The private `root_path` is delivered only in authenticated Runner-only policy frames; it is never returned in MCP output, workspace metadata, ordinary logs, or public APIs. A Runner has a stable `runner_id`; dashboard/MCP display names are control-plane metadata rather than a transport routing parameter.

## RPC and timeout contract

```json
{
  "type": "rpc.request",
  "protocol_version": 2,
  "request_id": "bridge-uuid",
  "policy_revision": 7,
  "method": "fs.read",
  "params": {
    "workspace_id": "zero",
    "path": "src/index.ts",
    "cursor": "0",
    "limit": 32768
  }
}
```

The Worker separates **offline Snapshot Authorization** from **Live Runner Admission**. Snapshot Authorization uses only a validated immutable Active Policy and can safely serve retained Registry metadata while the Runner is offline. Live Admission is a separate proof for filesystem, execution, inspection, complete logs, input, and cancellation: it requires the current online Runner session, matching epoch/credential generation, an unfenced RunnerDO, and one matching desired/applied/reported revision-and-checksum triad. A policy mutation fences Live Admission before Registry state changes; it is unfenced only when the same session proves the pre-mutation active triad remains applied.

The forwarding payload contains the requested revision and both expected identity fields:

```json
{
  "method": "fs.read",
  "params": { "workspace_id": "zero", "path": "src/index.ts" },
  "policy_revision": 7,
  "expected_policy_revision": 7,
  "expected_policy_checksum": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

The shared deadline constants are:

```text
LOCAL_RUNNER_OPERATION_TIMEOUT_MS = 8000
WORKER_BRIDGE_TIMEOUT_MS          = 12000
```

The local limit applies to `exec_run` and Git. The larger bridge limit reserves time for the response to cross the RunnerDO/WebSocket path. Long work uses `exec_start` and the persistent Job API.

## MCP routing boundary

MCP clients authenticate to `/<secret>/mcp`, then the Worker resolves their Registry-stored active Runner. `runner_list`, `runner_current`, and `runner_select` are MCP control tools; their `runner_id` argument/result is not added to the Runner coding RPC parameter schemas.

For all ordinary MCP filesystem, execution, Git, workspace, and job tools, the Worker selects the Runner before forwarding and schemas retain `workspace_id` where needed. `runner_id` has been removed from ordinary MCP tool inputs. This means a protocol implementation receives RPC parameters for its already-established connection, not client-directed arbitrary Runner routing.

Selection is sticky per MCP client. The first selection is immediate, a switch requires `confirm_switch: true`, and unavailable/offline selected Runners produce errors without fallback. An unselected client can be automatically persisted only when exactly one registered Runner exists. This routing is not multi-tenant authorization: MCP clients in the one-admin instance that select the same Runner and have compatible scopes share workspace IDs and job metadata visibility.

## Jobs

`job_list` reads bounded Registry snapshots, so historical metadata remains available while that selected Runner is offline. `job_get` returns an existing Registry record with `source: "registry_snapshot"` and `runner_state: "offline"` during that gap; unknown IDs return `not_found`. Complete logs remain on the Runner and therefore require live admission.

```text
exec_start(workspace_id, ...)
job_list(workspace_id?, status?, limit?)
job_get(job_id)
job_logs(job_id, cursor/offset/limit/tail)
job_cancel(job_id)
job_input(job_id, data/close_stdin)
```

The selected Runner is implicit in those ordinary MCP tools. `job_list` reads bounded Registry snapshots, so historical metadata remains available while that selected Runner is offline. It never exposes local cwd, command, PID, or host root.

MCP Tasks (`io.modelcontextprotocol/tasks`) is not claimed by this runtime. A future adapter can map an MCP Task handle to the same local Job Manager without changing the Runner job lifecycle.

## Enrollment and credential lifecycle outside the frame schema

Enrollment happens before the WebSocket protocol:

1. The dashboard or Registry creates a 30-minute, single-use code for a Runner ID.
2. `coding-runner enroll --server <https endpoint> --code-stdin` reads the one-time code from standard input and sends it with bounded public platform/version data to `POST /runner/enroll`. `--code` remains an explicit compatibility option, but generated installer commands never place the code in argv, URLs, environment variables, or copied commands.
3. On one successful redemption, the Worker returns the Runner ID, WebSocket URL, and long-lived token; Registry stores only a peppered token verifier.
4. `runner.hello` then authenticates the outbound Runner socket under that credential/version/epoch.

The enrollment code itself is not a wire frame and is never sent over the subsequent WebSocket. Credential rotation/revocation invalidates the socket generation. It does not imply that the Worker can terminate a pre-existing local child process.

## Versioning guidance

A new Go/Rust implementation should consume the JSON Schema and implement the same semantic checks. The generated schema cannot represent every cross-field invariant, so also implement:

- `min_protocol_version <= max_protocol_version`;
- `runner.welcome.negotiated_protocol_version` equals the frame version and is in the hello overlap;
- terminal `job.completed` status/outcome consistency;
- unique IDs in a complete `runner.sync` snapshot;
- monotonic `sync_sequence` per Runner session;
- monotonic job `updated_at_ms` when applying sync/events;
- `created_by_client_id`, when present, is metadata only and does not change job ownership semantics.

## Scope boundary

This protocol does not add OAuth, AI/model calls, Cloudflare Sandbox, Cloudflare Containers, or GitHub Actions runtime. Public bootstrap scripts are Worker application endpoints outside the wire protocol. They remain fail-closed until an operator has published and independently verified the exact signed `v0.1.0-dev.2` assets, configures a canonical external HTTPS `RUNMESH_PUBLIC_ORIGIN`, and explicitly sets `RUNMESH_SIGNED_RELEASE_AVAILABLE=0.1.0-dev.2`; both deployment conditions are required. When enabled, the code-free installer command retrieves only fixed GitHub release assets, verifies the embedded-key Ed25519 contract, installs the verified local tarball, then prompts locally for the single-use code and uses `--code-stdin`. The Worker-delivered script is the one-command bootstrap trust root; high-assurance operators use the independent portable-artifact verification path. Automatic update, data downgrade, and upgrade rollback are outside this preview.
