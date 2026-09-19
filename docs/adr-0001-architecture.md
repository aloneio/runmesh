# ADR-0001: Runmesh control-plane architecture

- **Status:** Accepted
- **Date:** 2026-04-02

## Context

The project needs a self-hosted control plane that exposes MCP tools while routing work to connected, locally persistent Runners. The runtime includes the Worker, Runner, admin dashboard, profile-backed CLI, and local E2E behavior under a versioned Runner↔Worker wire contract.

## Decisions

1. **Stateless MCP endpoint.** The Worker uses `createMcpHandler` from the Cloudflare Agents MCP integration with the MCP server v2 package. Each MCP client receives an independent `/<secret>/mcp` URL; the Worker verifies the path secret, rewrites the request internally to the handler's exact `/mcp` route, and keeps the endpoint stateless.
2. **Durable Objects own connection coordination.** A `RegistryDO` locates Runners and stores SQLite metadata. Each Runner receives a `RunnerDO` that owns a hibernatable WebSocket session, preserving the connection state required to bridge requests without keeping a Worker invocation alive.
3. **Jobs persist locally.** Runners own persistent workspaces, Job state and the authoritative view of local files and processes. The Worker coordinates requests and relays results.
4. **Single-user self-hosted authentication.** RegistryDO stores an administrator password verifier, opaque admin sessions, per-client MCP secret verifiers, and sticky active-Runner routing state. Runner enrollment uses its own token flow.
5. **Sticky per-client Runner routing.** `runner_list`, `runner_current`, and `runner_select` expose explicit routing. A first selection is direct; changing it requires `confirm_switch=true`. Ordinary MCP tools use the selected Runner and retain `workspace_id` where needed. An unavailable selection stays selected until the client changes it. An unselected client with exactly one registered Runner can use convenience selection.
6. **Shared single-admin context.** A Job belongs to the instance/workspace domain. `created_by_client_id` records who created it; clients with suitable scopes selecting the same Runner share its workspace IDs and bounded history.
7. **Independent implementation.** This project implements its behavior and protocol independently. References are used for behavioral study. Record the license and attribution of third-party code or assets before including them.
8. **Operator-mediated local installation.** When a verified release and valid public HTTPS origin are available, dashboard enrollment renders a command containing a single-use code. Ordinary deployments derive the origin from the request URL and matching Host; `RUNMESH_PUBLIC_ORIGIN` supports reverse proxies. Stable installation uses an activated reviewed release, and development uses its verified prerelease channel. The hosted script trusts Worker HTTPS delivery, verifies fixed GitHub assets with the embedded Ed25519 key, then invokes `runmesh install`. An operator can instead use the independently verified portable-artifact procedure. Provisioning manages Runmesh-owned identities, directories and service permissions; the operator grants workspace access. Dashboard and manual CLI installation default to `dedicated_user`, with explicit confirmation for `privileged_host`. Profiles record execution mode and central management; workspace roots arrive through authenticated policy.

## Consequences

The runtime provides protocol negotiation, correlated `request_id` exchanges, Worker/Runner transport, Durable Object coordination, enrollment, authentication and sticky Runner routing. Registry startup accepts compatible schemas and runs supported v2 additive migrations. Investigate rejected storage against the deployed and target revisions, and preserve healthy v2 resources during normal updates. Follow the [upgrade guide](upgrading.md) for component changes and recovery.

The dashboard renders installation commands and service manifests for an operator to run on the host. A hosted command contains a single-use enrollment code, with a hidden prompt available in an interactive terminal when the code argument is omitted. Installer availability controls future downloads. Use credential revocation to end access and host service controls to stop local processes.

Protocol additions must remain explicit. The dashboard uses nonces for its application script; inline styles still require `style-src 'unsafe-inline'`. Deployed quota behavior, edge-log redaction and external MCP-client compatibility need environment-specific acceptance checks.

## Current security contract (0.1.4; publication status in release readiness)

First administrator setup is CSRF-protected, same-origin and atomic first-success-wins. Complete it before exposing the instance to untrusted visitors. The default Runner
is `dedicated_user`; the default new MCP client is `coding:read`. Existing
permissions are unchanged. Requested tool content is relayed to its authorized
client but excluded from durable MCP audit. Audit reads have a seven-day visibility window and each store has a 1,000-entry cap per Runner; physical cleanup can lag. See the [security model](security.md) and [history retention](quota-resilience.md) for storage and deletion limits.

Hosted installer commands include the single-use enrollment code for one-copy
setup. Scripts accept a positional code, `--code CODE`, or `--code=CODE`; omitting
the code allows a hidden prompt in an interactive terminal. On Windows, also remove `-NonInteractive` from the copied command. The downstream Runner receives
standard input. The complete convenience
command is credential material and may be recorded in command history or
process arguments. The 0.1.4 production gate is enabled only after independent signed-asset
verification. Development selects only its separately verified dev prereleases. See [release status](release-readiness.md) for the current candidate state.

## Amendment — 2026-09-14: optional history isolation

The quota work adds D1 for optional metadata audit while Registry retains credential and current-authorization authority. The v2 Registry gains additive retention counters/indexes and per-client recording preferences. The amendment preserves outbound transport, local Job authority and immutable Runner assets. See [recording and retention](quota-resilience.md) for recording semantics, quota limits and migration details.
