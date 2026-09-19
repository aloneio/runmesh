# Runner transport and local runtime

See [Git isolation and session recovery](git-isolation-and-session-recovery.md) for filesystem-root restrictions and the distinct credential, session-conflict, and availability close semantics.

The required Worker secrets are `RUNNER_TOKEN_PEPPER` and `INTERNAL_CONTROL_SECRET`. `ADMIN_TOKEN` is an optional legacy operator bearer credential; it is separate from the browser administrator password/session. MCP URL secrets and Runner enrollment codes are also separate credentials.

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

After selection, ordinary MCP tools resolve that Runner and do **not** accept `runner_id`. `workspace_id` is required for `inspect`, `read`, `edit`, `shell` and `context`. It is optional for all `job` actions; pass it with `get/logs/cancel/input` to use live Job access without depending on cloud history. `runner_select` is the sole public tool accepting a Runner ID. The private `fs.*`, `exec.*`, `job.*`, Git and environment methods are Worker-to-Runner RPC methods. Clients with the needed scopes and workspace permissions can share workspace IDs and Job metadata on the same Runner.

A selected offline, stale, revoked, or otherwise unavailable Runner never causes fallback to another Runner. Live operations return selected-Runner context and an offline/unavailable error. `job({action:"get"})` without `workspace_id` can return retained cloud metadata while that Runner is offline; an explicit workspace requests live access and requires an online Runner. Deleting a Runner clears its client selections. Explicitly choose a new Runner after inspecting `runner_current`.

## Compact MCP catalog, private RPC, and scope

The exact default `tools/list` catalog is:

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

No `runner_info`, `env_info`, `fs_*`, `exec_*`, `job_*`, or `git_*` names are public MCP tools. The Runner implements the corresponding private RPC methods for the current Worker-to-Runner transport; MCP clients cannot invoke them by name.

- `inspect({action,workspace_id,...})` provides bounded file listing/search/stat, Git inspection and diagnostics.
- `read({workspace_id,path,cursor?,offset?,limit?,consistency?})` maps to private `fs.read`, with UTF-8-safe byte cursors and a 32 KiB public page cap. Paths are workspace-relative. Optional snapshot mode requires a compatible Runner; returned content can contain paths already present in the file.
- `edit({workspace_id,patch,preview?,preview_id?,expected_hash?,expected_hashes?})` previews or applies a patch. Application uses baseline checks and atomic replacement per file; it is not an atomic transaction across all files. Inspect partial or rollback failures before retrying.
- `shell({workspace_id,command,request_id?,wait_ms?,background?,queue?})` creates a persistent Job. `background:true` returns its receipt without waiting for completion; foreground waiting is capped at eight seconds and does not stop a longer-running command. Queued Jobs also return their ID immediately. There is no command blacklist, but current scope, policy and admission checks still apply. Commands run with the Runner account's OS permissions; use a restricted VM/container and a non-administrator account for untrusted repositories.
- `job({action:"list"|"get"|"logs"|"cancel"|"input",...})` maps to the private job RPCs. List/get/logs require read permission; cancel/input require job-control permission. Logs remain bounded and UTF-8-safe.
- `context({action,workspace_id,...})` reads or explicitly records local handoff Contexts. Checkpoint/rebuild and retention require write permission; retention starts with a preview. See [Context storage](context-storage.md) for candidate capabilities and old-Runner behavior.

The Worker resolves effective client/Runner/workspace permissions before forwarding and the Runner repeats local enforcement. Offline snapshot authorization never grants live host access. Permission failures use structured codes such as `insufficient_scope`, `permission_denied` and `readonly_workspace`; inspect the code and recovery fields. `coding:read`, `coding:write`, and `coding:exec` are the independent scopes for read, edit, and shell/job-control operations respectively.

## Runner enrollment and connection

A dashboard-created Runner has a stable safe `runner_id` and a human-facing `display_name`. Dashboard enrollment creates a 43-character code whose verifier is stored in RegistryDO. It can be redeemed once within the validity window shown on the page. Administrators can configure that window; the underlying default is 30 minutes when no override is supplied. Regenerating a code invalidates another unused code for that Runner.

The supported local redemption flow is:

```sh
runmesh enroll \
  --server https://mcp.example.com/runner/enroll \
  --code-stdin
```

Supply the code through a protected prompt instead of argv, for example:

