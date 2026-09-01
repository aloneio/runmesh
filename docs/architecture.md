# Architecture

```text
MCP client with per-client secret URL and sticky active_runner_id
        │ stateless MCP over HTTPS
        ▼
Cloudflare Worker
  ├─ setup/login/admin HTML
  ├─ RegistryDO (SQLite)
  └─ RunnerDO per runner_id (hibernatable WebSocket)
        │ outbound-only WSS
        ▼
Local Runner
  ├─ profile/credential store
  ├─ workspace/path policy
  ├─ filesystem and UTF-8 paging
  ├─ transactional patch and Git
  └─ persistent Job Manager
```

## Decisions

- The Worker is the only public MCP server; a Runner is never an MCP/HTTP/auth server.
- Cloudflare is a control plane. CPU, filesystem, Git, processes, and complete logs stay on the Runner.
- MCP HTTP is stateless. Each request authenticates its path secret and creates a fresh `McpServer` through `createMcpHandler`.
- MCP client authentication is single-user/self-hosted: first-time admin password plus independent `/<secret>/mcp` client URLs. There is no OAuth lane.
- Each MCP client stores one sticky active Runner selection. `runner_list`, `runner_current`, and `runner_select` manage this routing state; changing a non-null selection requires explicit confirmation. Ordinary tools resolve the selection and retain `workspace_id` parameters but do not expose ordinary per-call `runner_id` inputs.
- Selected Runner failure never triggers fallback to another Runner. Explicit selection is required after an offline, stale, revoked, or unavailable selection. Deleting a Runner clears affected client selections. The only convenience auto-selection is the unselected, exactly-one-registered-Runner case.
- Runner authentication remains independent: enrollment codes are short-lived/single-use; the resulting token uses a verifier, credential version, connection epoch, rotation, and revocation design.
- A Job belongs to the single-admin instance/workspace domain, not to a chat session. `created_by_client_id` is audit metadata, not an ownership restriction. Clients sharing a Runner and scopes share its workspace/job context.
- Runner local disk is authoritative. RegistryDO stores bounded historical metadata and never treats a bounded sync omission as immediate job deletion.
- The dashboard is a browser control plane for metadata and code/manifest rendering. It does not execute arbitrary host installers or every rendered lifecycle command.

## Enrollment and local control plane

The dashboard adds a Runner with a stable safe ID and `display_name`, then creates a 30-minute, single-use enrollment code. Regeneration deletes any unused code for that Runner before inserting the replacement. `POST /runner/enroll` atomically redeems the code and returns a new Runner token; the packaged CLI's supported flow is `coding-runner enroll --server ... --code-stdin`, followed by `coding-runner install`. It stores a centrally managed local profile with zero workspaces; only the Admin Panel adds central workspace roots.

The dashboard displays a code-free one-command installer only when the fixed signed preview release has been published, independently verified, and explicitly enabled for the Worker **with a valid canonical external HTTPS `RUNMESH_PUBLIC_ORIGIN`**. The default/local environment keeps that path disabled; the checked-in `production` environment carries the gates for the verified immutable release. Otherwise it displays the manual portable-artifact route and uses `coding-runner enroll --code-stdin`. The enabled installer pins the release and embedded Ed25519 key, verifies signed immutable assets, and treats Worker HTTPS delivery as bootstrap trust model A; high-assurance operators use an independent offline keyring path. It does not provide automatic update.

