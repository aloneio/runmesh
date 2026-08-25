# Remote Coding Runtime

A model-neutral, client-neutral remote coding runtime with one stable Cloudflare control plane and outbound-only local Runners.

```text
ChatGPT / Claude / Cursor / any MCP client
          │ HTTPS stateless MCP
          ▼
Cloudflare Worker
  Admin UI · RegistryDO · RunnerDO
          │ authenticated outbound WebSocket RPC
          ▼
Local Runner
  filesystem · transactional patch · Git · process · persistent jobs
```

Cloudflare does not execute code or call an AI model. The MCP client performs reasoning; the Runner performs filesystem, Git, and process work. Closing the browser, chat, MCP request, or Runner WebSocket does not stop a job that has already been started.

## Architecture

- **Worker:** the only public MCP/control-plane endpoint. It authenticates MCP client URLs, serves the small admin UI, and routes bounded RPC messages.
- **RegistryDO:** SQLite metadata for Runners, workspaces, historical jobs, administrator password/session state, and MCP client credentials.
- **RunnerDO:** one hibernatable Durable Object per Runner. It owns the current outbound Runner WebSocket and correlated RPC bridge; it never executes coding work.
- **Runner:** an outbound-only Node process with trusted workspace mappings, path confinement, patch/Git services, local subprocesses, and persistent logs/job metadata.
- **Protocol:** `packages/protocol` provides strict TypeScript schemas and a generated language-neutral JSON Schema for future Go/Rust Runners.

The Cloudflare core uses only Workers plus SQLite-backed Durable Objects. It does not use OAuth, KV, D1, Queues, R2, Sandbox, Containers, Dynamic Workers, tunnels, inbound SSH, GitHub Actions runtime, or AI model APIs.

## Deploy

Requirements: Node.js 20+, npm, Git, Wrangler, and a Cloudflare account with SQLite-backed Durable Objects enabled.

```sh
git clone https://github.com/aloneio/remote-coding-runtime.git
cd remote-coding-runtime
npm install
npm test
npm run typecheck
npm run build
npm run validate:worker
```

Configure the three production secrets used by Runner administration and the internal control channel:

```sh
cd apps/worker
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put RUNNER_TOKEN_PEPPER
npx wrangler secret put INTERNAL_CONTROL_SECRET
```

Then deploy only when ready:

```sh
npx wrangler deploy --config wrangler.jsonc
```

`npm run validate:worker` runs Wrangler with `--dry-run`. Verify its output contains `--dry-run: exiting now`; it does not prove a deployed account's quotas or production network behavior.

## First setup

Open the deployed root URL, for example:

```text
https://mcp.aloneio.com/
```

A fresh RegistryDO displays:

```text
Welcome to Remote Coding Runtime
Create administrator password
```

The first valid setup request wins atomically. No bootstrap password is required. Set the password immediately after deployment. If an uninitialized public instance is claimed by somebody else, delete/reset its Cloudflare state and redeploy.

Passwords are not stored in plaintext. The Registry stores a versioned PBKDF2-HMAC-SHA-256 verifier with a random salt. Login creates a random seven-day opaque session; the browser receives a `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/` cookie, while RegistryDO stores only its SHA-256 hash. Password changes revoke every existing session.

Admin state-changing requests use a session-bound CSRF token and same-origin checks. Setup and login also use short-lived pre-auth CSRF cookies.

## Add a Runner

Runner authentication remains independent from admin login and MCP client credentials. Enroll or rotate a Runner through the `ADMIN_TOKEN`-protected API:

```sh
curl -sS -X POST https://mcp.aloneio.com/admin/runners \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"runner_id":"home-pc"}'
```

The plaintext Runner token is returned only by successful enrollment/rotation. Store it securely, then start the Runner:

