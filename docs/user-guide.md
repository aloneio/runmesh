# User guide

[简体中文](user-guide.zh-CN.md) · [Documentation](README.md)

Runmesh lets an MCP-compatible AI client use computers and workspaces approved by an administrator. You need a complete MCP URL, a client that supports Streamable HTTP, and permission to use at least one Runner and workspace.

## Connect your client

Add the complete administrator-supplied URL in the client's MCP settings:

```text
https://your-host.example/<generated-secret>/mcp
```

The URL is the credential. Copy it exactly, including its secret path, and remove accidental spaces or line breaks. Use URL authentication without an additional Bearer token. Keep the real URL out of chats, screenshots, tickets and repositories; it is shown only when created or rotated.

## Choose the machine and workspace

1. Call `runner_current` to check your current selection, and `runner_list` to find the intended machine.
2. If no Runner is selected, call `runner_select` even when the list shows only one machine. Switching an existing selection requires `confirm_switch: true`. Confirm the result with `runner_current`.
3. Call `workspace_list` to see your permitted workspace IDs. Start with `read` or `inspect` before changing files or starting commands.

Use the workspace ID returned by `workspace_list` and file paths relative to that workspace. Your Runner selection persists while it is offline. Keep the original Runner selected when following up a Job.

Use your instance's tool catalog and actual IDs with the examples below. A missing action may require a client catalog refresh; `runner_upgrade_required` calls for a compatible Runner. Check [release notes](release-notes.md) and [troubleshooting](troubleshooting.md) for the applicable update.

## Read, inspect and edit

For a workspace called `work`, reading a file uses:

```json
{"workspace_id":"work","path":"README.md"}
```

`inspect` lists files, searches text and inspects Git. Use `git_log` to find a commit, `git_show` with the required `revision` to view it, and `git_blame` with optional line bounds for attribution. `revision` belongs only to `git_show`. After a Worker update, refresh the client catalog if its actions or fields differ from the server.

Read a file before using `edit` and keep the observed baseline. On a baseline conflict, re-read the file and rebuild the patch. After a timeout or unknown outcome, inspect whether the edit already applied before retrying. Ask the administrator to resolve a permission denial.

## Start a command and keep its receipt

`shell` runs with the Runner service account's operating-system permissions. Use a separate container or VM for untrusted code. Start with a harmless check in an approved workspace:

```json
{"workspace_id":"work","command":"echo runmesh-ok","wait_ms":1000}
```

Save the returned `job_id` and `workspace_id`. `wait_ms` controls how long this call waits for a result; a command can continue afterward. Follow a `running` or `queued` receipt until the Job reaches a final state, and check `exit_code` when present.

An already-started process continues across browser closure and brief connection loss. After a timeout, query the original Job before considering another launch. If you use a supported `request_id`, keep that key bound to the same launch input.

## Follow the same Job

Replace `job-from-shell` with the exact ID from your receipt. On instances with the workspace-bound Job contract, use:

```json
{"action":"get","job_id":"job-from-shell","workspace_id":"work"}
```

```json
{"action":"logs","job_id":"job-from-shell","workspace_id":"work","stream":"stdout","offset":0,"limit":16384}
```

Use `list` with the workspace ID to inspect recent local Jobs, including Jobs with cloud recording disabled. Queries require permission for the Job's actual workspace. If the client rejects `workspace_id`, have the administrator check the Worker, Runner and cached tool definitions.

| Status | What it means for you |
| --- | --- |
| `queued` | Waiting for a slot; access is checked again before starting. |
| `running` | The process is supervised by the Runner. |
| `cancelling` | Cancellation is in progress. Wait for the final status. |
| `cancelled` | A queued task was withdrawn, or cancellation evidence supports the observed termination. |
| `succeeded` | The Runner observed a successful process exit. |
| `failed` | Launch or execution failed. Read available output and error details. |
| `unknown` | A recovered process may still be alive. Inspect it before submitting related work. |
| `interrupted` | Recovery ended without a confirmed execution result. Inspect its recorded output and effects. |

After a Runner restart, unstarted queued Jobs become `interrupted`; recovered processes may need inspection. A cancellation racing with a normal code-zero exit can end as `succeeded`.

## Logs, input and cancellation

Foreground output may contain only a tail. A positive `offset` means earlier bytes were omitted from that response; use the `job` tool's `logs` action to request retained bytes in pages. Copy returned cursors unchanged and do not combine a cursor with a new offset or tail mode when the catalog forbids it.

Stored logs have size limits. `output_truncated` can indicate permanently discarded bytes. If your application collects its own logs, ask the administrator to check those as well.

`input` requires `data` or `close_stdin: true`; closing stdin sends end-of-input. `cancel` needs Job-control permission. After a delivery error or timeout, inspect the process before repeating input or cancellation. If its identity cannot be verified, the Runner retains its record and concurrency slot for an administrator to investigate on the host.

Cloud history stores optional recent Job snapshots; output is read from the Runner's retained logs. Live input, cancellation and logs need an online, authorized Runner. Previously recorded cloud metadata can remain visible while it is offline. Recording settings control future uploads independently of local execution and log reads.

## Keep workspace handoff notes

The `context` tool stores explicit handoff notes on the selected Runner. Use `bootstrap` to find available context, `read` or `search` to retrieve it, and `checkpoint` to save a goal, decisions, evidence and next actions. A checkpoint requires write permission and contains the notes you explicitly submit.

On a compatible Worker and Runner, `storage` reports local Context usage and `prune` previews removal of older revisions. Applying a preview requires its plan hash and an explicit `apply: true`; the latest revision is retained. See [Context storage](context-storage.md) before deleting anything. For these storage-management actions, upgrade from 0.1.3 to a verified release that includes them.

## Get help safely

For permission errors, check the client, Runner and workspace settings together. For an offline Runner, restore that machine or explicitly select a different one for new work. For a dependency outage, wait for service recovery and inspect the original operation.

Use [troubleshooting](troubleshooting.md) for recovery. Report the time, operation, versions and redacted error code. Remove credentials, private file contents and sensitive command output before sharing.
