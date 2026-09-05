# Troubleshooting

First identify whether the issue is the admin UI, a Runner connection, or an MCP client. Never paste passwords, MCP URLs, enrollment codes, or Runner tokens into a report.

## Admin page is unavailable

- Verify the Worker HTTPS origin and that `RUNMESH_PUBLIC_ORIGIN` matches it.
- Complete first setup when the page reports an uninitialized deployment.
- After repeated failed logins, wait for the throttle window to end.
- Clear the site's old cookies and sign in again; changing the administrator password invalidates old sessions.

## Runner stays offline

1. Check that the enrollment code is still valid and generate a new one if needed.
2. Check the service on the target machine.
3. Confirm outbound `wss://` access to the Worker and accurate system time.
4. Run `runmesh doctor --json` on the Runner host.
5. After rotation or revocation, enroll again; old credentials cannot be reused.

Runmesh does not require a public inbound port. Do not expose the Runner or add SSH solely to troubleshoot it.

## Installer fails

Use an elevated shell. On Windows use an elevated PowerShell. If the hosted installer is unavailable, independently verify the artifact and follow the [portable installation procedure](portable-runner-installation.md). Do not substitute an npm package, branch build, or third-party mirror. After installation run `runmesh --version` and `runmesh doctor --json`.

## MCP client cannot connect

Paste the complete URL ending in `/mcp` with no line breaks, quotes, or extra spaces. Do not add a Bearer token or rewrite the path. Confirm the client supports Streamable HTTP, the client has not been revoked, and you are using the newest URL after rotation.

## Missing workspace or permission denied

Client, Runner, and workspace policies must all allow the operation. Ask the administrator to verify that the workspace policy was acknowledged, the client scopes are sufficient, and the client is restricted to the intended Runner. Refresh with `runner_current` and `workspace_list`.

Do not bypass policy with absolute paths, symlinks, or `shell`.

## Job failed, hangs, or has no logs

Use `job` `list`, `get`, and paginated `logs`. Browser or MCP disconnects do not stop persistent jobs. Offline Runners expose retained metadata, while live output and input require reconnection. Investigate the host when `output_truncated` is reported. A cancellation request does not guarantee that every external child process exits immediately.

## If the issue remains

Record the time, page or tool, a redacted error code, the Runner display name, and non-sensitive `doctor --json` checks. Do not share passwords, complete URLs, codes, tokens, real workspace paths, file contents, or command output. Use the private process in [SECURITY.md](../.github/SECURITY.md) for security issues.
