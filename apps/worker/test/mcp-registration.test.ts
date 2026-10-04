import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, expect, it, vi } from "vitest";
import { handleMcpSecret } from "../src/http/mcp.js";
import { MCP_TOOL_NAMES } from "../src/mcp/server.js";
import type { WorkerEnv } from "../src/platform/env.js";
import { createMcpWorkerDiagnosticForwarder, mcpWorkerFailureEvidence } from "../../../scripts/mcp-diagnostics.mjs";
import * as mcpResponse from "../src/http/mcp-response.js";

afterEach(() => vi.restoreAllMocks());

function fixture(central = true, scopes: string[] = ["coding:read"], clientId = "registration-client") {
  const identity = { schema_version: 2, client_id: clientId, label: clientId, secret_version: 1, native_scopes: scopes };
  const registry = vi.fn(async () => Response.json(identity));
  const principals: string[] = [];
  const port = {
    toolVisibility: async () => ({ state: "visible", skill: true, remote: true }),
    listSkills: async (principal: { client_id: string }) => { principals.push(principal.client_id); return { state: "listed", skills: [], next_after: null }; },
    listRemoteProfiles: async () => ({ state: "listed", profiles: [] }),
    listCatalog: async () => ({ state: "listed", tools: [], next_cursor: null }),
  };
  const config = { INTERNAL_CONTROL_SECRET: "synthetic-registration-test-secret-0123456789",
    CENTRAL_SKILLS_ENABLED: "1", REGISTRY: { idFromName: () => "registry", get: () => ({ fetch: registry }) },
    ...(central ? { CAPABILITIES: { idFromName: () => "central", get: () => port } } : {}),
  } as unknown as WorkerEnv;
  async function rpc(method: string, params: unknown = {}) {
    const response = await rpcBody(JSON.stringify({ jsonrpc: "2.0", id: clientId, method, params }));
    expect(response.status).toBe(200);
    const raw = await response.text();
    const values = response.headers.get("content-type")?.includes("text/event-stream")
      ? raw.split(String.fromCharCode(10)).filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)))
      : [JSON.parse(raw)];
    const value = values.find(message => message.id === clientId);
    expect(value).toBeDefined();
    return value;
  }
  function rpcBody(body: string, signal?: AbortSignal) {
    const request = new Request("https://worker.test/" + "a".repeat(43) + "/mcp", { method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body, signal });
    return handleMcpSecret(request, config, new URL(request.url));
  }
  return { rpc, rpcBody, registry, principals };
}

it.each([
  ["identity", "Network connection lost.", "network_connection_lost"],
  ["identity", "Network connection lost. private-token", "unknown"],
  ["response", "Network connection lost.", "network_connection_lost"],
  ["response", "private-response-token", "unknown"],
] as const)("preserves an escaping %s failure and records only its fixed outer boundary", async (boundary, message, reason) => {
  const f = fixture(false), lines: string[] = [];
  const error = new Error(message); error.stack = "private-stack-and-token";
  const forward = createMcpWorkerDiagnosticForwarder((line: string) => lines.push(line));
  const log = vi.spyOn(console, "warn").mockImplementation((line: unknown) => { forward(String(line) + "\n"); });
  if (boundary === "identity") vi.spyOn(crypto.subtle, "digest").mockRejectedValueOnce(error);
  else vi.spyOn(mcpResponse, "primeMcpResponse").mockImplementationOnce(async response => {
    // Finish the real SDK stream before injecting the response-boundary error.
    await response.text();
    throw error;
  });
  await expect(f.rpcBody(JSON.stringify({ jsonrpc: "2.0", id: 123, method: "tools/call", params: { name: "read", arguments: {} } }))).rejects.toBe(error);
  expect(f.registry).toHaveBeenCalledTimes(boundary === "identity" ? 0 : 1);
  expect(log).toHaveBeenCalledOnce();
  expect(mcpWorkerFailureEvidence(lines.join(""))).toEqual([{ event: "mcp_handler_error", kind: "error",
    stage: boundary === "identity" ? "identity_verification" : "response_priming", reason }]);
  expect(JSON.stringify(log.mock.calls)).not.toContain("private");
});

it("preserves the original escaping error when the diagnostic logger fails", async () => {
  const f = fixture(false), error = new Error("Network connection lost.");
  vi.spyOn(crypto.subtle, "digest").mockRejectedValueOnce(error);
  const log = vi.spyOn(console, "warn").mockImplementation(() => { throw new Error("private-logger-failure"); });
  await expect(f.rpcBody(JSON.stringify({ jsonrpc: "2.0", id: 123, method: "tools/list" }))).rejects.toBe(error);
  expect(log).toHaveBeenCalledOnce();
  expect(f.registry).not.toHaveBeenCalled();
});

it.each(["factory", "transport"] as const)("SDK %s errors keep HTTP 500 and reach safe CI evidence without exception details", async boundary => {
  const f = fixture(false), lines: string[] = [];
  const forward = createMcpWorkerDiagnosticForwarder((line: string) => lines.push(line));
  const log = vi.spyOn(console, "warn").mockImplementation((line: unknown) => { forward(String(line) + "\n"); });
  if (boundary === "factory") vi.spyOn(McpServer.prototype, "registerTool").mockImplementation(() => { throw new TypeError("private-factory-token"); });
  else vi.spyOn(McpServer.prototype, "connect").mockRejectedValue(new Error("private-transport-token"));
  const response = await f.rpcBody(JSON.stringify({ jsonrpc: "2.0", id: 123, method: "tools/call", params: { name: "read", arguments: {} } }));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 123, error: { code: -32603, message: "Internal server error" } });
  expect(log).toHaveBeenCalledOnce();
  expect(mcpWorkerFailureEvidence(lines.join(""))).toEqual([{ event: "mcp_handler_error",
    kind: boundary === "factory" ? "type_error" : "error", stage: boundary === "factory" ? "server_factory" : "sdk_transport", reason: "unknown" }]);
  expect(JSON.stringify(log.mock.calls)).not.toContain("private");
});

