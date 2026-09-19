# Connect and operate a Runner

A Runner connects outbound to the Worker and executes authorized operations on its host. Required Worker secrets are `RUNNER_TOKEN_PEPPER` and `INTERNAL_CONTROL_SECRET`; optional legacy `ADMIN_TOKEN` protects a separate operator bearer interface. Browser sessions, MCP URL secrets and enrollment codes each have their own purpose.

## Authenticate and select a Runner

New MCP clients start with `coding:read`. Grant additional scopes and workspace permissions as needed for editing or execution. Each client uses its own endpoint:

```text
https://mcp.example.com/<256-bit-base64url-secret>/mcp
```

The Worker verifies the path secret against RegistryDO before routing to the MCP SDK. Authentication uses that path credential; extra Authorization headers are ignored. Direct `/mcp` and invalid, rotated or revoked secret paths return `404`.

```text
runner_list()                                    # IDs, names and last-known states
runner_current()                                 # this client's current selection
runner_select({ runner_id })                     # first selection
runner_select({ runner_id, confirm_switch: true }) # switch an existing selection
```

Selection is persisted per client and survives a rename or secret rotation. An unselected client's ordinary request can select the sole registered Runner automatically. With zero or multiple Runners, select one explicitly. A selected unavailable Runner returns its own error; inspect `runner_current` before choosing another. Deleting a Runner clears selections referencing it.

## Use the public catalog

```text
runner_list
runner_current
runner_select
workspace_list
inspect
read
edit
shell
job
context
```

`runner_select` accepts the Runner ID. Workspace operations use that selection: `inspect`, `read`, `edit`, `shell` and `context` require `workspace_id`. All `job` actions accept it optionally; include it with get/logs/cancel/input for live access independent of cloud history. The private `fs.*`, `exec.*`, `job.*` and Git methods belong to the Worker/Runner protocol.

- **inspect:** bounded file listing/search/stat, Git inspection and diagnostics.
- **read:** UTF-8-safe pages with a 32 KiB public data cap; compatible Runners support optional snapshots.
- **edit:** patch preview or apply with baseline checks and per-file atomic replacement. Inspect partial/rollback failures before another apply.
- **shell:** a persistent Job. Background and queued calls return a Job ID immediately; foreground waits up to eight seconds while longer commands can continue. Save the Job/workspace IDs and follow them with `job`.
- **job:** metadata and logs require read scope/permission; input and cancellation require exec scope plus job control.
- **context:** local handoff records; checkpoint/rebuild and retention require write scope/permission. [Retention](context-storage.md) starts with a preview.

Commands use the Runner's OS identity and have no command blacklist. Workspace policy controls initial cwd and application access, while OS permissions govern the command's further reach. Use a dedicated account and restricted VM/container for untrusted work. See the [permission model](permission-model.md).

## Enroll and establish a connection

Create a Runner in the administrator interface and generate its 43-character single-use enrollment code. Use the displayed validity window; the underlying default is 30 minutes when no override is supplied. Regenerating replaces an unused prior code.

The local CLI supports protected standard-input enrollment:

```bash
printf '%s' 'One-time enrollment code: ' >&2
read -r -s RUNMESH_ENROLLMENT_CODE
printf '\n' >&2
printf '%s\n' "$RUNMESH_ENROLLMENT_CODE" | runmesh enroll \
  --server https://mcp.example.com/runner/enroll --code-stdin
unset RUNMESH_ENROLLMENT_CODE
```

Successful redemption returns the Runner ID, connection URL and token. The CLI writes the token to its private profile. Centrally managed enrollment starts with zero local workspaces; approved roots arrive through authenticated policy frames.

```text
Runner → outbound wss /runner/connect?runner_id=...
       Authorization: Bearer <long-lived-runner-token>
```

Production uses `wss://`; loopback `ws://` requires `--insecure-local`. Each session is bound to credential and connection generations. Rotation/revocation closes the prior socket. Existing child processes require explicit cancellation or host control if they should stop. See [session recovery](git-isolation-and-session-recovery.md) for close-code handling.

## Install or update the service

