# MCP agent call and recovery contract

## Discover before executing

Read the current authenticated `tools/list` catalog. The current source exposes ten tools: `runner_list`, `runner_current`, `runner_select`, `workspace_list`, `inspect`, `read`, `edit`, `shell`, `job`, and `context`. Compare the `io.runmesh/catalog` fingerprint when diagnosing a client/server mismatch. A client that still offers only nine tools, lacks `context`, or rejects `workspace_id` on Job follow-up actions has an obsolete catalog; refresh its connector metadata before relying on those capabilities.

Action tools publish both discoverable root properties and strict action-specific branches. Root properties do not authorize arbitrary field combinations. Unknown fields remain errors. `revision` belongs only to `inspect.git_show`; it is not a `git_blame` option. Paths are workspace-relative; a workspace ID is not a filesystem path.

## Keep operation identity

Resolve the selected Runner and a readable workspace before the first operation. Do not automatically change Runners during recovery. Save `job_id`, `workspace_id`, and any `request_id` from a shell launch. A foreground wait limit is not a process execution deadline, and an MCP success does not imply a zero command exit code.

For example, after a shell receipt returns `job_id: job-original` and `workspace_id: work`, query that operation rather than launching it again:

```json
{"action":"get","job_id":"job-original","workspace_id":"work"}
```

```json
{"action":"logs","job_id":"job-original","workspace_id":"work","stream":"stdout","offset":0,"limit":16384}
```

Foreground shell output is a bounded tail. A positive output `offset` means the beginning was omitted from that response even if the stored log itself was not truncated. An absent cloud history record does not prove the local Job is missing. Workspace-bound Job requests remain permission-checked against the actual Job before reading, accepting input, or cancelling it.

## Interpret failures by state, not HTTP status alone

Tool execution failures carry `isError: true` and an error envelope with `code`, `failure_class`, `operation_state`, `next_action`, and `recovery_hint`. The text representation preserves the same bounded JSON metadata for text-only clients. Protocol-level failures and SDK argument-validation responses retain their MCP SDK conventions; do not assume every invalid request reaches a tool handler.

| Failure | Meaning and recovery |
| --- | --- |
| `busy`, `queue_full` with `not_started` | Admission rejected the request. Respect the advertised retry delay. |
| `runner_offline` with `unknown`, or `timeout` | Dispatch may have happened. Inspect the original Job/workspace; do not replay mutations, input, or cancellation. |
| `runner_access_unavailable`, `registry_unavailable` before dispatch | Authorization dependencies could not be checked. This is not evidence of expired credentials. Wait for service recovery. |
| `runner_expired`, `runner_not_active`, `runner_not_authorized` | An explicit authorization decision rejected the request. An administrator must correct the authorization period or grants. |
| `authorization_response_invalid` | The authorization response is malformed. Execution remains blocked; ask the operator to investigate rather than changing permissions blindly. |
| `job_history_unavailable` | Repeat only the Job query with the original Job ID and workspace ID. Do not relaunch the shell command. |
| `path_changed`, `baseline_changed` | Re-read the path/baseline before constructing a fresh operation. |
| `request_too_large` | The encoded request was rejected before dispatch. Reduce its size. |
| `runner_upgrade_required` with `not_started` | The selected Runner lacks required support. Upgrade to a verified compatible Runner release and reconnect before making a new call. |
| `tool_result_invalid` | A dispatched reply failed its contract or Job identity check. Preserve the original receipt and treat the outcome as unknown. |
| Unknown/future bridge code | The public boundary returns a conservative internal/unknown failure, never a fabricated safe retry. |

Only `not_started` can justify admission retries. A known error code is not sufficient proof when `operation_state` says `unknown`, `running`, or `committed`. Partial prune and rollback failures must be reconciled, not replayed.

## Pagination and mutations

Copy opaque cursors exactly. A bound file/log cursor cannot be combined with an explicit offset, live consistency, or log tail mode. Start snapshot/append reads without a legacy numeric cursor. Rotation, expiry, or changed file identity requires a fresh read, not command execution.

`job.input` requires `data` or `close_stdin: true`. A patch preview cannot also supply `preview_id`. Context Job evidence requires a Job ID, while other evidence kinds cannot claim one. Context prune defaults to preview; only `apply: true` accepts and requires the fresh `expected_plan_hash`. Approval to preview is not approval to prune.

## Check the installed versions

Compare the deployed Worker, selected Runner and the catalog your MCP client actually loaded. Updating the Worker does not upgrade the Runner, and neither action guarantees that the client refreshed its cached schema. Use [capability diagnostics](capability-contracts.md) to distinguish missing Runner support from missing permissions or a stale connector catalog.