```sh
CODING_RUNNER_TOKEN='returned-runner-token' \
  npx tsx apps/runner/src/cli.ts start \
  --server wss://mcp.aloneio.com \
  --runner-id home-pc \
  --workspace zero=/home/me/code/zero\;writable\;noshell
```

Workspace syntax:

```text
--workspace id=path[;readonly|writable][;shell|noshell]
```

Defaults are `readonly;noshell`. Production requires `wss://`; cleartext `ws://` is accepted only for loopback together with `--insecure-local`.

The Runner needs only outbound Internet access. It does not expose HTTP, MCP, OAuth, SSH, or inbound ports.

## Create MCP clients

Log in at `/`, then use the `/admin` dashboard:

1. Enter a name such as `ChatGPT Web`, `Claude`, or `Cursor Desktop`.
2. Select `Read`, `Write`, and/or `Execute` scopes.
3. Press **Create**.
4. Copy the generated URL immediately. It is shown once.

Example:

```text
https://mcp.aloneio.com/fJ3...43-character-base64url-secret...x92/mcp
```

Configure only that URL in the MCP client. No OAuth flow, callback, or extra Bearer header is required. Each client must have its own URL:

```text
ChatGPT → secret A
Claude  → secret B
Cursor  → secret C
```

The dashboard supports:

- Create
- Rename
- Rotate
- Revoke
- Per-client `coding:read`, `coding:write`, `coding:exec` scopes
- Created/last-used/status/key-prefix display

Rotation invalidates the old URL immediately and displays the replacement once. Revocation makes the URL return the same `404 Not Found` used for unknown secrets.

### Secret URL security model

`/<secret>/mcp` is an API credential. Treat the full URL like a password:

- do not publish it;
- do not include it in screenshots;
- do not commit it to Git;
- do not paste it into logs, issues, or analytics;
- create a different URL for every MCP client/device;
- rotate immediately if leakage is suspected.

The application never logs the incoming URL/path and stores only a SHA-256 verifier plus a short display prefix. MCP/admin responses use `Cache-Control: no-store`; HTML also uses `Referrer-Policy: no-referrer`, a restrictive CSP, `nosniff`, and frame blocking. Infrastructure outside the application may still record request paths, so configure Cloudflare log redaction and rely on rotation/revocation for recovery.

## Tool catalog

### Runtime

```text
runner_list
runner_info
workspace_list
env_info
```

### Filesystem

```text
fs_read
fs_list
fs_search
fs_apply_patch
```

### Execution and persistent jobs

```text
exec_start
exec_run
job_list
job_get
job_logs
job_cancel
job_input
```

### Git

```text
git_status
git_diff
```

`coding:read` permits runtime/filesystem reads, `job_list`/`job_get`/logs, and Git inspection. `coding:write` permits patching. `coding:exec` permits process start/run/cancel/input. A job is shared within the single-admin instance rather than owned by one MCP client: Claude can discover and read a job created earlier by ChatGPT if it has the required scope.

## Persistent jobs

`exec_start` returns a `job_id` promptly. The Runner persists local authoritative state under:

```text
~/.remote-coding-runner/state/
├── runner.json
└── jobs/<job_id>/
    ├── meta.json
    ├── stdout.log
    └── stderr.log
```

The Worker stores bounded metadata only. `job_list` reads RegistryDO snapshots and therefore works while a Runner is offline. Full stdout/stderr remains on the Runner and is read through paginated `job_logs` once the Runner is online.

Runner sync upserts current/recent jobs without deleting older history simply because it was omitted from a bounded snapshot. Registry retains active/nonterminal jobs and up to 1,000 terminal jobs per Runner. A job may record `created_by_client_id` for audit, but that field does not restrict cross-client access.

After a Runner restart, a process that still matches its saved PID/fingerprint becomes `unknown`. Lazy reconciliation during `job_get`, `job_list`, and sync keeps it `unknown` while alive and changes it to `interrupted` after disappearance because the real exit outcome is unavailable. A recovered cancellation becomes `cancelled` only when durable evidence proves that this Runner delivered the termination request; no exit code is invented.

