# Protocol contract

Runner/Worker implementations use `packages/protocol/src/schema.ts` and the generated `packages/protocol/schema/wire-message.schema.json`. MCP Runner selection is control-plane routing layered above this connection protocol.

## Encode and negotiate frames

- Frames contain JSON text or UTF-8 bytes, capped at **1 MiB** before parsing and when encoding.
- Every frame carries `protocol_version`; correlated requests, replies and events carry a bounded `request_id`.
- RPC parameters/results are JSON values subject to depth and node limits.
- Malformed or unsupported frames are rejected; unknown response IDs are ignored.
- Same-major optional behavior uses the explicit `extensions` field.

The Runner sends its supported min/max range in `runner.hello`. The Worker selects the highest overlapping version in `runner.welcome`; subsequent frames use that version. A disjoint range closes the connection with an unsupported-protocol error.

```text
runner.hello          Runner → Worker; metadata, supported range, correlation
runner.welcome        Worker → Runner; session, negotiated version and desired policy
runner.policy_update  Worker → Runner; authenticated workspace policy
runner.policy_ack     Runner → Worker; applied revision/checksum or failure
runner.heartbeat      Runner → Worker; liveness and active job IDs
runner.sync           Runner → Worker; monotonic sequence, workspace/Job metadata
runner.queue_check    Runner → Worker; current authorization before a queued launch
```

Workspace metadata contains `workspace_id`, persistence, optional revision and labels. Private `root_path` values travel to the Runner in authenticated policy frames. Requested user content can contain paths of its own. The stable `runner_id` identifies the connection; display names are control-plane metadata.

## Authorize and dispatch an RPC

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

Offline snapshot reads require current authorization against a validated immutable Active Policy. Live operations additionally require an online session, matching epoch/credential generation and agreement on desired, applied and reported policy revision/checksum. Policy reconciliation can temporarily block live operations.

The Worker's forwarding payload binds the expected policy identity:

```json
{
  "method": "fs.read",
  "params": { "workspace_id": "zero", "path": "src/index.ts" },
  "policy_revision": 7,
  "expected_policy_revision": 7,
  "expected_policy_checksum": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

```text
LOCAL_RUNNER_OPERATION_TIMEOUT_MS = 8000
WORKER_BRIDGE_TIMEOUT_MS          = 12000
```

`exec.run` uses the local limit for foreground waiting while its process can continue. Git subprocesses use it as an execution timeout. The larger bridge budget allows transport and scheduling time. Follow long-running work through the original Job; a bridge timeout requires checking whether dispatch occurred before retrying a mutation.

## Route MCP operations

MCP clients authenticate at `/<secret>/mcp`. `runner_list`, `runner_current` and `runner_select` manage the client's sticky selection; workspace operations then use that Runner and their required `workspace_id`.

The first selection is immediate, switching requires `confirm_switch:true`, and a selected unavailable Runner returns its own error. Automatic initial selection is available only when exactly one registered Runner exists. Clients with the appropriate scopes and permissions share workspace and Job visibility on the selected Runner.

## Select the Job data source

Use the public `job` tool. Its actions map to private `job.*` RPCs when live access is required.

| Request | Source |
| --- | --- |
| `action=list` with `workspace_id`, Runner online | Local metadata, `source=runner_live` |
| `action=list` without a workspace or while offline | Retained cloud metadata filtered by current workspace permissions |
| `action=get` with `job_id` and `workspace_id` | Live lookup independent of cloud history |
| `action=get` without a workspace | Cloud record identifies/authorizes the workspace, then the Worker queries an online Runner or returns the offline snapshot |
| `action=logs/cancel/input` | Live admission; supplying `workspace_id` avoids dependence on a cloud record |

Offline results use `source:"registry_snapshot"` and `runner_state:"offline"`, including with D1 storage. Missing cloud history returns `job_history_unavailable`; preserve the original Job/workspace IDs and use a live query when the Runner is available. Unrecorded Jobs require live access.

Job metadata excludes cwd, command, PID and host root. Requested log pages pass from the Runner through the Worker to the authorized client. Production D1 retains at most **500 recent metadata records** in a **768 KiB row** per Runner lifecycle. See [history settings](batched-job-history.md). Long-running work uses this Job API; MCP Tasks (`io.modelcontextprotocol/tasks`) is not advertised.

## Enroll before connecting

1. Create a single-use Runner enrollment code in the administrator interface. Use its displayed validity window; the underlying default is 30 minutes when no override is supplied.
2. Run `runmesh enroll --server <https endpoint> --code-stdin`. The CLI sends the code and bounded platform/version metadata to `POST /runner/enroll`. Controlled manual use also accepts `--code`.
3. Successful redemption returns the Runner ID, WebSocket URL and long-lived token. Registry stores a peppered token verifier.
4. Open the authenticated outbound WebSocket and send `runner.hello` to bind metadata to the current credential and connection epoch.

The enrollment code is used only for redemption. Credential rotation/revocation invalidates the connection generation; stop an already running local process through explicit Job cancellation or host control.

Hosted installation additionally requires a verified release in its channel. The reviewed **0.1.4** activation enables stable hosted distribution in source; check the deployed Worker's release descriptor before installation. Development uses verified signed prereleases. See [deployment](deployment.md) and [portable installation](portable-runner-installation.md).

Hosted commands contain the one-time code. To use the omitted-code prompt on Windows, remove `-NonInteractive` and use an interactive administrator terminal. Treat any copied command containing the code as a credential.

## Implement semantic checks

Alongside the generated schema, validate:

- `min_protocol_version <= max_protocol_version`;
- welcome's negotiated version equals its frame version and belongs to the hello overlap;
- terminal `job.completed` status/outcome consistency;
- unique IDs in a complete `runner.sync` snapshot;
- monotonic `sync_sequence` within a session;
- monotonic Job `updated_at_ms` while applying updates;
- `created_by_client_id` as creator metadata; authorization remains workspace-based.

## Handle structured failures

`rpc.error.error` contains a code and bounded message, with optional:

- `failure_class`: validation, authorization, availability, conflict, resource, execution, internal or unknown;
- `operation_state`: not_started, running, committed or unknown;
- `retry_after_ms`: a bounded safe-retry delay;
- `next_action`: a stable action such as refresh_permissions, re_read_and_retry or inspect_job.

Use these fields to choose recovery. **Do not automatically replay a possible side effect when its outcome is unknown.** See [call recovery](mcp-agent-call-contract.md). [Queue protocol 1](job-queue-and-localization.md) is available from Runner 0.1.3 with a compatible Worker.
