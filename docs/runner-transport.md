# Runner transport deployment and local runtime semantics

The Worker uses four production Cloudflare Worker secrets; do not place their values in `wrangler.jsonc` or source control:

```sh
cd apps/worker
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put RUNNER_TOKEN_PEPPER
npx wrangler secret put INTERNAL_CONTROL_SECRET
npx wrangler secret put MCP_OWNER_PASSWORD
```

`MCP_STATIC_TOKEN` is optional and strictly local-test/development-only. Leave it unset in production; local tests inject it through temporary bindings rather than provisioning a production secret.

## Authenticated MCP endpoint

`POST /mcp` is a stateless MCP SDK v2 endpoint built with `agents@0.21.0`,
`@modelcontextprotocol/server@2.0.0`, and `createMcpHandler` from
`agents/mcp/server`. A fresh `McpServer` is created for every request. The
handler retains the SDK default stateless legacy-2025 compatibility lane;
MCP Tasks are intentionally deferred. Long-running process work is exposed by
the existing `exec_start` → `job_get` / `job_logs` Job API, so an MCP request
may close safely after `exec_start`.

Production authentication is Cloudflare's official `OAuthProvider` with OAuth
2.1 authorization-code + S256 PKCE, OAuth metadata, CIMD (where supported),
and DCR fallback. Bind a real KV namespace named `OAUTH_KV` before deployment:

```jsonc
"kv_namespaces": [{ "binding": "OAUTH_KV", "id": "YOUR_KV_NAMESPACE_ID" }]
```

The checked-in `REPLACE_WITH_OAUTH_KV_NAMESPACE_ID` is a placeholder only; it
must be replaced by infrastructure configuration, not a paid service created
by this project. `/authorize` presents an explicit owner-password and consent
form and grants only requested supported scopes (`coding:read`, `coding:write`,
`coding:exec`); it never auto-approves. Scope enforcement occurs in every MCP
tool. `MCP_STATIC_TOKEN` activates a fully scoped static bearer path solely
when explicitly configured for local tests/dev; when unset, OAuthProvider
rejects it and no alternate route exists.

The exact MCP catalog is `runner_list`, `runner_info`, `workspace_list`,
`env_info`, `fs_read`, `fs_list`, `fs_search`, `fs_apply_patch`, `exec_start`,
`exec_run`, `job_get`, `job_logs`, `job_cancel`, `job_input`, `git_status`, and
`git_diff`. Catalog and job/workspace metadata use RegistryDO when available;
live filesystem, process, and log operations bridge only to a connected
RunnerDO and return structured `runner_offline` errors otherwise. Responses
are bounded, include `structuredContent`, give recovery hints for errors, and
exclude tokens and workspace roots.

`npm run test:e2e` is hermetic: it allocates a free loopback port, uses a temporary
Wrangler `--persist-to` directory, uses a temporary Runner `--state-dir`, and
cleans both up. The suite includes a local test-only Runner control file: writing the configured
`--disconnect-control-file` closes only the WebSocket, leaves JobManager/child
processes alive, and proves the Worker observes `runner_offline` during the
gap, then proves automatic reconnect/sync restores the same Runner connection
and publishes final local job metadata/logs. E2E also pages multibyte stdout to
EOF and reads stderr.

Automated local tests cover the full DCR → S256 PKCE authorization GET → CSRF
cookie/form → wrong-password/denied-consent → approved redirect/code → token
exchange flow, independently issued read/exec OAuth tokens, and scope
enforcement at MCP tools. They also cover metadata endpoint publication and the
static-token provider seam (including rejection when unset), MCP
schema/path/error/annotation correctness, runner persistence/recovery semantics,
UTF-8 pagination, and bounded concurrency. CIMD is enabled and provider metadata
is published, but no external Internet CIMD document is fetched.

`ADMIN_TOKEN` protects `POST /admin/runners`, `POST /admin/runners/:runner_id/rotate`, and `POST /admin/runners/:runner_id/revoke`. Enrollment accepts a caller-supplied 32–512-character token or generates a random 256-bit token. The plaintext is returned in that successful enrollment/rotation response only; RegistryDO stores only an HMAC-SHA-256 verifier keyed by `RUNNER_TOKEN_PEPPER`.

Start a runner with TLS by default and use the environment variable rather than putting the token on a command line:

```sh
CODING_RUNNER_TOKEN='enrollment token' coding-runner start \
  --server wss://worker.example/ --runner-id runner-1 \
  --workspace project=/srv/project;writable;noshell
```

`ws://` requires `--insecure-local` and is accepted only for loopback hosts. Registry Durable Object endpoints accept only private request HMACs produced by Worker/RunnerDO using `INTERNAL_CONTROL_SECRET`; they are not a public API.

## Local workspace authorization

Workspaces are local allowlist entries, not request-supplied roots. Each is canonicalized with `realpath` at runner startup and must be a directory. The command-line form remains `id=path`, with optional semicolon suffixes: `readonly`/`writable` and `shell`/`noshell`; defaults are `readonly;noshell`.

