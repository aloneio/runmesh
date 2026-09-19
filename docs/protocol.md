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
runner.hello          Runner → Worker; metadata, supported range, correlation
runner.welcome        Worker → Runner; session, negotiated version and desired policy
runner.policy_update  Worker → Runner; authenticated workspace policy
runner.policy_ack     Runner → Worker; applied revision/checksum or failure
runner.heartbeat      Runner → Worker; liveness and active job IDs
runner.sync           Runner → Worker; monotonic snapshot sequence, workspace/job metadata
runner.queue_check    Runner → Worker; current authorization before a queued launch
```

Workspace metadata contains only `workspace_id`, persistence, revision, and labels. The private `root_path` travels from the control plane to the Runner in authenticated policy frames and is omitted from public workspace/protocol metadata. User files, command output and requested log bodies can still contain paths; their contents are not automatically redacted. A Runner has a stable `runner_id`; dashboard/MCP display names are control-plane metadata rather than a transport routing parameter.

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

The Worker separates **offline Snapshot Authorization** from **Live Runner Admission**. Snapshot Authorization uses a validated immutable Active Policy to authorize retained metadata reads while the Runner is offline. Live Admission additionally requires the current online session, matching epoch/credential generation, and agreement on the desired, applied and reported policy revision/checksum. Policy changes can temporarily block live operations until the control plane and current Runner session agree. An offline snapshot never authorizes host access.

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

For `exec.run`, the local limit bounds foreground waiting, not the command's execution lifetime. Git subprocesses use it as their execution timeout. The larger bridge limit allows time for transport and scheduling. Use `shell` with `background:true` for long work, then follow the original Job through the `job` tool. A bridge timeout does not prove that an operation never started.

## MCP routing boundary

MCP clients authenticate to `/<secret>/mcp`, then the Worker resolves their Registry-stored active Runner. `runner_list`, `runner_current`, and `runner_select` are MCP control tools; their `runner_id` argument/result is not added to the Runner coding RPC parameter schemas.

For all ordinary MCP filesystem, execution, Git, workspace, and job tools, the Worker selects the Runner before forwarding and schemas retain `workspace_id` where needed. `runner_id` has been removed from ordinary MCP tool inputs. This means a protocol implementation receives RPC parameters for its already-established connection, not client-directed arbitrary Runner routing.

Selection is sticky per MCP client. The first selection is immediate, a switch requires `confirm_switch: true`, and unavailable/offline selected Runners produce errors without fallback. An unselected client can be automatically persisted only when exactly one registered Runner exists. This routing is not multi-tenant authorization: MCP clients in the one-admin instance that select the same Runner and have compatible scopes share workspace IDs and job metadata visibility.

## Jobs

Use the public `job` tool; `job.list`, `job.get`, `job.logs`, `job.cancel` and `job.input` are private RPC method names, not separate public tools. The selected Runner is implicit.

| Request | Data source and availability |
| --- | --- |
| `job` with `action=list` and `workspace_id`, Runner online | Live local Job metadata with `source=runner_live` |
| `job` with `action=list`, no workspace or Runner offline | Retained cloud metadata, filtered by current workspace permissions |
| `job` with `action=get`, `job_id` and `workspace_id` | Live Runner lookup, independent of optional cloud history |
| `job` with `action=get` and no workspace | Uses the cloud record to authorize its workspace, then queries the online Runner; an offline Runner can return that retained snapshot |
| `job` with `action=logs/cancel/input` | Requires live admission; supplying `workspace_id` avoids dependence on a cloud Job record |

Offline results carry `source: "registry_snapshot"` and `runner_state: "offline"`; that source label also covers the D1 history backend. Missing optional cloud history returns `job_history_unavailable`, not proof that the local Job is absent. Preserve the original Job and workspace IDs and retry the live query when the Runner is available. No-record Jobs have no offline cloud history.

Job metadata excludes local cwd, command, PID and host root. Full logs stay on the Runner; requested pages are relayed to the authorized client. Production D1 history retains at most 500 recent metadata records in a 768 KiB packed row per Runner lifecycle. See [history and retention](batched-job-history.md) for limits and compatibility.

MCP Tasks (`io.modelcontextprotocol/tasks`) is not claimed by this runtime. A future adapter can map an MCP Task handle to the same local Job Manager without changing the Runner job lifecycle.

## Enrollment and credential lifecycle outside the frame schema

Enrollment happens before the WebSocket protocol:

1. The dashboard or Registry creates a single-use code for a Runner ID. Use the validity window shown on the enrollment page; administrators can configure it. The underlying default is 30 minutes when no validity override is supplied.
2. `runmesh enroll --server <https endpoint> --code-stdin` reads the one-time code from standard input and sends it with bounded public platform/version data to `POST /runner/enroll`. For controlled manual use, the CLI also accepts `--code`; the hosted installer accepts a quoted code argument (positional, `--code CODE`, or `--code=CODE`) and forwards it through `--code-stdin` only after validation and installation checks. Without an argument it prompts locally.
3. On one successful redemption, the Worker returns the Runner ID, WebSocket URL, and long-lived token; Registry stores only a peppered token verifier.
4. The Runner opens an authenticated outbound WebSocket and sends `runner.hello`, binding its metadata to the current credential and connection epoch.

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

This protocol does not provide OAuth, AI/model calls, Cloudflare Sandbox, Cloudflare Containers, or a GitHub Actions runtime. Hosted installation is outside the wire protocol and requires a verified release in the selected channel. The current **0.1.4 candidate** does not enable stable distribution. Development uses separately verified signed prereleases without falling back to stable. The public HTTPS origin is validated from the request by default; `RUNMESH_PUBLIC_ORIGIN` is an optional override. See [deployment](deployment.md) for release gating and the [portable installation guide](portable-runner-installation.md) for independent artifact verification.

Hosted commands contain a single-use enrollment code and pass it to enrollment through standard input. Omitting the code can use an interactive prompt; on Windows, remove `-NonInteractive` from the copied command and use an interactive administrator terminal. Keep commands containing a code private. Updating the Worker does not automatically upgrade an installed Runner.

## Structured RPC failure semantics

The rpc.error.error object keeps the original code and bounded message, and may also include:

- failure_class: validation, authorization, availability, conflict, resource, execution, internal, or unknown;
- operation_state: not_started, running, committed, or unknown;
- retry_after_ms: a bounded delay only when retrying is safe;
- next_action: a stable client action such as refresh_permissions, re_read_and_retry, or inspect_job.

Clients should branch on these fields instead of matching error text. An unknown operation state must never be automatically replayed when the request could have produced a side effect.

## Shared Runner queue and localized UI

See [queue/UI contract](job-queue-and-localization.md) for capability negotiation, current authorization, bounded fair scheduling, restart interruption and server-side locale rendering. Queue protocol 1 is available from Runner 0.1.3 and requires a compatible Worker.
