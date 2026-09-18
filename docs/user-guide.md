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

1. Call `runner_list`, then `runner_select` when selection is needed. Switching an existing selection requires `confirm_switch: true`.
2. Confirm with `runner_current`, then call `workspace_list` to see your permitted workspace IDs.
3. Start with `read` or `inspect` before changing files or starting commands.

A workspace ID is not a host path. Paths supplied to file tools are relative to that workspace. Runmesh does not silently switch machines when the selected Runner is offline. Keep the original Runner selected when following up a Job.

Examples below describe the current source contract. Use your authenticated tool catalog and the actual IDs returned by your instance. A published older Runner or cached client definition may not expose every feature; see [release notes](release-notes.md) and [troubleshooting](troubleshooting.md) rather than inventing unsupported arguments.

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

Foreground output may contain only a tail. A positive `offset` means earlier bytes were omitted from that response; use paginated `job.logs` to request retained bytes. Copy returned cursors unchanged and do not combine a cursor with a new offset or tail mode when the catalog forbids it.

Stored logs also have limits. `output_truncated` can mean bytes were discarded and are no longer recoverable through Runmesh. Ask the administrator to inspect separately configured application logs; Runmesh does not guarantee a complete second copy on the host.

`input` requires `data` or `close_stdin: true`; closing stdin sends end-of-input. `cancel` requests cancellation and needs Job-control permission. Neither a delivery error nor a timeout proves nothing happened: inspect state before repeating input or cancellation. If process identity cannot be verified, cancellation may be refused while the process and its concurrency slot remain retained. An administrator should inspect the host rather than signal a guessed PID.

Cloud history is an optional recent snapshot, not a full output archive. Turning recording off does not stop local jobs; reading logs does not turn it back on. Live input, cancellation and local output need an online, authorized Runner. Previously recorded metadata may remain visible while it is offline.

## Get help safely

For permission errors, the client, Runner and workspace must all allow the operation. For an offline Runner, restore that machine or explicitly select a different one for new work. Dependency outages are not evidence that credentials need rotation.

Use [troubleshooting](troubleshooting.md) for recovery. Report the time, operation, versions and redacted error code. Do not include MCP URLs, enrollment commands, tokens, private file contents or unrestricted command output. Never run untrusted code on a high-privilege Runner.
