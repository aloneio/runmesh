# Remote Coding Runtime

A model-neutral, client-neutral remote coding runtime with one Cloudflare control plane and outbound-only local Runners.

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

Cloudflare does not execute code or call an AI model. The MCP client performs reasoning; the Runner performs filesystem, Git, and process work. Closing a browser, chat, MCP request, or Runner WebSocket does not stop an already started local job.

## Quick start

This is the preferred dashboard-led setup path. It intentionally puts deployment, initial dashboard setup, Runner enrollment, MCP-client creation, and Runner selection in that order.

### 1. Deploy the control plane

Requirements: Node.js 20+, npm, Git, Wrangler, and a Cloudflare account with SQLite-backed Durable Objects enabled.

```sh
git clone https://github.com/aloneio/remote-coding-runtime.git
cd remote-coding-runtime
npm install
npm test
npm run typecheck
npm run build
npm run validate:worker

cd apps/worker
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put RUNNER_TOKEN_PEPPER
npx wrangler secret put INTERNAL_CONTROL_SECRET
npx wrangler deploy --config wrangler.jsonc
```

`npm run validate:worker` is local Wrangler `--dry-run` validation. It does not deploy, prove a Cloudflare account's quotas, validate edge logging, or test Internet MCP clients. Deployment and deployed acceptance remain operator work.

### 2. Set up the dashboard

Open the deployed root URL, such as `https://mcp.example.com/`. A new RegistryDO presents **Create administrator password**. The first valid setup request wins atomically, so initialize it immediately after deployment.

The dashboard is the browser administration lane: it creates MCP clients, adds and renames Runners, generates enrollment codes, rotates/revokes/deletes Runners, and shows safe Runner/job metadata. It uses the administrator password and browser session; it is separate from `ADMIN_TOKEN`, Runner credentials, and MCP URL secrets.

### 3. Add a Runner and redeem its one-time enrollment code

In **Admin → Runners → Add Runner**, provide a human-facing `display_name` and optionally a safe Runner ID. The display name is what the dashboard and `runner_list` show; the Runner ID is the stable protocol identifier.

The dashboard displays an enrollment code once. It is single-use, expires after 30 minutes, and **Regenerate enrollment** invalidates any still-unused code for that Runner before creating a replacement. Run the rendered public bootstrap command from the directory that should become the initial local workspace. Linux and macOS use the `/runner/install.sh` command; Windows uses `/runner/install.ps1`. Each script receives the code only as its command argument, requires an existing Node.js 20+ / npm runtime, then calls `coding-runner enroll --server .../runner/enroll --code ...` and `coding-runner install`.

The Worker does not publish a public package itself. Configure a stable distributable `RUNNER_PACKAGE_SPEC` (exact `package@x.y.z`, or an HTTPS `.tgz` with matching `RUNNER_PACKAGE_NAME` / `RUNNER_PACKAGE_VERSION`) before using the bootstrap scripts. Until configured, `/runner/releases/latest` marks the descriptor non-distributable and the scripts fail instead of downloading GitHub `main`. Installers are per-user and print, but do not run, the systemd-user, LaunchAgent, or Scheduled Task activation command.

The Runner uses only outbound Internet access and never exposes HTTP, MCP, OAuth, SSH, or inbound ports. Production profiles require `wss://`; `ws://` is limited to loopback development with `--insecure-local`.

### 4. Create an MCP URL

In **Admin → MCP Clients**, create a client label (for example `ChatGPT Web`), choose `coding:read`, `coding:write`, and/or `coding:exec`, then copy the generated URL immediately:

```text
https://mcp.example.com/<43-character-base64url-secret>/mcp
```

Configure that URL directly in the MCP client. No OAuth flow, callback, or extra Bearer header is required. Create a separate URL for each client/device. The raw URL is displayed only when creating or rotating the client.

### 5. Select the Runner from the MCP client

Start with the routing tools:

