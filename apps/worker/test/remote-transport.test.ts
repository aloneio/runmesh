import { expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { createHttpRemoteConnector } from "../src/platform/connectors/remote-client.js";
import { guardedRemoteResponse } from "../src/platform/connectors/remote-response.js";
import { BoundedRemoteValidator } from "../src/platform/connectors/remote-validation.js";
import { RemoteFault, type RemoteProtocol } from "../src/contracts/remote.js";
import type { ConnectionProfile } from "../src/contracts/connectors.js";

const endpoint = "https://remote.example.com/mcp";
const profile: ConnectionProfile = { schema_version: 1, profile_id: "docs", connector_id: "fixture", endpoint,
  owner: { kind: "instance_admin" }, enabled: true, revision: 2, credential: { secret_id: "docs", secret_version: 1 } };
const token = "synthetic-upstream-secret";
const policy = (protocol: RemoteProtocol) => JSON.stringify({ schema_version: 1, endpoints: [{ endpoint, protocol }] });
function upstream() {
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
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
    return handler.fetch(new Request(url, init));
  };
  return { invoked, requests, http };
}

it.each(["2025-11-25", "2026-07-28"] as const)("W05 official SDK exchanges real HTTP request objects in %s without Runner state", async protocol => {
  const remote = upstream(), dispatched = vi.fn(), authorize = vi.fn(async () => undefined);
  const connector = createHttpRemoteConnector({ policy: () => policy(protocol), credential: async () => ({ kind: "bearer", token }), fetch: remote.http });
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

it.each([401, 403, 429, 500, 302, 307])("W05 HTTP %s after a tool dispatch never retries or follows authentication redirects", async status => {
  const remote = upstream(), attempts = vi.fn(), sent = vi.fn();
  const connector = createHttpRemoteConnector({ policy: () => policy("2026-07-28"), credential: async () => ({ kind: "bearer", token }),
    fetch: async (input, init) => {
      if (JSON.parse(String(init?.body)).method === "tools/call") { attempts(); return new Response("untrusted-error", { status, headers: { location: "https://other.example.com/private", "www-authenticate": "Bearer resource_metadata=\"https://other.example.com/oauth\"" } }); }
      return remote.http(input, init);
    } });
  const session = await connector.open(profile, new AbortController().signal, sent, async () => undefined);
  try {
    const tools = await session.listTools();
    await expect(session.callTool(tools[0]!, { value: 1 }, async () => undefined)).rejects.toBeInstanceOf(RemoteFault);
    expect(attempts).toHaveBeenCalledOnce(); expect(sent).toHaveBeenCalledOnce();
  } finally { await session.close(); }
});

it("W05 final authorization refusal does not release a tool request to fetch", async () => {
  const remote = upstream(), sent = vi.fn();
  const connector = createHttpRemoteConnector({ policy: () => policy("2026-07-28"), credential: async () => ({ kind: "bearer", token }), fetch: remote.http });
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
  const connector = createHttpRemoteConnector({ policy: () => policy("2026-07-28"), credential: async () => ({ kind: "bearer", token }), fetch: http });
  await expect(connector.open(profile, new AbortController().signal, () => undefined, async () => undefined)).rejects.toMatchObject({ code: "upstream_protocol_error" });
  expect(http).toHaveBeenCalledOnce();
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

it("W05 disallowed destinations never load credentials or make network requests", async () => {
  const secret = vi.fn(async () => ({ kind: "bearer" as const, token })), http = vi.fn();
  const connector = createHttpRemoteConnector({ policy: () => policy("2026-07-28"), credential: secret, fetch: http });
  await expect(connector.open({ ...profile, endpoint: "https://other.example.com/mcp" }, new AbortController().signal, () => undefined, async () => undefined)).rejects.toMatchObject({ code: "egress_denied" });
  expect(secret).not.toHaveBeenCalled(); expect(http).not.toHaveBeenCalled();
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
