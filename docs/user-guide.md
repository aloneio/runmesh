# User guide

[简体中文](user-guide.zh-CN.md) · [Documentation](README.md)

Runmesh lets an MCP-compatible AI client use computers and workspaces approved by an administrator. You need a complete MCP URL, a client that supports Streamable HTTP, and permission to use at least one Runner and workspace.

## Connect your client

Add the complete administrator-supplied URL in the client's MCP settings:

```text
https://your-host.example/<generated-secret>/mcp
```

The URL is a secret credential, shown only when created or rotated. Do not rewrite its path or add a Bearer token. Remove accidental spaces or line breaks. Never share the real URL in a chat, screenshot, ticket or repository.

## Choose the machine and workspace

1. Call `runner_current` to check your current selection, and `runner_list` to find the intended machine.
2. If no Runner is selected, call `runner_select` even when the list shows only one machine. Switching an existing selection requires `confirm_switch: true`. Confirm the result with `runner_current`.
3. Call `workspace_list` to see your permitted workspace IDs. Start with `read` or `inspect` before changing files or starting commands.

A workspace ID is not a host path. Paths supplied to file tools are relative to that workspace. Runmesh does not silently switch machines when the selected Runner is offline. Keep the original Runner selected when following up a Job.

Use the tool catalog and actual IDs returned by your instance with the examples below. Available actions depend on the deployed Worker, installed Runner and client catalog. If an action is missing or returns `runner_upgrade_required`, check [release notes](release-notes.md) and [troubleshooting](troubleshooting.md); refreshing a client cannot add a capability to an older Runner.

## Read, inspect and edit

For a workspace called `work`, reading a file uses:

```json
{"workspace_id":"work","path":"README.md"}
```

`inspect` can list files, search text and inspect Git. Action-specific options are not interchangeable: `git_show` requires `revision`, but `git_blame` does not accept it. Use `git_log` to discover a commit and `git_blame` with optional line bounds for attribution. Refresh the client tool catalog after a Worker update when its available actions or fields differ from the server.

Read a file before using `edit`, and keep the observed baseline. A baseline conflict means another change may have occurred; re-read and rebuild the patch instead of overwriting it. A timeout or unknown mutation outcome is different: inspect the file first to find out whether the edit already applied. Do not use `shell` to bypass denied workspace permissions.

## Start a command and keep its receipt

`shell` runs with the Runner service account's operating-system permissions. It is not a sandbox. Start with a harmless check in an approved workspace:

```json
{"workspace_id":"work","command":"echo runmesh-ok","wait_ms":1000}
```

Save the returned `job_id` and `workspace_id`. `wait_ms` limits how long the call waits, not how long the command may execute. A running or queued receipt is not a failure. An MCP call that successfully returns a receipt does not mean the command itself succeeded; check Job status and, when available, `exit_code`.

Closing the browser, ending a request or a brief connection loss does not automatically stop an already-started process. If a call times out, query the original Job rather than launching the command again. When a supported `request_id` is used, keep the same key bound to the same launch input; it does not replace checking the original operation.

## Follow the same Job

Replace `job-from-shell` with the exact ID from your receipt. On instances with the workspace-bound Job contract, use:

```json
{"action":"get","job_id":"job-from-shell","workspace_id":"work"}
```

```json
{"action":"logs","job_id":"job-from-shell","workspace_id":"work","stream":"stdout","offset":0,"limit":16384}
```

Use `list` with the workspace ID to inspect recent local Jobs. A Job may exist on the Runner even when it has no cloud history. An empty dashboard or missing archive is not a reason to run the command again. Workspace-bound queries still require permission for the Job's actual workspace. If the client rejects `workspace_id`, have the administrator check Worker, Runner and cached tool definitions.

| Status | What it means for you |
| --- | --- |
| `queued` | Waiting for a slot. Do not submit a duplicate. A compatible queue rechecks access before starting. |
| `running` | The process is supervised by the Runner. |
| `cancelling` | Cancellation is in progress; this is not proof the process has exited. |
| `cancelled` | A queued task was withdrawn, or cancellation evidence supports the observed termination. |
| `succeeded` | The Runner observed a successful process exit. |
| `failed` | Launch or execution failed. Read available output and error details. |
| `unknown` | A recovered process may still be alive, but its final outcome is not known. Do not replay it. |
| `interrupted` | Recovery could not continue the original execution; do not infer success or a particular exit code. |

After a Runner restart, queued work is not blindly replayed and recovered work may be uncertain. A cancellation racing with a normal code-zero exit can still end as `succeeded`.

## Logs, input and cancellation

Foreground output may contain only a tail. A positive `offset` means earlier bytes were omitted from that response; use the `job` tool's `logs` action to request retained bytes in pages. Copy returned cursors unchanged and do not combine a cursor with a new offset or tail mode when the catalog forbids it.

Stored logs also have limits. `output_truncated` can mean bytes were discarded and are no longer recoverable through Runmesh. Ask the administrator to inspect separately configured application logs; Runmesh does not guarantee a complete second copy on the host.

`input` requires `data` or `close_stdin: true`; closing stdin sends end-of-input. `cancel` requests cancellation and needs Job-control permission. Neither a delivery error nor a timeout proves nothing happened: inspect state before repeating input or cancellation. If process identity cannot be verified, cancellation may be refused while the process and its concurrency slot remain retained. An administrator should inspect the host rather than signal a guessed PID.

Cloud history is an optional recent snapshot, not a full output archive. Turning recording off does not stop local jobs; reading logs does not turn it back on. Live input, cancellation and local output need an online, authorized Runner. Previously recorded metadata may remain visible while it is offline.

## Keep workspace handoff notes

The `context` tool stores explicit handoff notes on the selected Runner. Use `bootstrap` to find available context, `read` or `search` to retrieve it, and `checkpoint` to save a goal, decisions, evidence and next actions. A checkpoint requires write permission. Runmesh does not automatically record your conversation or hidden reasoning.

On a compatible Worker and Runner, `storage` reports local Context usage and `prune` previews removal of older revisions. Applying a preview requires its plan hash and an explicit `apply: true`; the latest revision is retained. See [Context storage](context-storage.md) before deleting anything. These storage-management actions are not present in the published 0.1.3 Runner; a newer tool catalog alone does not make them available.

## Get help safely

For permission errors, the client, Runner and workspace must all allow the operation. For an offline Runner, restore that machine or explicitly select a different one for new work. Dependency outages are not evidence that credentials need rotation.

Use [troubleshooting](troubleshooting.md) for recovery. Report the time, operation, versions and redacted error code. Do not include MCP URLs, enrollment commands, tokens, private file contents or unrestricted command output. Never run untrusted code on a high-privilege Runner.
