# Runner transport and local runtime

The Worker control plane uses `ADMIN_TOKEN`, `RUNNER_TOKEN_PEPPER`, and `INTERNAL_CONTROL_SECRET` as separate server-side credentials. MCP URL secrets, browser administrator credentials, and Runner enrollment codes are separate lanes.

## MCP URL authentication and Runner routing

The public MCP endpoint is per-client and path-authenticated:

```text
https://mcp.example.com/<256-bit-base64url-secret>/mcp
```

The Worker hashes the path secret, verifies it against RegistryDO, obtains only client ID/label/scopes/version, and internally rewrites the request to the SDK's exact `/mcp` route without consuming the MCP body. Extra Authorization headers are ignored. Direct `/mcp`, malformed, wrong, rotated, and revoked paths return uniform `404`.

Each verified MCP client has a persisted `active_runner_id` and selection timestamp. This routing state survives client rename and secret rotation. The routing tools are:

```text
runner_list()                                    # safe Runner ID/display_name/state data
runner_current()                                 # this client's current selection
runner_select({ runner_id })                     # first selection
runner_select({ runner_id, confirm_switch: true }) # switch an existing selection
```

`runner_list` returns safe `runner_id`, `display_name`, state, availability, and timestamp data. `runner_current` reports no selection as null and reports a revoked selection as unavailable. Deleting a Runner clears any client selection that referenced it. The first selection is direct; changing it requires `confirm_switch: true`. For an unselected client only, the first ordinary tool automatically and persistently selects the Runner if exactly one registered Runner exists. With zero or multiple registered Runners, ordinary tools fail with guidance to call `runner_list` and `runner_select`.

After selection, ordinary MCP tools resolve that Runner and do **not** accept `runner_id`. `workspace_id` remains mandatory for `read`, `edit`, and `shell`; it is optional only for the selected Runner's `job({action:"list"})`. `runner_select` is the sole public tool that accepts a Runner ID. The Runner's legacy `fs.*`, `exec.*`, `job.*`, Git, and environment names are private Worker-to-Runner RPC methods, not public MCP aliases. This removes per-call routing ambiguity but does not isolate clients: clients in the same single-admin instance that select the same Runner and possess the needed scope share workspace IDs and Registry job visibility.

A selected offline, stale, revoked, or otherwise unavailable Runner never causes fallback to another Runner. Live operations return selected-Runner context and an offline/unavailable error. `job({action:"get"})` may use a bounded Registry snapshot when the same selected Runner is offline; it still does not query another Runner. Deleting a Runner clears its client selections. Explicitly choose a new Runner after inspecting `runner_current`.

## Compact MCP catalog, private RPC, and scope

The exact default `tools/list` catalog is:

```text
runner_list
runner_current
runner_select
workspace_list
read
edit
shell
job
```

No `runner_info`, `env_info`, `fs_*`, `exec_*`, `job_*`, or `git_*` names are public MCP tools. The Runner retains those legacy RPC implementations for Worker-to-Runner transport compatibility only; MCP clients cannot invoke them by name.

- `read({workspace_id,path,cursor?,offset?,limit?})` maps to private `fs.read`, with UTF-8-safe byte cursors and a 32 KiB public page cap. It accepts only workspace-relative paths and returns no host root.
- `edit({workspace_id,patch,expected_hash?,expected_hashes?})` maps to transactional private `fs.apply_patch`.
- `shell({workspace_id,command,wait_ms?,background?})` maps to persistent jobs. `background:true` returns immediately; a foreground call waits no longer than `wait_ms` (maximum 8 seconds) and returns `job_id`/status when unfinished. Shell permission is the only command gate—there is no blacklist. It is not a sandbox: commands have the Runner account's OS permissions, so use a non-administrator/root Runner inside a restricted VM/container for untrusted repositories.
- `job({action:"list"|"get"|"logs"|"cancel"|"input",...})` maps to the private job RPCs. List/get/logs require read permission; cancel/input require job-control permission. Logs remain bounded and UTF-8-safe.

The Worker resolves effective client/Runner/workspace permissions before forwarding and the Runner repeats local enforcement. Offline snapshot authorization never grants live host access. Permission failures are structured `permission_denied` results. `coding:read`, `coding:write`, and `coding:exec` remain the requested authorization scopes for read, edit, and shell/job-control operations respectively.

## Runner enrollment and connection

A dashboard-created Runner has a stable safe `runner_id` and a human-facing `display_name`. Dashboard enrollment creates a 43-character code whose verifier is stored in RegistryDO. It expires after 30 minutes, can be redeemed once, and is removed after use/expiry. Regenerating an enrollment code deletes another unused code for that Runner.

The supported local redemption flow is:

```sh
coding-runner enroll \
  --server https://mcp.example.com/runner/enroll \
  --code '<one-time-code>'
```

The Worker verifies the code, creates a new Runner token, stores only a peppered verifier, and returns the Runner ID, connection URL, and token once. The CLI writes the response into a local Runner profile and does not print/store the one-time code. Centrally managed enrollment starts with zero local workspaces; the Admin Panel delivers approved root paths only in authenticated policy frames.

> **Enrollment behavior:** hosted `/runner/install.sh` and `/runner/install.ps1` remain fail-closed until the exact fixed signed preview release is explicitly enabled. When enabled, the dashboard displays a code-free installer command. The installer verifies fixed release assets and stages both Runner entry points before prompting locally for the single-use code and forwarding it only through `--code-stdin`; when disabled, the dashboard shows the independently verified portable-artifact flow. No generated command contains the code, token, Runner ID, MCP URL, Workspace root, arbitrary package spec, or moving release URL.

