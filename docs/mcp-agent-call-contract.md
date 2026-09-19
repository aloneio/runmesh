# Call MCP tools and recover operations

Read the current authenticated `tools/list` catalog before using Runmesh. It exposes ten tools: `runner_list`, `runner_current`, `runner_select`, `workspace_list`, `inspect`, `read`, `edit`, `shell`, `job` and `context`. Compare `io.runmesh/catalog` when diagnosing a stale connector; refresh its metadata if it omits tools or rejects current parameters.

## Prepare the call

Select the intended Runner and a readable workspace. Action tools publish shared root properties and action-specific branches; use the fields for the chosen action. Unknown fields are rejected. For example, `revision` belongs to `inspect`'s `git_show` action. Paths are workspace-relative, and `workspace_id` is the opaque identifier from `workspace_list`.

Save `job_id`, `workspace_id` and any `request_id` from a shell launch. Keep that Runner selected while following the operation. Foreground waiting ends at its wait limit while the command can continue; check the Job's status and exit code even when the MCP call succeeds.

## Follow the original Job

After receiving `job_id: job-original` and `workspace_id: work`, query:

```json
{"action":"get","job_id":"job-original","workspace_id":"work"}
```

```json
{"action":"logs","job_id":"job-original","workspace_id":"work","stream":"stdout","offset":0,"limit":16384}
```

Foreground shell output is a bounded tail. A positive `offset` means its prefix was omitted from that response; read from offset zero to retrieve the retained beginning. If cloud history is absent, use these workspace-bound live queries. They check the actual Job workspace before reading, accepting input or cancelling.

## Recover according to operation state

Tool failures carry `isError:true` with `code`, `failure_class`, `operation_state`, `next_action` and `recovery_hint`. Text-only clients receive the same bounded JSON metadata. Protocol and SDK argument-validation errors use their own MCP conventions.

| Result | Next action |
| --- | --- |
| `busy` or `queue_full`, `not_started` | Respect the returned retry delay before retrying admission. |
| `runner_offline` with `unknown`, or `timeout` | Inspect the original Job/workspace; dispatch may already have occurred. |
| `runner_access_unavailable` or `registry_unavailable` before dispatch | Wait for authorization services to recover, then use the existing valid credential. |
| `runner_expired`, `runner_not_active`, `runner_not_authorized` | Ask an administrator to correct the intended validity window or grants. |
| `authorization_response_invalid` | Ask the operator to investigate the authorization response. |
| `job_history_unavailable` | Query the original Job with its workspace ID when the Runner is online. |
| `path_changed` or `baseline_changed` | Read the current path/baseline, then construct a fresh operation. |
| `request_too_large` | Reduce the encoded request size. |
| `runner_upgrade_required` with `not_started` | Install a verified compatible Runner release and reconnect. |
| `tool_result_invalid` | Preserve the original receipt and inspect the operation; its outcome is unknown. |
| Unknown bridge code | Treat the result as internal/unknown and ask the operator to investigate. |

Only `not_started` can justify an admission retry. **Do not automatically replay a mutation, input or cancellation when its state is `unknown`, `running` or `committed`.** Reconcile partial prune or rollback failures against current state before another operation.

## Use cursors and previews

Copy opaque cursors exactly and keep their original resource/consistency mode. Bound continuations exclude explicit offsets, live consistency and log tail mode. Start snapshot/append reads with no cursor. After expiry, rotation or a file change, start a fresh read of the existing resource.

`job.input` requires `data` or `close_stdin:true`. Patch preview uses `preview:true`; `preview_id` belongs to apply. Context evidence of kind Job requires a Job ID; other evidence kinds use their own fields. Context prune starts with preview, and `apply:true` requires its fresh `expected_plan_hash`. Review the proposed deletion before explicitly applying it.

## Check compatibility

Worker deployment, Runner installation and MCP connector refresh are separate steps. Use [capability diagnostics](capability-contracts.md) to distinguish missing Runner support, missing permission and a stale catalog.