Hosted installation requires a verified release in the selected channel and a valid public HTTPS origin. Ordinary HTTPS deployments derive the origin from a matching URL and Host; `RUNMESH_PUBLIC_ORIGIN` is an optional override. The **0.1.4 candidate** keeps stable distribution closed; development selects verified signed prereleases and test distribution stays disabled.

An available dashboard command carries a one-time code. Fresh installation verifies and stages the package, then enrolls through standard input. A complete managed installation of the same version instead re-enrolls and restarts its service. Keep the copied command private because its code can enter shell history and process arguments. For the hidden Windows prompt, remove `-NonInteractive` and run in an interactive administrator terminal.

Prefer the dashboard command with its explicit execution mode. Bare hosted script URLs retain privileged-host behavior for compatibility; explicitly append `?execution_mode=dedicated_user` for that mode. A portable installation uses a [verified artifact](portable-runner-installation.md), CLI enrollment and `runmesh install`.

The current profile records central management, execution mode, connection/token and optional Job concurrency. Roots are managed in the control plane. POSIX user profiles use `0700`/`0600`; dedicated services use `0750`/`0640` within their root/service-group boundary. See [deployment](deployment.md) for locations.

`runmesh install` creates Runmesh-owned service identities/directories and Windows ACLs. Dedicated identities are `runmesh` on Linux/macOS and `NT AUTHORITY\LOCAL SERVICE` on Windows. Grant workspace access to that identity separately. `privileged_host` runs as root/SYSTEM and requires explicit confirmation. Service manifests are marked and hashed; changed or unmarked files require operator inspection before replacement/removal.

Use `status` for token-redacted status and `doctor --json` for profile/service diagnostics. Python/Docker absence is optional; inspect Windows ACLs separately. `env` reports bounded local discovery. The administrator's service-action page supplies commands for you to run on the host. Worker deployment and Runner service installation are separate actions; keep independent host access during a restart.

## Follow Jobs and recover state

Runner state uses the profile/state location from [deployment](deployment.md), or explicit `--state-dir`:

```text
runner.json
jobs/<job_id>/meta.json
jobs/<job_id>/stdout.log
jobs/<job_id>/stderr.log
```

POSIX Jobs use detached process groups and can outlive MCP requests or WebSocket connections. The foreground wait maximum is 8,000 ms; the bridge deadline is 12,000 ms. Preserve the original identifiers after a timeout and inspect the Job before relaunching work.

A workspace-scoped list reads live metadata while online. Other list requests use retained cloud metadata; get with an explicit workspace always requests live access. Get without a workspace first needs a cloud record to identify/authorize the Job's workspace. Missing history returns `job_history_unavailable`; query live with the original workspace when the Runner is available. Logs/input/cancel require live admission. See the [protocol source table](protocol.md#select-the-job-data-source).

Production D1 retains at most 500 recent records in a 768 KiB row per Runner lifecycle. SQLite compatibility retains active/nonterminal Jobs and up to 1,000 terminal Jobs. Uploads merge recent metadata; count, byte and age limits determine retention. See [history settings](batched-job-history.md).

Recovered live processes may be `unknown`. Live queries, execution admission and eligible recovery-history captures inspect process identity. A vanished or mismatched process becomes `interrupted`; recovered cancellation becomes `cancelled` when persisted termination-delivery evidence exists. Unobserved exit codes remain unavailable.

## Read host data safely

File/Git/patch paths and initial cwd pass workspace path-policy checks. Roots are carried in authenticated policy frames and omitted from public metadata; requested files and output can contain their own paths. File/log pages use UTF-8-safe cursors, and retained output quotas are reported through `output_truncated`.

Private `env.info` reports bounded host/tool discovery; public diagnostics project safe fields. Use [capability diagnostics](capability-contracts.md) for support and [Git access](git-isolation-and-session-recovery.md) for executable trust.

Requested content is relayed to the authorized client. Optional audit stores metadata with a 1,000-record cap per Runner and a seven-day read window; cleanup and backups have separate physical retention. See the [security model](security.md). Queue protocol 1 is available from Runner 0.1.3; see [shared Runner use](job-queue-and-localization.md).