```bash
printf '%s' 'One-time enrollment code: ' >&2
read -r -s RUNMESH_ENROLLMENT_CODE
printf '\n' >&2
printf '%s\n' "$RUNMESH_ENROLLMENT_CODE" | runmesh enroll \
  --server https://mcp.example.com/runner/enroll --code-stdin
unset RUNMESH_ENROLLMENT_CODE
```

The Worker verifies the code, creates a new Runner token, stores only a peppered verifier, and returns the Runner ID, connection URL, and token once. The CLI writes the response into a local Runner profile and does not print/store the one-time code. Centrally managed enrollment starts with zero local workspaces; the Admin Panel delivers approved root paths only in authenticated policy frames.

> **Enrollment behavior:** hosted installation requires a verified release available in the Worker's selected channel and a validated public HTTPS origin. Ordinary HTTPS deployments derive the origin from the URL and matching Host; `RUNMESH_PUBLIC_ORIGIN` is an optional reverse-proxy override. The current 0.1.4 candidate defaults to disabled stable distribution. Development selects its separately verified signed dev prerelease, without falling back to stable; test distribution stays disabled. An unavailable installer exits without attempting enrollment or changing the host. When available, the dashboard supplies a command containing the one-time code. Fresh installation verifies and stages the package before passing that code to `runmesh enroll --code-stdin`. A complete managed installation of the same version instead re-enrolls and restarts its existing service. Keep the complete command private: its one-time code may remain in shell history or process arguments. No long-lived Runner credential is included in that command.

To omit the code and use the hidden prompt on Windows, remove `-NonInteractive` from the copied command and run it in an interactive administrator terminal. A non-interactive invocation cannot provide that prompt.

The established outbound transport is:

```text
Runner → outbound ws/wss /runner/connect?runner_id=...
       Authorization: Bearer <long-lived-runner-token>
```

Production requires `wss://`; loopback `ws://` requires `--insecure-local`. RegistryDO stores credential and connection generations. RunnerDO rejects stale sessions, replaces old sockets, forwards only correlated RPCs, and does not execute local work. Credential rotation/revocation closes the prior socket and makes its old token invalid. It does not terminate local child processes that began before transport revocation.

## Local profile, CLI, and service manifests

A current profile holds the connection URL, Runner ID, token, central-management marker, explicit execution mode, and optional job concurrency. It contains no authoritative workspace roots; those are configured in the Admin Panel and delivered only in authenticated policy frames. The profile is saved under the per-platform locations documented in [deployment.md](deployment.md). Ordinary/user POSIX storage uses private `0700`/`0600` directory/file modes; a dedicated system service intentionally uses the exact `0750`/`0640` shape within its root/service-group boundary so the service account can read the credential, with no group/other write bits. The dashboard and direct enrollment default to `dedicated_user`; `privileged_host` requires a separate explicit choice and visible confirmation. A profile missing required current fields is rejected and must be replaced through enrollment. `status` redacts the token; `doctor --json` returns stable required/optional diagnostics for profile directory/file permissions, service manifest/installed/active state, Host shell, execution mode, local policy revision when available, and tools; missing Python/Docker are warnings. `env` runs bounded local discovery, and `start` uses the profile plus explicit current transport flags for controlled foreground runs.

The service adapter writes marked and content-hashed system manifests and refuses to overwrite or remove an unmarked or changed file. `runmesh install` creates the dedicated Runmesh account/group and Runmesh-owned directories on Linux and macOS, and applies Local Service ACLs to Runmesh-owned paths on Windows. Dedicated-user Linux units use `User=runmesh` and `Group=runmesh`; macOS LaunchDaemons use `UserName=runmesh`; Windows tasks use `NT AUTHORITY\LOCAL SERVICE`. Grant that service identity the minimum Workspace access it needs; installation does not change Workspace ownership or modes. Dashboard and direct CLI enrollment default to `dedicated_user`. Select privileged host execution only after reviewing its warning. The bare hosted script URL retains its privileged-host behavior for compatibility, so use the dashboard command or explicitly append `?execution_mode=dedicated_user`.

For a verified portable artifact, use `runmesh enroll --server ... --code-stdin` followed by `runmesh install`. A one-command installation trusts the HTTPS Worker that serves its script; use the [independent verification path](portable-runner-installation.md) when you need a separately trusted keyring. Dashboard service-action pages only display commands and manifests: they take effect after you run them on the host. Deploying a Worker does not replace or restart an installed Runner.

## Timeouts

The shared protocol contract is:

