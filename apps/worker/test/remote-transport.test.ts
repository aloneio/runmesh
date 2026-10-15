import { expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { createHttpRemoteConnector } from "../src/platform/connectors/remote-client.js";
import { boundedWireJson, guardedRemoteResponse } from "../src/platform/connectors/remote-response.js";
import { BoundedRemoteValidator } from "../src/platform/connectors/remote-validation.js";
import { parseRemoteTool } from "../src/contracts/catalog-values.js";
import { createRemoteCaller } from "../src/application/capabilities/remote-call.js";
import { buildCatalogSnapshot } from "../src/domain/capabilities/catalog.js";
import { catalogSha256 } from "../src/platform/capabilities/catalog-crypto.js";
import { RemoteFault, type RemoteConnector, type RemoteProtocol } from "../src/contracts/remote.js";
import type { ConnectionProfile } from "../src/contracts/connectors.js";

const endpoint = "https://remote.example.com/mcp";
const profile: ConnectionProfile = { schema_version: 1, profile_id: "docs", connector_id: "fixture", endpoint,
  owner: { kind: "instance_admin" }, enabled: true, revision: 2, authentication: "oauth", credential: null };
const token = "synthetic-upstream-secret";
const policy = (protocol: RemoteProtocol) => [{ endpoint, protocol }];
function upstream(bearer = token) {
  const invoked = vi.fn(async ({ value }: { value: number }) => ({ content: [{ type: "text" as const, text: String(value + 1) }], structuredContent: { value: value + 1 } }));
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "fixture", version: "1" });
    server.registerTool("increment", { description: "Increment a test value", inputSchema: z.object({ value: z.number().int() }).strict(),
      outputSchema: z.object({ value: z.number().int() }).strict() }, invoked);
    return server;
  }, { route: "/mcp", legacy: "stateless" });
  const requests: Array<{ method: string; headers: Headers; body: Record<string, unknown> }> = [];
  const http = async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); requests.push({ method: body.method, headers: new Headers(init?.headers), body });
    expect(String(url)).toBe(endpoint); expect(init?.redirect).toBe("manual"); expect(init?.credentials).toBe("omit");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${bearer}`);
    return handler.fetch(new Request(url, init));
  };
  return { invoked, requests, http };
}

it.each(["2025-11-25", "2026-07-28"] as const)("W05 official SDK exchanges real HTTP request objects in %s without Runner state", async protocol => {
  const remote = upstream(), dispatched = vi.fn(), authorize = vi.fn(async () => undefined);
  const connector = createHttpRemoteConnector({ rules: () => policy(protocol), credential: async () => ({ kind: "bearer", token }), fetch: remote.http });
  const session = await connector.open(profile, new AbortController().signal, dispatched, authorize);
  try {
    const tools = await session.listTools(); expect(tools.map(tool => tool.name)).toEqual(["increment"]);
    expect(await session.callTool(tools[0]!, { value: 2 }, authorize)).toMatchObject({ content: [{ type: "text", text: "3" }], structuredContent: { value: 3 }, isError: false });
    expect(remote.invoked).toHaveBeenCalledOnce(); expect(dispatched).toHaveBeenCalledOnce();
    expect(remote.requests.filter(request => request.method === "tools/call")).toHaveLength(1);
    for (const request of remote.requests) {
      expect(request.headers.has("cookie")).toBe(false); expect(request.headers.has("mcp-session-id")).toBe(false);
      expect(request.headers.get("mcp-protocol-version")).toBe(protocol);
      expect(request.headers.get("mcp-method")).toBe(request.method);
    }
  } finally { await session.close(); }
});

it("W05 forwards only SDK-derived SEP-2243 Mcp-Param headers for GitHub-style tools", async () => {
  const remote = upstream(), callHeaders: Headers[] = [];
  const schema = { type: "object", properties: {
    owner: { type: "string", "x-mcp-header": "owner" },
    repo: { type: "string", "x-mcp-header": "repo" },
    value: { type: "integer" },
  }, required: ["owner", "repo", "value"], additionalProperties: false };
  const connector = createHttpRemoteConnector({ rules: () => policy("2026-07-28"), credential: async () => ({ kind: "bearer", token }),
    fetch: async (input, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.method === "tools/list") {
        const response = await remote.http(input, init);
        const reply = await (await guardedRemoteResponse(response, request.id, new AbortController().signal, () => undefined)).json() as any;
        reply.result.tools = [{ name: "increment", description: "GitHub compatible", inputSchema: schema,
          outputSchema: { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false } }];
        return Response.json(reply);
      }
      if (request.method === "tools/call") {
        const headers = new Headers(init?.headers); callHeaders.push(headers);
        return Response.json({ jsonrpc: "2.0", id: request.id, result: { resultType: "complete", content: [{ type: "text", text: "3" }], structuredContent: { value: 3 }, isError: false } });
      }
      return remote.http(input, init);
    } });
  const session = await connector.open(profile, new AbortController().signal, () => undefined, async () => undefined);
  try {
    const tools = await session.listTools();
    await expect(session.callTool(tools[0]!, { owner: "aloneio", repo: "runmesh", value: 2 }, async () => undefined)).resolves.toMatchObject({ structuredContent: { value: 3 } });
    expect(callHeaders).toHaveLength(1);
    expect(callHeaders[0]!.get("mcp-param-owner")).toBe("aloneio");
    expect(callHeaders[0]!.get("mcp-param-repo")).toBe("runmesh");
    expect(callHeaders[0]!.get("authorization")).toBe(`Bearer ${token}`);
    expect(callHeaders[0]!.has("mcp-param-authorization")).toBe(false);
    expect(callHeaders[0]!.has("cookie")).toBe(false);
  } finally { await session.close(); }
});

it.each(["2025-11-25", "2026-07-28"] as const)("RM10 inspection accepts resource-only servers in %s while ordinary tool connections require tools", async protocol => {
  const methods: string[] = [];
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "resource-fixture", version: "1" });
    server.registerResource("docs", "fixture://docs", { mimeType: "text/plain" }, async uri => ({ contents: [{ uri: uri.href, text: "Reference" }] }));
    return server;
  }, { route: "/mcp", legacy: "stateless" });
  const http = async (url: string | URL, init?: RequestInit) => {
    methods.push(JSON.parse(String(init?.body)).method);
    return handler.fetch(new Request(url, init));
  };
  const ports = { rules: () => policy(protocol), credential: async () => ({ kind: "bearer" as const, token }), fetch: http };
  const dispatched = vi.fn(), authorize = vi.fn(async () => undefined);
  const session = await createHttpRemoteConnector({ ...ports, inspection: true }).open(profile, new AbortController().signal, dispatched, authorize);
  try {
    expect(session.describe?.()).toMatchObject({ protocol_version: protocol, capabilities: { tools: false, resources: true } });
  } finally { await session.close(); }
  await expect(createHttpRemoteConnector(ports).open(profile, new AbortController().signal, dispatched, authorize)).rejects.toMatchObject({ code: "upstream_protocol_error" });
  expect(methods).not.toContain("tools/list"); expect(methods).not.toContain("tools/call");
  expect(dispatched).not.toHaveBeenCalled();
});

it.each(["synthetic-upstream-secret", 'synthetic"upstream-secret', "synthetic\\upstream-secret"])("W05 direct bearer reflection is withheld for opaque token %s", async bearer => {
  for (const wire of ["json", "sse"] as const) {
    const remote = upstream(bearer), dispatched = vi.fn();
    const connector = createHttpRemoteConnector({ rules: () => policy("2026-07-28"), credential: async () => ({ kind: "bearer", token: bearer }),
      fetch: async (input, init) => {
        const request = JSON.parse(String(init?.body)), response = await remote.http(input, init);
        if (request.method !== "tools/call") return response;
        const reply = await (await guardedRemoteResponse(response, request.id, new AbortController().signal, () => undefined)).json() as { result: { content: { text: string }[] } };
        reply.result.content[0]!.text = "Reflected header: " + bearer;
        return wire === "json" ? Response.json(reply)
          : new Response("data: " + JSON.stringify(reply) + "\n\n", { headers: { "content-type": "text/event-stream" } });
      } });
    const session = await connector.open(profile, new AbortController().signal, dispatched, async () => undefined);
    try {
      const tools = await session.listTools();
      await expect(session.callTool(tools[0]!, { value: 1 }, async () => undefined)).rejects.toMatchObject({ code: "result_invalid" });
      expect(remote.invoked).toHaveBeenCalledOnce(); expect(dispatched).toHaveBeenCalledOnce();
      expect(remote.requests.filter(request => request.method === "tools/call")).toHaveLength(1);
    } finally { await session.close(); }
  }
});


it("W05 accepts a bounded GitHub-sized tools/list envelope with deep output schemas", () => {
  const leaf = { type: "string", format: "date-time" };
  let nested: unknown = leaf;
  for (let i = 0; i < 8; i++) nested = { type: "object", properties: { next: nested }, additionalProperties: false };
  const tool = { name: "fixture", inputSchema: { type: "object" }, outputSchema: nested };
  const tools = Array.from({ length: 93 }, (_, i) => ({ ...tool, name: `fixture_${i}`, description: "x".repeat(256) }));
  const raw = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools } });
  expect(raw.length).toBeLessThan(1_048_576);
  expect(boundedWireJson(raw)).toMatchObject({ result: { tools: expect.any(Array) } });
});

it("W05 wire JSON still rejects catalogs beyond the explicit structural budget", () => {
  let nested: unknown = "leaf";
  for (let i = 0; i < 40; i++) nested = { next: nested };
  expect(() => boundedWireJson(JSON.stringify({ jsonrpc: "2.0", id: 1, result: nested }))).toThrow();
});

it("W05 accepts a complete final SSE data frame that ends at EOF without a blank separator", async () => {
  const wire = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[]}}';
  const response = await guardedRemoteResponse(new Response(wire, { headers: { "content-type": "text/event-stream" } }), 1, new AbortController().signal, () => undefined);
  await expect(response.json()).resolves.toMatchObject({ id: 1, result: { content: [] } });
});

it("W05 partial SSE frames preserve Unicode and stop at the final response before EOF", async () => {
  const encoder = new TextEncoder(), stopped = vi.fn();
  const wire = encoder.encode(': heartbeat\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":1,"progress":0}}\r\n\r\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"中文"}]}}\r\n\r\n');
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { if (offset < wire.length) controller.enqueue(wire.slice(offset, offset += 3)); }, cancel: stopped });
  const response = await guardedRemoteResponse(new Response(stream, { headers: { "content-type": "text/event-stream" } }), 1, new AbortController().signal, () => undefined);
  expect(await response.json()).toMatchObject({ result: { content: [{ text: "中文" }] } }); expect(stopped).toHaveBeenCalled();
});

it.each([
  '{"jsonrpc":"2.0","id":2,"result":{"content":[]}}',
  '{"jsonrpc":"2.0","id":1,"method":"sampling/createMessage","params":{}}',
  '{"jsonrpc":"2.0","id":1,"result":{"resultType":"input_required","inputRequests":{}}}',
  '{"jsonrpc":"2.0","id":1,"result":{"task":{"taskId":"opaque"}}}',
])("W05 rejects mismatched, interactive and task responses without evaluating their content", async text => {
  await expect(guardedRemoteResponse(new Response(text, { headers: { "content-type": "application/json" } }), 1, new AbortController().signal, () => undefined)).rejects.toBeInstanceOf(RemoteFault);
});

it.each([401, 403, 429, 500, 302, 307])("W05 HTTP %s after a tool dispatch preserves the recovery category without retrying", async status => {
  const remote = upstream(), attempts = vi.fn(), sent = vi.fn();
  const connector = createHttpRemoteConnector({ rules: () => policy("2026-07-28"), credential: async () => ({ kind: "bearer", token }),
    fetch: async (input, init) => {
      if (JSON.parse(String(init?.body)).method === "tools/call") { attempts(); return new Response("untrusted-error", { status, headers: { location: "https://other.example.com/private", "www-authenticate": "Bearer resource_metadata=\"https://other.example.com/oauth\"" } }); }
      return remote.http(input, init);
    } });
  const session = await connector.open(profile, new AbortController().signal, sent, async () => undefined);
  try {
    const tools = await session.listTools();
    await expect(session.callTool(tools[0]!, { value: 1 }, async () => undefined)).rejects.toMatchObject({
      code: status === 401 ? "authorization_required" : status === 403 ? "permission_denied" : status === 429 || status >= 500 ? "upstream_unavailable" : "upstream_protocol_error",
    });
    expect(attempts).toHaveBeenCalledOnce(); expect(sent).toHaveBeenCalledOnce();
  } finally { await session.close(); }
});

it.each([
  { errorCode: -32603, expected: "upstream_unavailable" },
  { errorCode: -32001, expected: "upstream_unavailable" },
  { errorCode: -32601, expected: "upstream_protocol_error" },
  { errorCode: -32022, expected: "upstream_protocol_error" },
] as const)("W05 valid JSON-RPC error $errorCode from tools/list maps to $expected without retry", async ({ errorCode, expected }) => {
  const remote = upstream(), attempts = vi.fn(), sent = vi.fn();
  const connector = createHttpRemoteConnector({ rules: () => policy("2026-07-28"), credential: async () => ({ kind: "bearer", token }),
    fetch: async (input, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.method === "tools/list") {
        attempts();
        return Response.json({ jsonrpc: "2.0", id: request.id, error: { code: errorCode, message: "synthetic provider error" } });
      }
      return remote.http(input, init);
    } });
  const session = await connector.open(profile, new AbortController().signal, sent, async () => undefined);
  try {
    await expect(session.listTools()).rejects.toMatchObject({ code: expected });
    expect(attempts).toHaveBeenCalledOnce();
    expect(sent).not.toHaveBeenCalled();
  } finally { await session.close(); }
});

it("W05 valid provider InternalError after tools/call is availability evidence and is never replayed", async () => {
  const remote = upstream(), attempts = vi.fn(), sent = vi.fn();
  const connector = createHttpRemoteConnector({ rules: () => policy("2026-07-28"), credential: async () => ({ kind: "bearer", token }),
    fetch: async (input, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.method === "tools/call") {
        attempts();
        return Response.json({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "synthetic provider limit" } });
      }
      return remote.http(input, init);
    } });
  const session = await connector.open(profile, new AbortController().signal, sent, async () => undefined);
  try {
    const tools = await session.listTools();
    await expect(session.callTool(tools[0]!, { value: 1 }, async () => undefined)).rejects.toMatchObject({ code: "upstream_unavailable" });
    expect(attempts).toHaveBeenCalledOnce();
    expect(sent).toHaveBeenCalledOnce();
    expect(remote.invoked).not.toHaveBeenCalled();
  } finally { await session.close(); }
});

it.each([401, 403])("W05 HTTP %s during connection and discovery preserves authentication versus permission denial", async status => {
  for (const protocol of ["2025-11-25", "2026-07-28"] as const) {
    for (const method of [protocol === "2025-11-25" ? "initialize" : "server/discover", "tools/list"]) {
      const remote = upstream(), attempts = vi.fn(), sent = vi.fn(), cancelled = vi.fn();
      const connector = createHttpRemoteConnector({ rules: () => policy(protocol), credential: async () => ({ kind: "bearer", token }),
        fetch: async (input, init) => {
          if (JSON.parse(String(init?.body)).method === method) {
            attempts(); return new Response(new ReadableStream({ cancel: cancelled }), { status,
              headers: { "www-authenticate": 'Bearer resource_metadata="https://unvisited.example.com/oauth"' } });
          }
          return remote.http(input, init);
        } });
      if (method === "tools/list") {
        const session = await connector.open(profile, new AbortController().signal, sent, async () => undefined);
        try { await expect(session.listTools()).rejects.toMatchObject({ code: status === 401 ? "authorization_required" : "permission_denied" }); }
        finally { await session.close(); }
      } else {
        await expect(connector.open(profile, new AbortController().signal, sent, async () => undefined)).rejects.toMatchObject({ code: status === 401 ? "authorization_required" : "permission_denied" });
      }
      expect(attempts).toHaveBeenCalledOnce(); expect(cancelled).toHaveBeenCalledOnce();
      expect(sent).not.toHaveBeenCalled(); expect(remote.invoked).not.toHaveBeenCalled();
    }
  }
});

it("W05 final authorization refusal does not release a tool request to fetch", async () => {
  const remote = upstream(), sent = vi.fn();
  const connector = createHttpRemoteConnector({ rules: () => policy("2026-07-28"), credential: async () => ({ kind: "bearer", token }), fetch: remote.http });
  const session = await connector.open(profile, new AbortController().signal, sent, async () => undefined);
  try {
    const tools = await session.listTools();
    await expect(session.callTool(tools[0]!, { value: 1 }, async () => { throw new RemoteFault("permission_denied"); })).rejects.toMatchObject({ code: "permission_denied" });
    expect(sent).not.toHaveBeenCalled(); expect(remote.requests.some(request => request.method === "tools/call")).toBe(false);
  } finally { await session.close(); }
});

it("W05 a session-bearing server is explicitly unsupported instead of sharing its session", async () => {
  const remote = upstream(), http = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const response = await remote.http(input, init), headers = new Headers(response.headers); headers.set("mcp-session-id", "private-session");
    return new Response(response.body, { status: response.status, headers });
  });
  const connector = createHttpRemoteConnector({ rules: () => policy("2026-07-28"), credential: async () => ({ kind: "bearer", token }), fetch: http });
  await expect(connector.open(profile, new AbortController().signal, () => undefined, async () => undefined)).rejects.toMatchObject({ code: "upstream_protocol_error" });
  expect(http).toHaveBeenCalledOnce();
});

it("W05 a negotiated modern MCP may establish one operation-scoped session during server/discover", async () => {
  const remote = upstream(), seen: Array<{ method: string; session: string | null }> = [], sessionId = "modern-private-session";
  const http = vi.fn(async (input: string | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      seen.push({ method: "DELETE", session: new Headers(init.headers).get("mcp-session-id") });
      return new Response(null, { status: 204 });
    }
    const request = JSON.parse(String(init?.body)), session = new Headers(init?.headers).get("mcp-session-id");
    seen.push({ method: request.method, session });
    const response = await remote.http(input, init), headers = new Headers(response.headers);
    if (request.method === "server/discover" || session !== null) headers.set("mcp-session-id", sessionId);
    return new Response(response.body, { status: response.status, headers });
  });
  const connector = createHttpRemoteConnector({ rules: () => [{ endpoint, protocol: "2025-11-25" as const, session: "optional" as const, negotiate: true as const }],
    credential: async () => ({ kind: "bearer", token }), fetch: http });
  const session = await connector.open(profile, new AbortController().signal, () => undefined, async () => undefined);
  try { expect((await session.listTools()).map(tool => tool.name)).toEqual(["increment"]); } finally { await session.close(); }
  expect(seen[0]).toEqual({ method: "server/discover", session: null });
  expect(seen.some(value => value.method === "tools/list" && value.session === sessionId)).toBe(true);
  expect(seen.at(-1)).toEqual({ method: "DELETE", session: sessionId });
});

it("W05 normalizes an empty 204 initialized notification response for legacy HTTP servers", async () => {
  const remote = upstream();
  const connector = createHttpRemoteConnector({ rules: () => policy("2025-11-25"), credential: async () => ({ kind: "bearer", token }),
    fetch: async (input, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.method === "notifications/initialized") { await remote.http(input, init); return new Response(null, { status: 204 }); }
      return remote.http(input, init);
    } });
  const session = await connector.open(profile, new AbortController().signal, () => undefined, async () => undefined);
  try { expect((await session.listTools()).map(tool => tool.name)).toEqual(["increment"]); } finally { await session.close(); }
});

it.each(["length", "stream", "depth", "utf8", "empty-fragments"])("W05 rejects %s overflow and cancels the untrusted response", async reason => {
  const stopped = vi.fn(), encoder = new TextEncoder(); let response: Response;
  if (reason === "length") response = new Response(new ReadableStream({ cancel: stopped }), { headers: { "content-type": "application/json", "content-length": "1048577" } });
  else if (reason === "stream") response = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1048577)); }, cancel: stopped }), { headers: { "content-type": "application/json" } });
  else if (reason === "depth") response = new Response('{"jsonrpc":"2.0","id":1,"result":' + '['.repeat(40) + '0' + ']'.repeat(40) + '}', { headers: { "content-type": "application/json" } });
  else if (reason === "utf8") response = new Response(new Uint8Array([255]), { headers: { "content-type": "application/json" } });
  else response = new Response(new ReadableStream({ pull(c) { c.enqueue(encoder.encode("")); }, cancel: stopped }), { headers: { "content-type": "text/event-stream" } });
  await expect(guardedRemoteResponse(response, 1, new AbortController().signal, () => undefined)).rejects.toThrow();
  if (["length", "stream", "empty-fragments"].includes(reason)) expect(stopped).toHaveBeenCalled();
});

it("W05 cancellation ends a stalled stream without waiting for its cancel promise", async () => {
  const controller = new AbortController(), stopped = vi.fn(() => new Promise<void>(() => undefined));
  const response = new Response(new ReadableStream({ cancel: stopped }), { headers: { "content-type": "text/event-stream" } });
  const pending = guardedRemoteResponse(response, 1, controller.signal, () => undefined);
  controller.abort(); await expect(pending).rejects.toMatchObject({ code: "operation_timed_out" }); expect(stopped).toHaveBeenCalledOnce();
});
it("discovery HTTP evidence retains the response byte and fragment budgets", async () => {
  for (const declared of [true, false]) {
    const cancelled = vi.fn(), account = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(1_048_577)); }, cancel: cancelled,
    }), { status: 400, headers: declared ? { "content-length": "1048577" } : {} });
    await expect(guardedRemoteResponse(response, 1, new AbortController().signal, account, true)).rejects.toMatchObject({ code: "upstream_protocol_error" });
    expect(cancelled).toHaveBeenCalledOnce(); expect(account).toHaveBeenCalledTimes(declared ? 0 : 1);
  }
  const cancelled = vi.fn();
  await expect(guardedRemoteResponse(new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array()); }, cancel: cancelled,
  }), { status: 400 }), 1, new AbortController().signal, () => undefined, true)).rejects.toMatchObject({ code: "upstream_protocol_error" });
  expect(cancelled).toHaveBeenCalledOnce();
});
it("discovery HTTP evidence cancellation settles even when peer cleanup stalls", async () => {
  const controller = new AbortController(), cancelled = vi.fn(() => new Promise<void>(() => undefined));
  const response = new Response(new ReadableStream({ cancel: cancelled }), { status: 400 });
  const pending = guardedRemoteResponse(response, 1, controller.signal, () => undefined, true);
  controller.abort(); await expect(pending).rejects.toMatchObject({ code: "operation_timed_out" }); expect(cancelled).toHaveBeenCalledOnce();
  await expect(guardedRemoteResponse(new Response(null, { status: 400 }), 1, controller.signal, () => undefined, true)).rejects.toMatchObject({ code: "operation_timed_out" });
});

it("W05 disallowed destinations never load credentials or make network requests", async () => {
  const secret = vi.fn(async () => ({ kind: "bearer" as const, token })), http = vi.fn();
  const connector = createHttpRemoteConnector({ rules: () => policy("2026-07-28"), credential: secret, fetch: http });
  await expect(connector.open({ ...profile, endpoint: "https://other.example.com/mcp" }, new AbortController().signal, () => undefined, async () => undefined)).rejects.toMatchObject({ code: "egress_denied" });
  expect(secret).not.toHaveBeenCalled(); expect(http).not.toHaveBeenCalled();
});

it("W05 accepts SEP-2243 MCP parameter annotations without weakening schema validation", () => {
  const validator = new BoundedRemoteValidator();
  const schema = { type: "object", properties: {
    owner: { type: "string", minLength: 1, "x-mcp-header": "owner" },
    repo: { type: "string", "x-mcp-header": "repo" },
    updated_at: { type: "string", format: "date-time" },
  }, required: ["owner", "repo"], additionalProperties: false };
  expect(parseRemoteTool({ name: "github_compatible", inputSchema: schema })).toBeDefined();
  expect(validator.validate(schema, { owner: "aloneio", repo: "runmesh", updated_at: "2026-10-15T00:00:00Z" })).toBe(true);
  expect(validator.validate(schema, { owner: "", repo: "runmesh", updated_at: "not-a-date" })).toBe(false);
  expect(parseRemoteTool({ name: "bad_header", inputSchema: { type: "object", properties: { value: { type: "string", "x-mcp-header": "bad header" } } } })).toBeUndefined();
  expect(parseRemoteTool({ name: "bad_header_location", inputSchema: { type: "object", properties: { values: { type: "array", items: { type: "string", "x-mcp-header": "item" } } } } })).toBeUndefined();
});

it("W05 validates the fixed Cloudflare identity pattern while keeping arbitrary regex schemas outside the admitted subset", () => {
  const validator = new BoundedRemoteValidator();
  const schema = { type: "object", properties: { id: { type: "string", minLength: 1, pattern: "\\S" } }, required: ["id"], additionalProperties: false };
  expect(validator.validate(schema, { id: "user:abc" })).toBe(true);
  expect(validator.validate(schema, { id: "   " })).toBe(false);
  expect(validator.validate({ type: "object", properties: { id: { type: "string", pattern: "(a+)+$" } } }, { id: "a" })).toBe(false);
});

it("W05 JSON schema validation is non-coercing, bounded and supports approved local references", () => {
  const validator = new BoundedRemoteValidator();
  const schema = { type: "object", properties: { value: { $ref: "#/$defs/count" } }, required: ["value"], additionalProperties: false,
    $defs: { count: { type: "integer", minimum: 1 } } };
  expect(validator.validate(schema, { value: 2 })).toBe(true);
  expect(validator.validate(schema, { value: "2" })).toBe(false);
  expect(validator.validate(schema, { value: 0 })).toBe(false);
  expect(validator.validate(schema, { value: 2, extra: true })).toBe(false);
  expect(validator.validate({ type: "string", pattern: "(a+)+$" }, "a")).toBe(false);
  expect(validator.validate({ type: "object", $ref: "https://unvisited.example.com/schema" }, {})).toBe(false);
});

it.each(["toString", "constructor", "__proto__", "hasOwnProperty"])("W05 schema object keywords only consider own JSON properties: %s", key => {
  const validator = new BoundedRemoteValidator(), own = { [key]: 1 };
  const schema = { type: "object", properties: { [key]: { type: "integer" } }, additionalProperties: false };
  expect(validator.validate(schema, {})).toBe(true);
  expect(validator.validate({ ...schema, required: [key] }, {})).toBe(false);
  expect(validator.validate({ ...schema, required: [key] }, own)).toBe(true);
  expect(validator.validate({ ...schema, required: [key] }, { [key]: "1" })).toBe(false);
  expect(validator.validate({ type: "object", dependentRequired: { [key]: ["value"] } }, {})).toBe(true);
  expect(validator.validate({ type: "object", dependentRequired: { [key]: ["value"] } }, own)).toBe(false);
  expect(validator.validate({ type: "object", dependentRequired: { value: [key] } }, { value: 1 })).toBe(false);
  expect(validator.validate({ type: "object", dependentRequired: { value: [key] } }, { value: 1, ...own })).toBe(true);
  const dependent = { type: "object", dependentSchemas: { [key]: { required: ["value"] } } };
  expect(validator.validate(dependent, {})).toBe(true);
  expect(validator.validate(dependent, own)).toBe(false);
  expect(validator.validate(dependent, { ...own, value: 1 })).toBe(true);
});

it.each([
  { minimum: undefined, value: [], valid: false },
  { minimum: undefined, value: ["none"], valid: false },
  { minimum: undefined, value: [1, "none"], valid: true },
  { minimum: undefined, value: [1, 2], valid: true },
  { minimum: undefined, value: [1, 2, 3], valid: false },
  { minimum: 0, value: [], valid: true },
  { minimum: 0, value: ["none"], valid: true },
  { minimum: 2, value: [1, "none"], valid: false },
  { minimum: 2, value: [1, 2, "none"], valid: true },
])("W05 contains applies its default minimum through escaped references: %j", ({ minimum, value, valid }) => {
  const definition = { type: "array", contains: { type: "integer" }, maxContains: 2, ...(minimum === undefined ? {} : { minContains: minimum }) };
  const schema = { type: "object", properties: { values: { $ref: "#/$defs/items~1~0" } }, $defs: { "items/~": definition } };
  expect(parseRemoteTool({ name: "contains", inputSchema: schema })).toBeDefined();
  expect(new BoundedRemoteValidator().validate(schema, { values: value })).toBe(valid);
  expect(Object.hasOwn(definition, "minContains")).toBe(minimum !== undefined);
});

it("W05 schema preparation preserves literal data and caller-owned objects", () => {
  const literal = { contains: true, maxContains: 2 }, schema = { type: "object", const: literal, default: literal, examples: [literal] };
  const before = JSON.stringify(schema), value = { contains: true, maxContains: 2 };
  expect(new BoundedRemoteValidator().validate(schema, value)).toBe(true);
  expect(new BoundedRemoteValidator().validate({ type: "array", uniqueItems: true }, [value, { ...value }])).toBe(false);
  expect(JSON.stringify(schema)).toBe(before); expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
});

it("W05 required and contains retain their meaning inside combinators and boolean schemas", () => {
  const validator = new BoundedRemoteValidator(), array = { type: "array", contains: { type: "integer" }, maxContains: 2 };
  expect(validator.validate({ type: "object", not: { required: ["toString"] } }, {})).toBe(true);
  expect(validator.validate({ type: "object", not: { required: ["toString"] } }, { toString: 1 })).toBe(false);
  expect(validator.validate({ type: "object", properties: { value: { anyOf: [array, { type: "string" }] } } }, { value: [] })).toBe(false);
  expect(validator.validate({ type: "object", properties: { value: { anyOf: [array, { type: "string" }] } } }, { value: "text" })).toBe(true);
  expect(validator.validate({ type: "object", properties: { value: { not: array } } }, { value: [] })).toBe(true);
  expect(validator.validate({ type: "array", contains: true, maxContains: 0 }, [])).toBe(false);
  expect(validator.validate({ type: "array", contains: false, minContains: 0, maxContains: 0 }, [1])).toBe(true);
});

it.each([
  { name: "required", schema: { type: "object", required: ["toString"] }, invalid: {}, valid: { toString: "owned" } },
  { name: "contains", schema: { type: "object", required: ["values"], properties: { values: { type: "array", contains: { type: "integer" }, maxContains: 2 } } },
    invalid: { values: ["none"] }, valid: { values: [1] } },
])("W05 admitted $name constraints guard both dispatch and returned structured content", async ({ schema, invalid, valid }) => {
  const validator = new BoundedRemoteValidator(), definition = parseRemoteTool({ name: "probe", inputSchema: schema, outputSchema: schema })!;
  const snapshot = (await buildCatalogSnapshot(profile, [definition], catalogSha256, () => false))!;
  const head = { schema_version: 1 as const, profile_id: profile.profile_id, revision: 1,
    observed_digest: snapshot.digest, approved_digest: snapshot.digest, approved_names: [definition.name] };
  const principal = { client_id: "validation-test", secret_version: 1 };
  let output: unknown = invalid;
  const dispatched = vi.fn(), open = vi.fn<RemoteConnector["open"]>(async (_profile, _signal, sent) => ({
    current: () => true, listTools: async () => [definition],
    callTool: async (_tool, _args, before) => { await before(); dispatched(); sent(); return { content: [], structuredContent: output, isError: false }; },
    close: async () => undefined,
  }));
  const caller = createRemoteCaller({ repository: { readHead: () => head, readSnapshot: () => snapshot }, profile: () => profile,
    digest: catalogSha256, identity: async () => ({ state: "allowed", identity: { schema_version: 2, ...principal, label: "Validation", native_scopes: [] } }),
    connector: { validate: (candidate, value) => validator.validate(candidate, value), open } });
  const tool = snapshot.tools[0]!, call = (args: unknown) => caller(principal,
    { profile_id: profile.profile_id, tool_id: tool.tool_id, version: tool.version, arguments: args }, new AbortController().signal);
  expect(await call(invalid)).toMatchObject({ state: "failed", code: "invalid_arguments", operation_state: "not_started" });
  expect(open).not.toHaveBeenCalled(); expect(dispatched).not.toHaveBeenCalled();
  expect(await call(valid)).toMatchObject({ state: "failed", code: "result_invalid" }); expect(dispatched).toHaveBeenCalledTimes(1);
  output = valid;
  expect(await call(valid)).toMatchObject({ state: "completed", result: { structuredContent: valid } });
  expect(dispatched).toHaveBeenCalledTimes(2);
});

it.each(["allOf", "anyOf", "oneOf", "prefixItems"])("W05 published local references traverse %s schema arrays during validation", keyword => {
  const schema = { type: "object", properties: { value: { $ref: "#/$defs/count/" + keyword + "/0" } }, required: ["value"],
    $defs: { count: { [keyword]: [{ type: "integer", minimum: 1 }] } } };
  expect(parseRemoteTool({ name: "count", inputSchema: schema, outputSchema: schema })).toBeDefined();
  const validator = new BoundedRemoteValidator();
  expect(validator.validate(schema, { value: 2 })).toBe(true);
  expect(validator.validate(schema, { value: "2" })).toBe(false);
  expect(validator.validate(schema, { value: 0 })).toBe(false);
});

it.each(["01", "1", "-", "length"])("W05 schema array references reject an invalid index %s", index => {
  const schema = { type: "object", properties: { value: { $ref: "#/$defs/count/allOf/" + index } },
    $defs: { count: { allOf: [{ type: "integer" }] } } };
  expect(parseRemoteTool({ name: "count", inputSchema: schema })).toBeUndefined();
  expect(new BoundedRemoteValidator().validate(schema, { value: 2 })).toBe(false);
});

it("W05 indexed local references retain the expanded schema work budget", () => {
  const definitions: Record<string, object> = { layer0: { allOf: [{ type: "integer" }] } };
  for (let i = 1; i <= 20; i++) {
    const ref = { $ref: "#/$defs/layer" + (i - 1) + "/allOf/0" };
    definitions["layer" + i] = { allOf: [{ allOf: [ref, ref] }] };
  }
  const schema = { type: "object", properties: { value: { $ref: "#/$defs/layer20/allOf/0" } }, $defs: definitions };
  expect(parseRemoteTool({ name: "count", inputSchema: schema })).toBeDefined();
  expect(new BoundedRemoteValidator().getValidator(schema)({ value: 2 })).toMatchObject({ valid: false, errorMessage: "remote_schema_budget" });
});

it.each(["2025-11-25", "2026-07-28"] as const)("W05 %s calls a discovered tool with indexed local input and output references once", async protocol => {
  const remote = upstream(), dispatched = vi.fn(), authorize = vi.fn(async () => undefined);
  const schema = { type: "object", properties: { value: { $ref: "#/$defs/count/allOf/0" } }, required: ["value"],
    $defs: { count: { allOf: [{ type: "integer", minimum: 1 }] } } };
  const connector = createHttpRemoteConnector({ rules: () => policy(protocol), credential: async () => ({ kind: "bearer", token }),
    fetch: async (input, init) => {
      const request = JSON.parse(String(init?.body));
      const response = await remote.http(input, init);
      if (request.method !== "tools/list") return response;
      const reply = await (await guardedRemoteResponse(response, request.id, new AbortController().signal, () => undefined)).json() as { result: { tools: unknown[] } };
      reply.result.tools = [{ name: "increment", inputSchema: schema, outputSchema: schema }];
      return Response.json(reply);
    } });
  expect(connector.validate(schema, { value: 2 })).toBe(true);
  expect(connector.validate(schema, { value: "2" })).toBe(false);
  const session = await connector.open(profile, new AbortController().signal, dispatched, authorize);
  try {
    const tools = await session.listTools();
    expect(tools).toHaveLength(1);
    expect(await session.callTool(tools[0]!, { value: 2 }, authorize)).toMatchObject({ isError: false, structuredContent: { value: 3 } });
    expect(remote.invoked).toHaveBeenCalledOnce(); expect(dispatched).toHaveBeenCalledOnce();
  } finally { await session.close(); }
});