The established outbound transport is:

```text
Runner → outbound ws/wss /runner/connect?runner_id=...
       Authorization: Bearer <long-lived-runner-token>
```

Production requires `wss://`; loopback `ws://` requires `--insecure-local`. RegistryDO stores credential and connection generations. RunnerDO rejects stale sessions, replaces old sockets, forwards only correlated RPCs, and does not execute local work. Credential rotation/revocation closes the prior socket and makes its old token invalid. It does not terminate local child processes that began before transport revocation.

## Local profile, CLI, and service manifests

A profile holds the connection URL, Runner ID, token, workspace records, optional job concurrency, and optional execution mode. It is saved under the per-platform locations documented in [deployment.md](deployment.md); POSIX storage is created with private `0700`/`0600` permissions. New profiles default to `dedicated_user`; profiles created before this field retain their legacy privileged service layout. `status` redacts the token; `doctor --json` returns stable required/optional diagnostics for profile directory/file permissions, service manifest/installed/active state, Host shell, execution mode, local policy revision when available, and tools; missing Python/Docker are warnings. `workspace list|add|remove` updates local workspace records; and `env` runs bounded local discovery. `start` defaults to the profile but continues to support explicit legacy transport/workspace flags.

The service adapter writes marked and content-hashed system manifests and refuses to overwrite/remove an unmarked or changed file. `coding-runner install` invokes the Runmesh service provisioner, which creates the dedicated Runmesh account/group and Runmesh-owned directories on Linux and macOS, and applies Local Service ACLs to Runmesh-owned install/config/state/log/profile paths on Windows. Dedicated-user Linux units explicitly set `User=runmesh` and `Group=runmesh`; macOS LaunchDaemons set `UserName=runmesh`; Windows tasks use `NT AUTHORITY\LOCAL SERVICE` at least privilege. The provisioner never changes Workspace ownership or modes; operators grant the service identity only the minimum required Workspace access. `privileged_host` root/SYSTEM execution is available only with `--execution-mode privileged_host --confirm-privileged-host`; legacy profiles remain compatible without a silent migration. Hosted bootstrap is implemented as a fixed signed-preview mechanism but remains disabled by default because this repository does not assert that the `v0.1.0-dev.2` release exists. Once an operator publishes and independently verifies that exact release, the Worker may be explicitly acknowledged with `RUNMESH_SIGNED_RELEASE_AVAILABLE=0.1.0-dev.2`; until then use a manually verified portable artifact and `coding-runner enroll --code-stdin` followed by `coding-runner install`. The one-command Worker script is the bootstrap trust root; use an independent keyring/offline path for high assurance.

## Timeouts

The shared protocol contract is:

```text
LOCAL_RUNNER_OPERATION_TIMEOUT_MS = 8000
WORKER_BRIDGE_TIMEOUT_MS          = 12000
```

`shell` foreground execution and Git use the local maximum. The Worker bridge reserves four seconds for reply transport and scheduling. Longer commands use `shell({background:true})` and the compact `job` tool.

## Jobs and sync

Runner state is stored under the Runmesh profile/state location documented in [deployment.md](deployment.md), or the explicit `--state-dir`:

```text
runner.json
jobs/<job_id>/meta.json
jobs/<job_id>/stdout.log
jobs/<job_id>/stderr.log
```

Jobs are detached process groups on POSIX and outlive MCP requests and WebSocket connections. `job({action:"list"})` reads bounded Registry snapshots for the selected Runner while it is offline. Runner sync upserts current/recent jobs; a bounded snapshot omission never deletes historical job data. Registry retains active/nonterminal jobs and up to 1,000 terminal jobs per Runner.

A recovered live process is marked `unknown`. `job({action:"get"})`, `job({action:"list"})`, and sync trigger reconciliation: a vanished or fingerprint-mismatched process becomes `interrupted`; a recovered cancellation becomes `cancelled` only when persisted termination-delivery evidence exists. No exit code is fabricated after restart.

## Filesystem, logs, and scope

Workspace roots are local configuration only and never cross the wire. All filesystem, Git, cwd, and patch paths pass the canonical workspace PathPolicy. Compact `read` and `job({action:"logs"})` use UTF-8-safe byte cursors. Patch errors are stable root-free codes such as `invalid_patch`, `missing_file`, `target_exists`, `baseline_changed`, hunk errors, `patch_install_failed`, and `patch_rollback_failed`.

Private `env.info` retains bounded parallel probes for platform, architecture, hostname, shell, Node/npm/pnpm, Python, Git, Go, rustc/Cargo, and Docker for the Worker/Runner transport. Missing tools return `available: false`. Local stdout/stderr logs are bounded by per-Job and aggregate quotas; quota exhaustion is exposed as `output_truncated`.

The Runner path policy is not a sandbox. No OAuth, AI/model API, Cloudflare Sandbox, Cloudflare Containers, or GitHub Actions runtime is part of the deployed control plane. Use external VM/container isolation for untrusted repositories and commands.

## Evidence boundary

Local tests cover Worker/Runner protocol, auth UI, client URL lifecycle, sticky selection, filesystem and job pagination, disconnect/reconnect, cross-client job discovery, patch/Git safety, profile/service behavior, and bounded environment discovery. They do not prove deployed Cloudflare migrations, account quotas, infrastructure log redaction, automatic installation, host lifecycle execution, or external MCP client compatibility.