it.each([
  ["Invalid verified OAuth request context", "invalid_auth_context"],
  ["Conflicting verified OAuth client identity", "conflicting_auth_context"],
  ["Cannot register capabilities after connecting to transport", "already_connected"],
  ["Invalid verified OAuth request context private-token", "unknown"],
])("SDK diagnostics classify only an exact known reason: %s", async (message, reason) => {
  const f = fixture(false), lines: string[] = [];
  const forward = createMcpWorkerDiagnosticForwarder((line: string) => lines.push(line));
  const log = vi.spyOn(console, "warn").mockImplementation((line: unknown) => { forward(String(line) + "\n"); });
  vi.spyOn(McpServer.prototype, "connect").mockRejectedValue(new Error(message));
  const response = await f.rpcBody(JSON.stringify({ jsonrpc: "2.0", id: 123, method: "tools/call", params: { name: "read", arguments: {} } }));
  expect(response.status).toBe(500);
  await response.body?.cancel();
  expect(mcpWorkerFailureEvidence(lines.join(""))).toEqual([{ event: "mcp_handler_error", kind: "error", stage: "sdk_transport", reason }]);
  expect(JSON.stringify(log.mock.calls)).not.toContain(message);
});

it.each(["{", "null", "42", "[]", '{"jsonrpc":"invalid","id":1,"method":"tools/call","params":{"name":"read"}}'])("preparsed body %s still receives an SDK protocol error", async body => {
  const f = fixture(), response = await f.rpcBody(body);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ jsonrpc: "2.0", error: { code: expect.any(Number) } });
  expect(f.registry).toHaveBeenCalledOnce();
  expect(f.principals).toEqual([]);
});

it.each(["skill_list", "remote_profiles", "remote_tools"])("shared call %s avoids unrelated native schema registration", async name => {
  const f = fixture(), register = vi.spyOn(McpServer.prototype, "registerTool");
  const result = await f.rpc("tools/call", { name, arguments: name === "remote_tools" ? { profile_id: "docs" } : {} });
  expect(result.result.isError).not.toBe(true);
  expect(result.result.content[0].type).toBe("text");
  const names = register.mock.calls.map(call => call[0]);
  expect(names).toContain(name);
  expect(names.filter(tool => MCP_TOOL_NAMES.some(native => native === tool))).toEqual([]);
});

it("native calls register only their own schema and still validate input before dispatch", async () => {
  const f = fixture(), register = vi.spyOn(McpServer.prototype, "registerTool");
  const result = await f.rpc("tools/call", { name: "read", arguments: {} });
  expect(result.result?.isError ?? Boolean(result.error)).toBe(true);
  expect(register.mock.calls.map(call => call[0])).toEqual(["read"]);
  expect(f.registry).toHaveBeenCalledOnce();
});

it("selected native calls still revalidate current scopes before an action", async () => {
  const f = fixture(true, []);
  const result = await f.rpc("tools/call", { name: "read", arguments: { workspace_id: "work", path: "fixture.txt" } });
  expect(result.result).toMatchObject({ isError: true, structuredContent: { error: { code: "insufficient_scope" } } });
  expect(f.registry).toHaveBeenCalledTimes(2);
});

it("preserves caller cancellation through the bounded POST rewrite", async () => {
  const f = fixture(), controller = new AbortController();
  const connect = McpServer.prototype.connect;
  vi.spyOn(McpServer.prototype, "connect").mockImplementation(function (this: McpServer, ...args) {
    controller.abort();
    return connect.apply(this, args);
  });
  const response = await f.rpcBody(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "skill_list", arguments: {} } }), controller.signal);
  expect(response.status).toBe(499);
  expect(f.registry).toHaveBeenCalledOnce();
  expect(f.principals).toEqual([]);
});

it.each([true, false])("unknown tools receive an SDK error with central=%s", async central => {
  const result = await fixture(central).rpc("tools/call", { name: "unknown_tool", arguments: {} });
  expect(result.result?.isError ?? Boolean(result.error)).toBe(true);
  expect(result.error?.code).not.toBe(-32601);
});

it("tool discovery after a selective call still publishes the complete native catalog", async () => {
  const f = fixture();
  await f.rpc("tools/call", { name: "skill_list", arguments: {} });
  await f.rpc("tools/call", { name: "read", arguments: {} });
  const listed = await f.rpc("tools/list");
  expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining([...MCP_TOOL_NAMES, "skill_list", "skill_read", "remote_profiles", "remote_tools", "remote_call"]));
  const sharedOnly = await fixture(true, []).rpc("tools/list");
  expect(sharedOnly.result.tools).toHaveLength(5);
});

it("concurrent selective requests keep separate principals", async () => {
  const a = fixture(true, [], "client-a"), b = fixture(true, [], "client-b");
  const results = await Promise.all([a.rpc("tools/call", { name: "skill_list", arguments: {} }), b.rpc("tools/call", { name: "skill_list", arguments: {} })]);
  expect(results.map(result => result.id)).toEqual(["client-a", "client-b"]);
  expect(a.principals).toEqual(["client-a"]);
  expect(b.principals).toEqual(["client-b"]);
});
