# ADR-0001: Runmesh control-plane architecture

- **Status:** Accepted
- **Date:** 2026-04-02

## Context

The project needs a self-hosted control plane that exposes MCP tools while routing work to connected, locally persistent Runners. The runtime includes the Worker, Runner, admin dashboard, profile-backed CLI, and local E2E behavior under a versioned Runner↔Worker wire contract.

## Decisions

1. **Stateless MCP endpoint.** The Worker uses `createMcpHandler` from the Cloudflare Agents MCP integration with the MCP server v2 package. Each MCP client receives an independent `/<secret>/mcp` URL; the Worker verifies the path secret, rewrites the request internally to the handler's exact `/mcp` route, and keeps the endpoint stateless.
2. **Durable Objects own connection coordination.** A `RegistryDO` locates Runners and stores SQLite metadata. Each Runner receives a `RunnerDO` that owns a hibernatable WebSocket session, preserving the connection state required to bridge requests without keeping a Worker invocation alive.
3. **Jobs persist locally.** Runners own local, persistent workspaces and job state. The Worker is a coordinator and must not become the authoritative filesystem or process-state store.
4. **Single-user self-hosted authentication.** RegistryDO stores an administrator password verifier, opaque admin sessions, per-client MCP secret verifiers, and sticky active-Runner routing state. OAuth and KV are intentionally not part of the deployed core. Runner enrollment authentication remains an independent token lane.
5. **Sticky per-client Runner routing.** `runner_list`, `runner_current`, and `runner_select` expose explicit control-plane routing. A first selection is direct; changing it requires `confirm_switch=true`. Ordinary MCP tools retain `workspace_id` where needed but no longer accept `runner_id`; the Worker resolves the selected Runner. A selected failed/unavailable Runner never silently falls back to another. The only convenience selection is an unselected client with exactly one registered Runner.
6. **Shared single-admin context.** A Job belongs to the instance/workspace domain, not to a chat session. `created_by_client_id` is audit metadata, not an ownership restriction. Clients with suitable scopes that select the same Runner share its workspace IDs and bounded Registry job history.
7. **Independent implementation.** This project reimplements its behavior and protocol independently. References are used only for behavioral study; no source is copied. Any third-party code or assets used later must have their license and attribution recorded before inclusion. A previously mentioned `codeagent` reference URL is unavailable, so it cannot be inspected or used as a source dependency.
8. **Operator-mediated local installation.** Dashboard enrollment renders a command containing a single-use enrollment code when a verified release is available in the selected channel and the public HTTPS origin is valid. Ordinary deployments derive that origin from the request URL and matching Host; `RUNMESH_PUBLIC_ORIGIN` is an optional reverse-proxy override. Stable distribution requires an activated reviewed release record; development has a separate verified prerelease channel. Otherwise, the dashboard shows the independently verifiable portable-artifact procedure. The local script trusts Worker HTTPS delivery for bootstrap, then verifies fixed GitHub assets with a reviewed embedded Ed25519 key before invoking `runmesh install`. It accepts no arbitrary package URL or moving version. Operators requiring an independent bootstrap trust path can verify the portable artifact separately. The provisioner manages Runmesh-owned identities, directories and service permissions; it never changes workspace ownership or modes. Dashboard and manual CLI installation default to `dedicated_user`; `privileged_host` requires explicit selection and confirmation. Profiles require an execution mode, central management and no local workspace roots.

## Consequences

The runtime provides protocol negotiation, correlated `request_id` exchanges, Worker/Runner transport, Durable Object coordination, enrollment, authentication and sticky Runner routing. Registry startup accepts compatible schemas and runs explicitly supported v2 additive migrations; incompatible storage is rejected. Arbitrary schema repair, data import, profile conversion, downgrade and automatic rollback remain unsupported. Preserve healthy v2 resources during normal updates.

The dashboard renders installation commands and service manifests; an operator runs them on the host. A hosted command contains a single-use enrollment code, with a hidden prompt available in an interactive terminal when the code argument is omitted. Disabling future bootstrap delivery does not invalidate downloaded scripts, revoke Runner credentials or reverse a redeemed code. Use the corresponding revocation controls when access must end.

Protocol additions must remain explicit. The dashboard uses nonces for its application script; inline styles still require `style-src 'unsafe-inline'`. Deployed quota behavior, edge-log redaction and external MCP-client compatibility need environment-specific acceptance checks.

## Current security contract (0.1.4; publication status in release readiness)

First administrator setup requires no additional bootstrap token and remains
CSRF-protected, same-origin and atomic first-success-wins. The default Runner
is `dedicated_user`; the default new MCP client is `coding:read`. Existing
permissions are unchanged. Requested tool content is relayed to its authorized
client but excluded from durable MCP audit. Audit reads have a seven-day visibility window and each store has a 1,000-entry cap per Runner; physical cleanup can lag. See the [security model](security.md) and [history retention](quota-resilience.md) for storage and deletion limits.

Hosted installer commands include the single-use enrollment code for one-copy
setup. Scripts accept a positional code, `--code CODE`, or `--code=CODE`; omitting
the code allows a hidden prompt in an interactive terminal. On Windows, also remove `-NonInteractive` from the copied command. The downstream Runner receives
standard input, not a temporary credential file. The complete convenience
command is credential material and may be recorded in command history or
process arguments. The 0.1.4 production gate is enabled only after independent signed-asset
verification. Development uses its separately verified prerelease gate and does not fall back to stable assets. See [release status](release-readiness.md) for the current candidate state.

## Amendment — 2026-09-14: optional history isolation

The owner-approved quota work introduces D1 only for optional metadata audit, not credential authority or stale-authentication fallback. The v2 Registry gains tested additive retention counters/indexes and per-client recording preferences. Outbound-only transport, current authorization, local Job authority and immutable Runner assets are unchanged. See [implementation and acceptance](quota-resilience.md) for recording semantics, quota limits, migration overlap and physical-retention qualifications.
