# ADR-0001: Remote coding runtime architecture

- **Status:** Accepted
- **Date:** 2026-04-02

## Context

The project needs a remote coding runtime that can expose MCP tools while routing work to connected, locally persistent Runners. The runtime now includes the Worker, Runner, admin dashboard, profile-backed CLI, and real local E2E behavior while preserving a versioned Runner↔Worker wire contract.

## Decisions

1. **Stateless MCP endpoint.** The Worker uses `createMcpHandler` from the Cloudflare Agents MCP integration with the MCP server v2 package. Each MCP client receives an independent `/<secret>/mcp` URL; the Worker verifies the path secret, rewrites the request internally to the handler's exact `/mcp` route, and preserves the stateless compatibility lane.
2. **Durable Objects own connection coordination.** A `RegistryDO` locates Runners and stores SQLite metadata. Each Runner receives a `RunnerDO` that owns a hibernatable WebSocket session, preserving the connection state required to bridge requests without keeping a Worker invocation alive.
3. **Jobs persist locally.** Runners own local, persistent workspaces and job state. The Worker is a coordinator and must not become the authoritative filesystem or process-state store.
4. **Single-user self-hosted authentication.** RegistryDO stores an administrator password verifier, opaque admin sessions, per-client MCP secret verifiers, and sticky active-Runner routing state. OAuth and KV are intentionally not part of the deployed core. Runner enrollment authentication remains an independent token lane.
5. **Sticky per-client Runner routing.** `runner_list`, `runner_current`, and `runner_select` expose explicit control-plane routing. A first selection is direct; changing it requires `confirm_switch=true`. Ordinary MCP tools retain `workspace_id` where needed but no longer accept `runner_id`; the Worker resolves the selected Runner. A selected failed/unavailable Runner never silently falls back to another. The only convenience selection is an unselected client with exactly one registered Runner.
6. **Shared single-admin context.** A Job belongs to the instance/workspace domain, not to a chat session. `created_by_client_id` is audit metadata, not an ownership restriction. Clients with suitable scopes that select the same Runner share its workspace IDs and bounded Registry job history.
7. **Independent implementation.** This project reimplements its behavior and protocol independently. References are used only for behavioral study; no source is copied. Any third-party code or assets used later must have their license and attribution recorded before inclusion. A previously mentioned `codeagent` reference URL is unavailable, so it cannot be inspected or used as a source dependency.
8. **Operator-mediated local installation.** Dashboard enrollment renders public bootstrap commands and Runner service actions render manifest instructions; they do not execute host service activation. The local CLI writes managed per-user service manifests. Distribution remains operator-configured through an exact stable package spec or HTTPS tarball.

## Consequences

The runtime provides protocol negotiation, correlated `request_id` exchanges, Worker/Runner transport, Durable Object coordination, Runner enrollment, admin/client authentication, profile-backed CLI operations, sticky Runner routing, and real local E2E coverage. The Registry performs additive startup schema repairs for known older columns/tables/indexes, but there is no standalone versioned migration/downgrade tool. The dashboard renders the supported `coding-runner enroll --server ... --code ...` syntax but does not execute host commands; public bootstrap installers and hosted release artifacts remain deferred.

Future compatible protocol additions must remain explicit rather than silently changing the wire format. Future security hardening should remove the dashboard's inline `unsafe-inline` CSP requirements and add deployed migration, quota, log-redaction, and external-client acceptance evidence.
