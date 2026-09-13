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
8. **Operator-mediated local installation.** Dashboard enrollment renders a one-command installer with a quoted single-use enrollment code only when the exact fixed signed release is explicitly enabled after release publication and independent verification **and a canonical external HTTPS `RUNMESH_PUBLIC_ORIGIN` is configured**; otherwise it renders the manual portable-artifact route and `--code-stdin`. The dashboard and service-action pages only render commands/manifests; they do not activate host services themselves. When the fixed gate is enabled, the local script is trust model A (Worker HTTPS delivery is its bootstrap root), uses an embedded reviewed Ed25519 key for fixed GitHub release assets, and invokes the local `runmesh install` provisioner after verification. It accepts no arbitrary package/URL/moving version, and downloaded keyrings are not trust roots; high-assurance operators can use the independent portable-artifact path. `runmesh install` manages only Runmesh-owned identities/directories and Windows Local Service ACLs; it never changes Workspace ownership or modes. The dashboard and direct/manual CLI default to `dedicated_user`; privileged-host execution requires explicit advanced selection and confirmation. Current profiles require an explicit execution mode, central management, and no local workspace roots; incomplete profiles are rejected and must be replaced through enrollment.

## Consequences

The runtime provides protocol negotiation, correlated `request_id` exchanges, Worker/Runner transport, Durable Object coordination, Runner enrollment, admin/client authentication, profile-backed CLI operations, sticky Runner routing, and real local E2E coverage. Registry startup accepts only the current complete schema and fails closed on a persisted incompatible namespace; only the explicitly tested v2 additive source-throttle and metadata-only audit migrations run in place; arbitrary schema repair, data import, profile conversion, downgrade and automatic rollback remain unsupported. The dashboard renders a fixed installer command with a quoted single-use enrollment code only when the exact signed preview assets are explicitly enabled after publication and independent verification **and the canonical public origin is configured**; otherwise it renders the portable-artifact route and `runmesh enroll --server ... --code-stdin`. The dashboard does not execute host commands itself; the hosted bootstrap command includes a single-use enrollment code; a hidden local prompt remains available when the code argument is omitted. Hosted release publication remains a separately authorized operation, and the enabled Worker script remains a bootstrap trust root with the independent offline path available for higher assurance. Disabling the acknowledgement closes future hosted bootstrap but does not revoke credentials or reverse a redeemed enrollment code; those require explicit rotation/revocation.

Future protocol additions must remain explicit rather than silently changing the wire format. Future security hardening should remove the dashboard's inline `unsafe-inline` CSP requirements and add fresh-namespace, quota, log-redaction, and external-client acceptance evidence.

## Current security contract (0.1.1 unreleased candidate)

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
process arguments. The 0.1.1 production gate remains disabled until independent signed-asset
verification; development retains its disabled gate.
