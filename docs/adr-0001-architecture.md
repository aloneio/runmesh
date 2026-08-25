# ADR-0001: Remote coding runtime architecture

- **Status:** Accepted
- **Date:** 2026-04-02

## Context

The project needs a remote coding runtime that can expose MCP tools while
routing work to connected, locally persistent runners. The first milestone
establishes only the versioned Runner↔Worker wire contract; it deliberately
does not implement the Worker or Runner runtime.

## Decisions

1. **Stateless MCP endpoint.** The Worker uses `createMcpHandler` from the
   Cloudflare Agents MCP integration with the MCP server v2 package. Each MCP
   client receives an independent `/<secret>/mcp` URL; the Worker verifies the
   path secret, rewrites the request internally to the handler's exact `/mcp`
   route, and preserves the stateless legacy compatibility lane.
2. **Durable Objects own connection coordination.** A `RegistryDO` will locate
   runners and route requests. Each runner receives a `RunnerDO` that owns a
   hibernatable WebSocket session, preserving the connection state required to
   bridge requests without keeping a Worker invocation alive.
3. **Jobs persist locally.** Runners own local, persistent workspaces and job
   state. The Worker is a coordinator and must not become the authoritative
   filesystem or process-state store.
4. **Single-user self-hosted authentication.** RegistryDO stores an
   administrator password verifier, opaque admin sessions, and per-client MCP
   secret verifiers. OAuth and KV are intentionally not part of the deployed
   core. Runner enrollment authentication remains an independent token lane.
5. **Independent implementation.** This project reimplements its behavior and
   protocol independently. References are used only for behavioral study; no
   source is copied. Any third-party code or assets used later must have their
   license and attribution recorded before inclusion. A previously mentioned
   `codeagent` reference URL is unavailable, so it cannot be inspected or used
   as a source dependency.

## Consequences

The first milestone originally provided a dependency-light JSON wire protocol
and checked-in JSON Schema; the implemented runtime now adds the Worker,
Durable Objects, Runner, admin/client authentication, and real E2E while
preserving protocol negotiation and correlated `request_id` exchanges. Future
compatible additions must remain explicit rather than silently changing the
wire format.
