# User guide

Runmesh lets an MCP-compatible AI client use computers and workspaces approved by an administrator. This guide is for everyday users; it does not require Cloudflare, Node.js, or source-code knowledge.

## What you need

- The complete MCP URL supplied by your administrator;
- An MCP client that supports Streamable HTTP;
- At least one approved Runner and workspace.

The MCP URL is a secret credential shown only when a client is created or rotated. Treat it like a password.

## Connect your client

Add the complete URL in your client's MCP settings:

```text
https://your-host.example/<generated-secret>/mcp
```

Do not edit the path or add a Bearer token. If the client cannot connect, check that the URL has no missing characters, line breaks, or extra spaces, then contact the administrator.

## First use

1. Call `runner_list` to see available machines.
2. If there is more than one, call `runner_select`; changing a selection requires `confirm_switch: true`.
3. Call `runner_current` to confirm the selected machine.
4. Call `workspace_list` to see workspaces and permissions.
5. Start with `read` or `inspect` before using `edit`, `shell`, or `job`.

Workspace names are administrator-defined identifiers. The actual host path is never returned through MCP.

## Inspect Git history

`inspect` publishes separate input branches for each `action`. Use `git_log` with `path` to list commits, `git_show` with `path` and a required `revision` commit identifier to read a historical file, and `git_blame` with `path` and optional `start_line` / `end_line` to inspect line attribution. `revision` belongs only to `git_show`; do not send it with `git_blame`. This does not add revision-specific blame support. Search options and search snapshot cursors belong only to `search`.

Clients that cache tool definitions must refresh the Runmesh tool catalog after a Worker update. A cached broad schema is not permission to send fields from another action; the server still validates every call.

## Edit files

Use `edit` only after reading the target. Runmesh checks the baseline before applying a change. If someone changed the file after you read it, the edit is rejected so you can reload instead of overwriting work.

## Commands and long-running jobs

`shell` runs as the Runner service account. It is a host capability, not a sandbox; commands can reach anything that account can reach.

Use `job` for long-running work:

- `list` shows jobs;
- `get` shows a job status;
- `logs` reads paginated output;
- `input` sends input;
- `cancel` requests cancellation.

Closing the browser, ending an MCP request, or a short Runner disconnect does not stop a persistent job. Logs are bounded; inspect the host directly when `output_truncated` is reported.

## Common messages

- **No Runner available:** ask the administrator to check the machine, service, and client permissions.
- **Permission denied:** the client, Runner, and workspace policies must all allow the operation.
- **Runner offline:** Runmesh never silently switches machines. Restore the selected Runner or explicitly select another one.
- **Credential expired:** the administrator must rotate the MCP client and send a new URL.

Never run untrusted code on a high-privilege Runner. Do not paste MCP URLs, enrollment codes, or Runner credentials into chats, screenshots, tickets, shell history, or source control.
