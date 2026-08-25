# Runner transport and local runtime

The Worker control plane uses only `ADMIN_TOKEN`, `RUNNER_TOKEN_PEPPER`, and `INTERNAL_CONTROL_SECRET` secrets. MCP client URL secrets and the browser admin password are separate credentials and are not used for Runner transport.

## MCP URL authentication

The public MCP endpoint is per-client and path-authenticated:

```text
https://mcp.aloneio.com/<256-bit-base64url-secret>/mcp
```

The Worker hashes the path secret, verifies it against RegistryDO, obtains only `client_id`, label, scopes, and secret version, and internally rewrites the request to the SDK's exact `/mcp` route without consuming the MCP body. Extra Authorization headers are ignored. Direct `/mcp`, malformed, wrong, rotated, and revoked paths return uniform `404`.

The admin UI creates, renames, rotates, and revokes clients. A raw client URL is shown once. RegistryDO stores only a verifier. Scopes are `coding:read`, `coding:write`, and `coding:exec`; each MCP tool enforces its required scope.

## Runner connection

Runner WebSocket authentication remains independent:

```text
Runner → outbound ws/wss /runner/connect?runner_id=...
       Authorization: Bearer <enrollment-token>
```

Production requires `wss://`; loopback `ws://` requires `--insecure-local`. RegistryDO stores a peppered token verifier and increments credential/connection epochs on rotation/revocation. RunnerDO rejects stale sessions, replaces old sockets, forwards only correlated RPCs, and does not execute local work.

## Timeouts

The shared protocol contract is:

```text
LOCAL_RUNNER_OPERATION_TIMEOUT_MS = 8000
WORKER_BRIDGE_TIMEOUT_MS          = 12000
```

`exec_run` and Git use the local maximum. The Worker bridge reserves four seconds for reply transport and scheduling. Long commands use `exec_start` and persistent Job APIs.

## Jobs and sync

Runner state is stored under `~/.remote-coding-runner/state/` (or `--state-dir`):

```text
runner.json
jobs/<job_id>/meta.json
jobs/<job_id>/stdout.log
jobs/<job_id>/stderr.log
```

Jobs are detached process groups on POSIX and outlive MCP requests and WebSocket connections. `job_list` exposes bounded metadata and works from Registry snapshots while offline. Runner sync upserts current/recent jobs but does not delete historical jobs merely because a bounded snapshot omitted them. Registry retains active/nonterminal jobs and up to 1,000 terminal jobs per Runner.

A recovered live process is marked `unknown`. `job_get`, `job_list`, and sync trigger reconciliation: a vanished or fingerprint-mismatched process becomes `interrupted`; a recovered cancellation becomes `cancelled` only when persisted termination-delivery evidence exists. No exit code is fabricated after restart.

## Filesystem and logs

Workspace roots are local configuration only and never cross the wire. All filesystem, Git, cwd, and patch paths pass the canonical workspace PathPolicy. `fs_read` and `job_logs` use UTF-8-safe byte cursors. Patch errors are returned as stable root-free codes such as `invalid_patch`, `missing_file`, `target_exists`, `baseline_changed`, hunk errors, `patch_install_failed`, and `patch_rollback_failed`.

`env_info` caches bounded parallel probes for platform, architecture, hostname, shell, Node/npm/pnpm, Python, Git, Go, rustc/Cargo, and Docker. Missing tools return `available: false`. Complete on-disk logs remain unbounded by default and require disk monitoring.

## Evidence boundary

Local tests cover the Worker/Runner protocol, auth UI, client URL lifecycle, filesystem and job pagination, real disconnect/reconnect, cross-client offline job discovery, patch/Git safety, and bounded environment discovery. Deployed Cloudflare restarts, account quotas, infrastructure log redaction, and real external MCP client compatibility remain operator-owned acceptance work.
