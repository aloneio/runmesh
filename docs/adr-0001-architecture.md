# ADR-0001: Remote coding runtime architecture

- **Status:** Accepted
- **Date:** 2026-04-02

## Context

The project needs a remote coding runtime that can expose MCP tools while
routing work to connected, locally persistent runners. The first milestone
establishes only the versioned Runner↔Worker wire contract; it deliberately
does not implement the Worker or Runner runtime.

## Decisions

1. **Stateless MCP endpoint.** The Worker will serve `/mcp` with
   `createMcpHandler` from `@modelcontextprotocol/server` v2. It will retain
   legacy compatibility during migration so existing MCP clients continue to
   work while the v2 handler is adopted.
2. **Durable Objects own connection coordination.** A `RegistryDO` will locate
   runners and route requests. Each runner receives a `RunnerDO` that owns a
   hibernatable WebSocket session, preserving the connection state required to
   bridge requests without keeping a Worker invocation alive.
3. **Jobs persist locally.** Runners own local, persistent workspaces and job
   state. The Worker is a coordinator and must not become the authoritative
   filesystem or process-state store.
4. **Independent implementation.** This project reimplements its behavior and
   protocol independently. References are used only for behavioral study; no
   source is copied. Any third-party code or assets used later must have their
   license and attribution recorded before inclusion. A previously mentioned
   `codeagent` reference URL is unavailable, so it cannot be inspected or used
   as a source dependency.

## Consequences

Milestone 1 provides a dependency-light JSON wire protocol and a checked-in
JSON Schema artifact that non-TypeScript runners can consume. Later milestones
must preserve protocol negotiation, use `request_id` for correlated exchanges,
and extend compatible major versions rather than silently changing the wire
format. This ADR does not authorize Worker, Durable Object, WebSocket, MCP, or
Runner runtime implementation.