```text
LOCAL_RUNNER_OPERATION_TIMEOUT_MS = 8000
WORKER_BRIDGE_TIMEOUT_MS          = 12000
```

For `shell`, the local maximum bounds foreground waiting, not process execution. Git subprocesses use it as their execution timeout. The larger bridge budget allows time for transport and scheduling. Longer commands can use `shell({background:true})` followed by the original Job's `get/logs` calls. A timeout is not permission to relaunch an uncertain command.

## Jobs and sync

Runner state is stored under the Runmesh profile/state location documented in [deployment.md](deployment.md), or the explicit `--state-dir`:

```text
runner.json
jobs/<job_id>/meta.json
jobs/<job_id>/stdout.log
jobs/<job_id>/stderr.log
```

Jobs are detached process groups on POSIX and can outlive MCP requests and WebSocket connections. `job({action:"list",workspace_id:...})` reads live local metadata when the Runner is online. Without a workspace, or while offline, list uses retained cloud metadata filtered by current permissions. The offline `source=registry_snapshot` label also covers D1-backed history. These snapshots can be stale or absent; they are not a complete record of local execution.

For `get`, supply the original `job_id` and `workspace_id` to query the online Runner independently of history. Without a workspace, the Worker needs the cloud record to identify and authorize the Job's workspace before querying live state or returning an offline snapshot. A missing record returns `job_history_unavailable`; it does not prove the local Job is absent. Logs, input and cancellation always require live admission. No-record Jobs have no offline cloud history.

Production D1 history keeps at most 500 recent Job metadata records in a 768 KiB row per Runner lifecycle. The SQLite compatibility backend retains active/nonterminal Jobs and up to 1,000 terminal Jobs per Runner. Retention and capacity limits may remove metadata, but an omitted snapshot entry is not itself a request to delete that Job's history. See [history and retention](batched-job-history.md).

A recovered live process is marked `unknown`. Live Job queries, execution admission and eligible recovery-history captures can recheck its process identity; cloud snapshot reads cannot inspect the host. A vanished or fingerprint-mismatched process becomes `interrupted`; a recovered cancellation becomes `cancelled` only when persisted termination-delivery evidence exists. No exit code is fabricated after restart.

## Filesystem, logs, and scope

Workspace roots are configured in the administrator interface and delivered to the Runner in authenticated policy frames. Public workspace metadata omits them. File/Git/patch paths and initial command cwd pass workspace path-policy checks; a shell command can subsequently access anything allowed by the Runner's OS identity. `read` and `job({action:"logs"})` use UTF-8-safe byte cursors. Their content can include paths already present in files or output. Patch errors use bounded codes such as `invalid_patch`, `missing_file`, `target_exists`, `baseline_changed`, `patch_install_failed`, and `patch_rollback_failed` without exposing raw local exceptions.

Private `env.info` retains bounded parallel probes for platform, architecture, hostname, shell, Node/npm/pnpm, Python, Git, Go, rustc/Cargo, and Docker for the Worker/Runner transport. Missing tools return `available: false`. Local stdout/stderr logs are bounded by per-Job and aggregate quotas; quota exhaustion is exposed as `output_truncated`.

The Runner path policy is not a sandbox. No OAuth, AI/model API, Cloudflare Sandbox, Cloudflare Containers, or GitHub Actions runtime is part of the deployed control plane. Use external VM/container isolation for untrusted repositories and commands.

## Security and retention

First administrator setup needs no additional bootstrap token and accepts the first successful setup. Complete it before exposing an uninitialized instance to untrusted visitors. New Runners default to `dedicated_user`; new MCP clients default to `coding:read`. These defaults do not change existing permissions.

Requested tool content is relayed to the authorized client and excluded from durable MCP audit bodies. Each audit store caps metadata at 1,000 calls per Runner and hides entries older than seven days. Bounded cleanup and provider failures can delay physical deletion; backups and backend transitions have separate retention effects. See the [security model](security.md) and [history isolation](quota-resilience.md).

Check the [release readiness page](release-readiness.md) before installing a candidate. Stable distribution follows the reviewed release lifecycle, while development uses its verified prerelease channel. Neither Worker deployment nor release publication upgrades an existing Runner service.

## Shared Runner queue and localized UI

See [queue/UI contract](job-queue-and-localization.md) for capability negotiation, current authorization, bounded fair scheduling, restart interruption and server-side locale rendering. Queue protocol 1 is available from Runner 0.1.3 and requires a compatible Worker.
