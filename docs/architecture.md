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

The dashboard adds a Runner with a stable safe ID and `display_name`, then creates a 30-minute, single-use enrollment code. Regeneration deletes any unused code for that Runner before inserting the replacement. `POST /runner/enroll` atomically redeems the code and returns a new Runner token; the packaged CLI's supported flow is `runmesh enroll --server ... --code-stdin`, followed by `runmesh install`. It stores a centrally managed local profile with zero workspaces; only the Admin Panel adds central workspace roots.

The dashboard displays a one-command installer with a quoted single-use enrollment code only when the fixed signed preview release has been published, independently verified, and explicitly enabled for the Worker **with a valid canonical external HTTPS `RUNMESH_PUBLIC_ORIGIN`**. The default/local environment keeps that path disabled; the checked-in `production` environment keeps distribution disabled pending the new dev.4 signed release. Otherwise it displays the manual portable-artifact route and uses `runmesh enroll --code-stdin`. The enabled installer pins the release and embedded Ed25519 key, verifies signed immutable assets, and treats Worker HTTPS delivery as bootstrap trust model A; high-assurance operators use an independent offline keyring path. It does not provide automatic update.

The local CLI has implemented profile/status/doctor/workspace/env/start commands and a service-manifest adapter. `runmesh install` invokes the Runmesh service provisioner for Runmesh-owned identities and directories (and Windows Local Service ACLs), then writes managed system service manifests with dedicated-user identity by default for direct/manual CLI use. The dashboard and direct CLI default to `dedicated_user`; `privileged_host` is an advanced choice requiring explicit confirmation. It never changes configured Workspace ownership or modes; the operator grants the service identity only the required Workspace access. Current profiles require a valid `execution_mode`, `management_mode: central`, and zero local workspace entries; an incomplete profile is rejected and must be replaced through enrollment. The local `workspace` command is inspection-only; workspace roots and permissions are configured in the Admin Panel. Doctor diagnostics report stable required/optional checks and Host shell availability. The dashboard and service-action pages render commands/manifests but do not activate a host service themselves. Hosted bootstrap scripts fail closed while either the fixed release gate or canonical public origin is absent. When the exact signed release is enabled, a new-install-only script verifies and stages the portable package, uses the supplied code after verification, or prompts locally when it was omitted, creates the canonical system profile, activates the versioned `current` path, and invokes the same local `runmesh install` provisioner. A local failure removes only the newly created version/current/service state; a remotely redeemed code cannot be rolled back and must be regenerated. When hosted bootstrap is unavailable, the operator must use a manually verified portable artifact and run `runmesh install` explicitly.

## State and release boundary

RegistryDO SQLite tables cover Runners, immutable policy snapshots and mutations, centrally managed workspaces, jobs, admin settings/sessions, auth throttle state, MCP clients, enrollment records, and internal request nonces. On construction it accepts only this complete schema; a persisted incompatible schema is rejected and must be replaced with a fresh Durable Object namespace. It never repairs, transforms, or retains partial records from another schema. There is no data-import, downgrade, or automatic profile-conversion path; the transition procedure is documented in [migration.md](migration.md).

The authentication throttle reserves attempts transactionally before expensive password KDF work. Five failed attempts are admitted, then the per-kind (`setup` or `login`) block starts at 30 seconds and increases exponentially to a 15-minute maximum; success clears the state. It is not per-IP and not a full distributed rate limiter. If the optional throttle write hits a provider quota or transient storage error, the Registry keeps authentication available with an in-memory per-instance fallback and exposes a `Login protection` feature notice instead of returning a global 503.

## Failure behavior

- MCP/browser closes after `exec_start`: local job continues.
- Runner WebSocket disconnects: local jobs/logs continue; live tools report the selected Runner as offline. No other Runner is tried. `job_list` and last-known `job_get` metadata remain available from Registry snapshots where permitted.
- Runner reconnects: the session is re-authenticated, heartbeat state is refreshed, and recent/active job metadata is synchronized; workspace roots remain authoritative in the central policy.
- Runner process restarts: matching live jobs become `unknown`; reconciliation moves vanished jobs to `interrupted` without guessing the exit code. Recovered cancellation is reported as `cancelled` only with persisted delivery evidence.
- Runner revocation: old transport credentials fail and the socket is closed; centrally managed Workspace, immutable Policy, and retained Job metadata remain available for operator review. Already-running local processes are not remotely killed.
- Worker/DO restart: in-flight bridge calls can fail, while Runner-local jobs continue. Callers should retry only safe/idempotent requests.

## Security posture and excluded runtime

Admin/MCP HTML uses no-store/referrer/no-sniff/frame protections and CSRF checks. The emitted dashboard uses inline style/script content, so its CSP currently requires `unsafe-inline`; replacing that with nonce/hash or external resources is deferred hardening.

The deployed core uses Workers plus SQLite-backed Durable Objects only. It does not include OAuth, AI/model APIs, Cloudflare Sandbox, Cloudflare Containers, GitHub Actions runtime, KV, D1, R2, Queues, Dynamic Workers, tunnels, or inbound services. The Runner's workspace policy is not an OS sandbox; operators must provide external isolation for hostile code.

## Free Plan posture

WebSocket Hibernation reduces idle control-plane connection cost; local Runners carry execution and disk cost. Capacity still depends on account-wide Cloudflare quotas and must be measured by the operator. Local validation does not prove deployed quotas or restart/hibernation behavior.

## Current security contract (dev.4 candidate)

First administrator setup requires no additional bootstrap token and remains
CSRF-protected, same-origin and atomic first-success-wins. The default Runner
is `dedicated_user`; the default new MCP client is `coding:read`. Existing
permissions are unchanged. Requested tool content is relayed to its authorized
client but excluded from durable MCP audit. Only metadata is stored for up to
seven days and 1,000 calls per Runner; legacy audit rows are purged once by the
v2-compatible migration. See [rollout notes](security-remediation.md).

Hosted installer commands include the single-use enrollment code for one-copy
setup. Scripts accept a positional code, `--code CODE`, or `--code=CODE`; omitting
the code retains the hidden terminal prompt. The downstream Runner receives
standard input, not a temporary credential file. The complete convenience
command is credential material and may be recorded in command history or
process arguments. The dev.4 production gate remains empty until the new
immutable signed artifact is independently verified.