Every `fs.read`, `fs.list`, `fs.search`, `fs.apply_patch` (with deprecated `fs.patch` alias) target, Git path, and process `cwd` is resolved by one path-policy service. It accepts relative paths only and rejects absolute paths, NUL bytes, `..` segments, unknown workspace IDs, symlinks/junctions in the target ancestry, and paths whose canonical location escapes the configured root. Reads use only their requested range; recursive search bounds directories, depth, per-file and aggregate bytes, and results, skips common generated/huge directories, and does not follow symlinks. Writes also reject readonly workspaces and write-through symlinks. `fs.apply_patch` accepts the standard `*** Begin Patch` envelope with Add/Update/Delete/Move operations, exact-once hunks, optional expected SHA-256 baselines, and transactional staging/rollback; it preserves UTF-8 BOM, newline style, and file mode. Responses contain bounded hashes/status metadata rather than complete file content. `git.status` returns bounded porcelain-v2-derived entries, while `git.diff` supports staged/unstaged diffs and an optional workspace-relative path with a byte cap.

Shell invocation is off unless both the workspace allows it and `exec.start`/`exec.run` explicitly requests it. Non-shell process calls use an executable plus argument vector.

## Persistent jobs and output

The runner advertises and enforces one concurrent local job by default; operators may set `--max-concurrent-jobs 1..64` when their host capacity supports it.

The Node runner persists its state under `~/.remote-coding-runner/state/` by
default. Operators and tests may select a separate local directory with
`--state-dir <path>` (this does not expose it through MCP):

```
runner.json
jobs/<job_id>/meta.json
jobs/<job_id>/stdout.log
jobs/<job_id>/stderr.log
```

For local transport recovery testing, write the configured
`--disconnect-control-file <path>` (or use `--disconnect-after-ms <milliseconds>`).
Both controls close only the runner WebSocket and preserve JobManager plus its
child processes; they are not exposed by Worker/MCP and are not a job
cancellation mechanism.

Metadata writes are serialized per job as rename-based atomic writes, so a late running-state persistence cannot overwrite terminal metadata. On Linux the metadata also stores `/proc/<pid>/stat` starttime when available. Recovery makes one liveness observation: a matching live process becomes `unknown`, while a missing or fingerprint-mismatched process becomes `interrupted`; recovery never guesses completion. A recovered `unknown` job can be cancelled only when its saved PID/start fingerprint still matches the current process. Windows uses `taskkill /PID <pid> /T /F` as a best-effort process-tree mechanism; protected or independently escaped descendants can resist termination.

Jobs are detached process groups on POSIX, so their lifetime is not tied to an MCP/RPC request or WebSocket connection. Stdout/stderr descriptors point directly to append-only files at spawn time, and terminal metadata is committed only after child close and a best-effort log durability barrier. Cancellation records `cancelling`, sends TERM to the process group, then KILL after a short grace period if needed. A `cancelled` outcome means a termination was actually delivered and the process did not report a normal zero exit. `job.input` writes bounded UTF-8 stdin only to a local running child; `{ close_stdin: true }` sends EOF. `job.logs` is UTF-8-safe and bounded to 64 KiB for a complete RPC response; its byte cursors are aligned to code-point boundaries and callers must paginate. The on-disk stdout/stderr logs are intentionally complete and unbounded by default: this is a disk-exhaustion risk that operators must monitor (there is no log rotation/max-bytes policy in this milestone). `exec.run` is a convenience wrapper only and enforces a wait cap of 8 seconds, strictly below the Worker bridge deadline.

## Transport boundary

`evictDurableObject(stub)` is exposed by the Worker Vitest pool, but its helper
requires a running object and waits for active WebSocket sessions to drain. The
automated test records that documented idle-object behavior rather than claiming
a hibernatable live-socket eviction or deployed restart. Transport tests cover
close/error waiter rejection; deployed Cloudflare restart, production KV,
Internet-reachable CIMD, and Free Plan/account evidence remain unverified and
require operator-owned infrastructure.

The Runner dispatches correlated Worker `rpc.request` frames locally for `workspace.list`, `env.info`, filesystem methods, `git.status`, `git.diff`, `exec.start`, `exec.run`, and `job.*`; `echo` and `runner.info` remain available. Tokens are never included in RPC results/errors. Workspace metadata and active/recent job status sync upstream without absolute roots. Local disk remains authoritative during disconnects. Job started/status/completion notifications are persisted upstream immediately (output frames never include full logs), and periodic monotonic `runner.sync` snapshots repair the remote view. Registry rejects stale/duplicate sync sequences and duplicate IDs. Rotation/revocation destroys the stored verifier, invalidates existing credentials, and asks RunnerDO to close old sockets. RunnerDO rechecks current session state before forwarding an internal RPC, caps bridge requests, and fails all affected waiters immediately on socket error/close/invalid frames. Waiters are memory-scoped only because the awaiting DO fetch pins the active request; a deploy/restart can still fail that HTTP request, so callers must retry only safe/idempotent operations.