The local CLI has implemented profile/status/doctor/workspace/env/start commands and a service-manifest adapter. `coding-runner install` invokes the Runmesh service provisioner for Runmesh-owned identities and directories (and Windows Local Service ACLs), then writes managed system service manifests with dedicated-user identity by default for direct/manual CLI use. The authenticated dashboard's standard machine setup explicitly chooses `privileged_host` with a visible confirmation. It never changes configured Workspace ownership or modes; the operator grants the service identity only the required Workspace access. `privileged_host` requires explicit confirmation; profiles missing `execution_mode` or `management_mode` are reported as `migration_required`. A missing `execution_mode` blocks system installation until an explicit mode is supplied; a missing `management_mode` blocks local Workspace mutation until `workspace migrate` records `central` or `legacy_manual`. Doctor diagnostics report stable required/optional checks and Host shell availability. The dashboard and service-action pages render commands/manifests but do not activate a host service themselves. Hosted bootstrap scripts fail closed while either the fixed release gate or canonical public origin is absent. When the exact signed release is enabled, a new-install-only script verifies and stages the portable package, obtains the code locally through hidden input, creates the canonical system profile, activates the versioned `current` path, and invokes the same local `coding-runner install` provisioner. A local failure removes only the newly created version/current/service state; a remotely redeemed code cannot be rolled back and must be regenerated. When hosted bootstrap is unavailable, the operator must use a manually verified portable artifact and run `coding-runner install` explicitly.

## State and migration

RegistryDO SQLite tables cover Runners, immutable policy snapshots, workspace snapshots, jobs, admin settings/sessions, auth throttle state, MCP clients, and Runner enrollment records. Startup executes additive `PRAGMA table_info` checks and `ALTER TABLE`/`CREATE TABLE IF NOT EXISTS`/index repairs for known legacy layouts, then performs fail-closed policy recovery: a normal repeat start is a no-op once the migration marker exists; if execution is interrupted between the snapshot and marker writes, a later start may create an additional pending snapshot, but it never authorizes an unacknowledged policy. A complete validated applied snapshot is retained; otherwise a newer pending snapshot is derived from valid canonical admin config (or a locked zero-workspace policy when config is invalid), and applied/reported identity is cleared for Runner revalidation. There is no standalone versioned migration tool or downgrade procedure; upgrades should be backed up and rehearsed against deployed state.

The authentication throttle reserves attempts transactionally before expensive password KDF work. Five failed attempts are admitted, then the per-kind (`setup` or `login`) block starts at 30 seconds and increases exponentially to a 15-minute maximum; success clears the state. It is not per-IP and not a full distributed rate limiter.

## Failure behavior

- MCP/browser closes after `exec_start`: local job continues.
- Runner WebSocket disconnects: local jobs/logs continue; live tools report the selected Runner as offline. No other Runner is tried. `job_list` and last-known `job_get` metadata remain available from Registry snapshots where permitted.
- Runner reconnects: monotonic sync upserts workspaces and recent/active job metadata.
- Runner process restarts: matching live jobs become `unknown`; reconciliation moves vanished jobs to `interrupted` without guessing the exit code. Recovered cancellation is reported as `cancelled` only with persisted delivery evidence.
- Runner revocation: old transport credentials fail and the socket is closed; centrally managed Workspace, immutable Policy, and retained Job metadata remain available for operator review. Already-running local processes are not remotely killed.
- Worker/DO restart: in-flight bridge calls can fail, while Runner-local jobs continue. Callers should retry only safe/idempotent requests.

## Security posture and excluded runtime

Admin/MCP HTML uses no-store/referrer/no-sniff/frame protections and CSRF checks. The emitted dashboard uses inline style/script content, so its CSP currently requires `unsafe-inline`; replacing that with nonce/hash or external resources is deferred hardening.

The deployed core uses Workers plus SQLite-backed Durable Objects only. It does not include OAuth, AI/model APIs, Cloudflare Sandbox, Cloudflare Containers, GitHub Actions runtime, KV, D1, R2, Queues, Dynamic Workers, tunnels, or inbound services. The Runner's workspace policy is not an OS sandbox; operators must provide external isolation for hostile code.

## Free Plan posture

WebSocket Hibernation reduces idle control-plane connection cost; local Runners carry execution and disk cost. Capacity still depends on account-wide Cloudflare quotas and must be measured by the operator. Local validation does not prove deployed quotas or restart/hibernation behavior.