```text
runner_list()
runner_current()
runner_select({"runner_id":"home-pc"})
```

The first selection is immediate. Changing an already selected Runner requires an explicit confirmation:

```text
runner_select({"runner_id":"other-pc","confirm_switch":true})
```

When a client has no selection and there is exactly one registered Runner, the first ordinary Runner-backed tool may persistently select that one Runner. With zero or multiple Runners, select one explicitly. See [Runner routing and shared context](#runner-routing-and-shared-context) before using more than one Runner or MCP URL.

## Runner routing and shared context

Runner selection is **sticky per MCP client**, not per chat, browser tab, or request. The selection is stored with the MCP client record, survives that client's rename and secret rotation, and is visible through `runner_current`. Each ordinary MCP tool resolves the selected Runner; its successful and failed responses include a safe `runner_context` where applicable.

- `runner_list` lists safe Runner ID, `display_name`, connection state, availability, and timestamp. It returns no credential or workspace-root data.
- `runner_current` reports this client's selection, including an unavailable selected Runner.
- `runner_select` is the only MCP routing mutation. Initial selection needs no confirmation; a different selection requires `confirm_switch: true` to prevent accidental cross-host work.
- Ordinary tools no longer accept `runner_id`. `workspace_id` remains required where a tool needs a workspace. `runner_id` is retained only for Runner-management/routing tools such as `runner_select` and `runner_info`, and on the private Runner transport.
- There is no silent fallback from a selected offline, stale, revoked, or unavailable Runner to another Runner. Resolve the condition with `runner_current`, then explicitly select another Runner. Deleting a Runner clears clients that selected it; a subsequently unselected client follows only the normal one-registered-Runner convenience rule above.

The routing record is not a data-isolation boundary. This is a single-admin runtime: MCP clients that have scopes and select the same Runner share its configured workspace IDs and bounded Registry job history. `created_by_client_id` is audit metadata, not ownership enforcement. A client with the required scope can discover and read a compatible job created through another client. Use distinct client URLs and least-privilege scopes, but do not treat them as separate tenants.

## Tool catalog

### Routing and runtime

```text
runner_list
runner_current
runner_select
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

`coding:read` permits routing/runtime/filesystem reads, job listing/inspection/logs, and Git inspection. `coding:write` permits patching. `coding:exec` permits process start/run/cancel/input.

## Local Runner profile and service behavior

`coding-runner enroll` saves the server URL, Runner ID, long-lived Runner token, configured workspaces, and optional concurrency setting in a local profile. Default locations are:

```text
Linux:   ~/.remote-coding-runner/profile.json
macOS:   ~/Library/Application Support/RemoteCodingRunner/profile.json
Windows: %LOCALAPPDATA%\RemoteCodingRunner\profile.json
```

On POSIX, the profile directory is created with mode `0700` and the profile file with mode `0600`; Windows ACLs are not inspected by `doctor`. `coding-runner status` redacts the token. `coding-runner doctor` checks profile presence, stored URL, POSIX file mode, workspace existence, a managed service manifest, and selected local tools. `coding-runner env` reports bounded environment probes. `coding-runner workspace list|add|remove` manages locally configured workspace IDs; `add` canonicalizes an existing directory and supports `--readonly` and `--no-shell`.

A profile-backed `coding-runner start` uses its saved server, credential, Runner ID, and workspaces. The legacy explicit `start --server --runner-id --token --workspace ...` form remains available for advanced/manual operation. Workspace roots stay local and never enter MCP or Runner metadata.

Service commands are intentionally partial adapters, not a host-management installer:

- `coding-runner install` writes only a hash-marked, per-user systemd user unit (Linux), LaunchAgent plist (macOS), or Scheduled Task XML (Windows). It refuses to overwrite an unmanaged manifest. It renders the corresponding host commands but does not run `systemctl`, `launchctl`, or `schtasks`.
- `coding-runner stop` and `coding-runner restart` render/report the platform lifecycle command; they do not execute it.
- `coding-runner uninstall` removes only a manifest whose marker and content hash match. It reports the host disable/bootout/delete command rather than executing it. `--purge --yes` also removes the profile, but deliberately leaves workspace roots and persistent job state untouched.

Run the rendered host command yourself after reviewing it. Dashboard pages also render enrollment instructions only; they cannot run host lifecycle commands.

## Safety and operations

### Credentials, dashboard, and revocation

The first administrator password is stored as a salted PBKDF2-HMAC-SHA-256 verifier. Browser sessions are random opaque values whose hashes are stored in RegistryDO; password changes invalidate every session. State-changing dashboard requests require CSRF and same-origin checks.

Setup and login use a deployment-wide pre-authentication throttle, not an IP or user-specific rate limiter. Five failed password-KDF attempts are permitted before a 30-second delay; later failed attempts back off exponentially up to 15 minutes. A successful authentication resets the throttle. Treat it as protection against repeated attempts and KDF concurrency, not a complete distributed attack-control solution.

MCP URLs are 256-bit path credentials. RegistryDO stores only a SHA-256 verifier and a display prefix. Rotation invalidates the old URL immediately; revocation makes it return the same `404 Not Found` as an unknown URL. Never put an MCP URL in screenshots, Git, logs, or analytics. Application code avoids logging raw URL paths, but infrastructure can still record them; configure edge-log redaction and rotate on suspected exposure.

Runner enrollment codes are one-time and short-lived. Redeeming one atomically creates/replaces the Runner credential. Runner credential rotation or revocation increments the credential/connection generation and closes the existing Runner socket. A revoked Runner cannot reconnect with its old token; its selected MCP clients report it unavailable rather than falling back. Revocation removes synchronized workspace/job metadata from RegistryDO but does not signal the Runner to kill already running local processes, so secure the local host separately. Deleting a Runner additionally clears its clients' selected Runner IDs.

### Filesystem, execution, and jobs

The Worker resolves the active Runner before forwarding MCP requests. MCP tool inputs provide a workspace ID and workspace-relative path, while host workspace roots never cross the protocol. The Runner rejects absolute, drive/UNC/device, NUL, traversal, symlink/junction escape, write-through-symlink, unknown-workspace, and readonly-write requests. `fs_apply_patch` uses baseline checks, staging/backups, per-file replacement, rollback, and bounded root-free errors.

This is a workspace/path authorization boundary, not a hostile operating-system sandbox. Use an external VM or container with restricted mounts, secrets, network, and OS privileges for untrusted repositories or commands.

`exec_start` returns `job_id` promptly. Runner-local state and complete logs live under `~/.remote-coding-runner/state/` by default. RegistryDO keeps bounded metadata so `job_list` works while the selected Runner is offline; full logs require a connected Runner. Active/nonterminal jobs and up to 1,000 terminal jobs per Runner are retained in RegistryDO. Local log files are unbounded by default; monitor disk use.

The local maximum for short operations is 8 seconds and the Worker-to-Runner bridge timeout is 12 seconds. Use `exec_start` for longer work. A disconnect leaves local jobs running; live tools report the selected Runner's offline state rather than selecting another host.

## Architecture and scope

- **Worker:** the only public MCP/control-plane endpoint. It authenticates MCP URLs, serves the admin UI, and routes bounded RPC messages.
- **RegistryDO:** SQLite metadata for Runners, workspaces, historical jobs, administrator state, MCP clients, enrollment records, selection state, and throttle state.
- **RunnerDO:** one hibernatable Durable Object per Runner. It owns the current outbound Runner WebSocket and correlated bridge; it never executes coding work.
- **Runner:** an outbound Node process with trusted local workspace mappings, filesystem/patch/Git services, subprocesses, persistent jobs, and local credentials.
- **Protocol:** `packages/protocol` provides TypeScript schemas and generated JSON Schema for Runner transport implementers.

The deployed core uses Workers plus SQLite-backed Durable Objects only. It has no OAuth, AI/model API, KV, D1, Queues, R2, Cloudflare Sandbox, Cloudflare Containers, Dynamic Workers, tunnels, inbound SSH, or GitHub Actions runtime.

RegistryDO performs additive, in-place startup migrations for known older schema columns/tables/indexes (including display names, enrollment records, active-runner fields, and throttle state). There is no versioned external migration runner and no documented downgrade path. Back up production Durable Object data and rehearse upgrades before relying on this behavior.

The dashboard response CSP deliberately permits inline styles and scripts (`style-src 'unsafe-inline'; script-src 'unsafe-inline'`) because the Worker emits inline UI CSS/JavaScript. Dynamic fields are escaped, but this is weaker than a nonce/hash/external-script CSP. Treat future dashboard HTML changes as XSS-sensitive and harden the CSP before a broader-hostile deployment.

## Advanced: `ADMIN_TOKEN`, manual APIs, and protocol

The dashboard path above is preferred. `ADMIN_TOKEN` is an independent, server-side Runner administration credential, not a browser or MCP credential. The programmatic API can register or rotate a Runner directly:

```sh
curl -sS -X POST https://mcp.example.com/admin/runners \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"runner_id":"home-pc"}'
```

It returns the plaintext Runner token only on successful registration/rotation. Store it securely, then use the legacy explicit Runner start form:

```sh
CODING_RUNNER_TOKEN='<returned-runner-token>' \
coding-runner start \
  --server wss://mcp.example.com \
  --runner-id home-pc \
  --workspace zero=/home/me/code/zero\;writable\;noshell
```

The manual API accepts a caller-supplied token only when it is 32–512 non-whitespace characters. `POST /admin/runners/<runner_id>/rotate` registers/replaces a credential; `POST /admin/runners/<runner_id>/revoke` invalidates it. These APIs are distinct from dashboard enrollment-code creation and require the configured `ADMIN_TOKEN`.

The authoritative Runner↔Worker wire contract is `packages/protocol/src/schema.ts`; its generated artifact is `packages/protocol/schema/wire-message.schema.json`. See [docs/protocol.md](docs/protocol.md) for frame/version rules and [docs/runner-transport.md](docs/runner-transport.md) for transport details. MCP routing is documented separately because the selected Runner is resolved by the Worker rather than supplied to ordinary tool schemas.

## Validation and deferred release work

Run local validation from the repository root:

```sh
npm test
npm run typecheck
npm run build
npm run validate:worker
npm run pack:runner
```

These are local tests/build/pack checks only. They do not validate a deployed Durable Object migration, Cloudflare account quotas, edge-log redaction, external MCP client behavior, browser service installation, or a production restart/hibernation event.

Deferred before a public release:

- configure a signed/stable externally distributable Runner package spec before enabling bootstrap installation;
- make service lifecycle actions execute through reviewed host-specific adapters if that is desired, rather than only rendering commands;
- replace inline dashboard scripts/styles or use nonces/hashes so CSP no longer requires `unsafe-inline`;
- perform deployed migration, quota, logging-redaction, and external-MCP-client acceptance testing.

## Acknowledgements and license

This is an independent Apache-2.0 implementation. Design research considered:

- [`xyTom/coding-tools-mcp`](https://github.com/xyTom/coding-tools-mcp), Apache-2.0 + NOTICE;
- [`volter-ai/volter-tunnel`](https://github.com/volter-ai/volter-tunnel), Apache-2.0 + NOTICE;
- [`Hiroshimeow/agent-mcp-gateway`](https://github.com/Hiroshimeow/agent-mcp-gateway), MIT;
- Cloudflare Workers, Durable Objects, WebSocket Hibernation, Agents MCP handler, and MCP TypeScript SDK documentation.

The requested `davidlosasgonzalez/codeagent-mcp` repository was unavailable at the public URL during research, so no code or license from it was used.