On-disk log files remain complete and unbounded by default. Monitor Runner disk use.

## Filesystem and patch safety

MCP requests provide only `runner_id`, `workspace_id`, and workspace-relative paths. The Runner rejects:

- POSIX absolute paths;
- Windows drive, UNC, and device paths;
- NUL bytes and `..` traversal;
- unknown workspace IDs;
- symlink/junction ancestry and escapes;
- write-through symlinks;
- writes to readonly workspaces.

`fs_read` and `job_logs` use UTF-8-safe byte cursors. Tiny pages containing Chinese, emoji, and accented characters can be concatenated exactly without replacement characters.

`fs_apply_patch` supports Add/Update/Delete/Move operations, expected SHA-256 baselines, exact hunk matching, same-directory staging/backups, rollback, BOM/newline/mode preservation, and bounded structured results. Stable safe errors such as `invalid_patch`, `missing_file`, `target_exists`, `baseline_changed`, hunk errors, `patch_install_failed`, and `patch_rollback_failed` reach MCP without exposing host absolute paths.

This is a workspace/path authorization boundary, not a hostile operating-system sandbox. Run untrusted repositories or commands inside an external VM/container with restricted mounts, secrets, and network access.

## Timeouts and environment discovery

Shared protocol constants keep the deadlines aligned:

```text
normal Runner operation maximum: 8,000 ms
Worker → Runner bridge timeout: 12,000 ms
```

This leaves a four-second transport/reply margin. `exec_run` and Git use the shared local limit; longer work must use `exec_start`.

`env_info` caches bounded parallel probes for platform, architecture, hostname, shell, Node, npm, pnpm, Python, Git, Go, rustc, Cargo, and Docker. Missing or timed-out tools return `{ "available": false }` instead of failing the request.

## Tests

```sh
npm test
npm run typecheck
npm run build
npm run validate:worker
```

The suite includes protocol tests, Runner filesystem/process/patch/Git/recovery tests, Worker Durable Object and admin/client-auth tests, and a real local Wrangler + real Runner E2E. Coverage includes:

- atomic one-time setup;
- PBKDF2 password/session behavior, expiry, logout, password invalidation, and CSRF;
- per-client secret URL create/rotate/revoke/404/scope enforcement;
- real MCP → Worker → Runner `fs_read`;
- UTF-8 file/log pagination;
- persistent execution after an MCP request closes;
- Runner transport disconnect, local continuation, reconnect, and sync;
- Client A starting a job and Client B discovering it with `job_list` while offline;
- traversal, symlink, readonly, patch, Git, timeout, output, and concurrency boundaries.

Local tests do not prove the quotas of a particular Cloudflare account, production edge-log redaction, Internet client compatibility, or a deployed restart/hibernation event. Deployment remains an operator-owned acceptance step.

## Scope deliberately excluded

The MVP does not include MCP Tasks, PTY/web terminal, multi-user accounts, organizations, teams, billing, AI agents, RAG, browser automation, GitHub Actions runtime, Cloudflare Sandbox, or Cloudflare Containers.

## Acknowledgements and license

This is an independent Apache-2.0 implementation. Design research considered:

- [`xyTom/coding-tools-mcp`](https://github.com/xyTom/coding-tools-mcp), Apache-2.0 + NOTICE;
- [`volter-ai/volter-tunnel`](https://github.com/volter-ai/volter-tunnel), Apache-2.0 + NOTICE;
- [`Hiroshimeow/agent-mcp-gateway`](https://github.com/Hiroshimeow/agent-mcp-gateway), MIT;
- Cloudflare Workers, Durable Objects, WebSocket Hibernation, Agents MCP handler, and MCP TypeScript SDK documentation.

The requested `davidlosasgonzalez/codeagent-mcp` repository was unavailable at the public URL during research, so no code or license from it was used.
