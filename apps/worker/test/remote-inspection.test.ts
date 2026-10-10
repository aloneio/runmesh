import { expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { createConnectorInspection } from "../src/application/connectors/inspection.js";
import { CATALOG_LIMITS } from "../src/contracts/catalog.js";
import type { ConnectionProfile } from "../src/contracts/connectors.js";
import { REMOTE_LIMITS } from "../src/contracts/remote.js";
import { createHttpRemoteConnector } from "../src/platform/connectors/remote-client.js";
import { BoundedRemoteValidator } from "../src/platform/connectors/remote-validation.js";

const endpoint = "https://inspection.example.com/mcp";
const profile: ConnectionProfile = { schema_version: 1, profile_id: "inspection", connector_id: "fixture", endpoint,
  owner: { kind: "instance_admin" }, enabled: true, revision: 1, authentication: "none", credential: null };
const definition = (name = "lookup") => ({ name, inputSchema: { type: "object" } });
const observed = (protocol = "2025-11-25", count = 1) => ({ state: "inspected", endpoint,
  server: { protocol_version: protocol, capabilities: { tools: true, resources: false, prompts: false, tasks: false, apps: false } },
  tools_count: count, observed_at_ms: 1_000 });
const protocolError = { state: "unavailable", code: "upstream_protocol_error" };

function fixture(pages: Record<string, unknown>[], inspection = true) {
  const methods: string[] = [], cursors: Array<string | null> = [];
  const connector = createHttpRemoteConnector({ inspection,
    rules: () => [{ endpoint, protocol: "2025-11-25" }], credential: async () => null,
    fetch: async (url, init) => {
      expect(String(url)).toBe(endpoint);
      const request = JSON.parse(String(init?.body)); methods.push(request.method);
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      let result: Record<string, unknown>;
      if (request.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: {} },
        serverInfo: { name: "inspection-fixture", version: "1" } };
      else {
        expect(request.method).toBe("tools/list");
        cursors.push(request.params?.cursor ?? null);
        result = pages[cursors.length - 1]!;
        expect(result).toBeDefined();
      }
      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    } });
  const inspect = createConnectorInspection({ connector, authorize: async () => "allowed", now: () => 1_000 });
  return { connector, methods, cursors, run: () => inspect(profile, new AbortController().signal) };
}

const extensions = [
  { label: "tool metadata", tool: { ...definition(), _meta: { "io.example/display": { label: "Lookup" } } } },
  { label: "icons", tool: { ...definition(), icons: [{ src: "https://assets.example.com/lookup.png", mimeType: "image/png" }] } },
  { label: "execution metadata", tool: { ...definition(), execution: { taskSupport: "optional" } } },
  { label: "input schema format", tool: { ...definition(), inputSchema: { type: "object", properties: { url: { type: "string", format: "uri" } } } } },
  { label: "output schema format", tool: { ...definition(), outputSchema: { type: "object", properties: { updated_at: { type: "string", format: "date-time" } } } } },
];

it.each(["2025-11-25", "2026-07-28"] as const)("RM10 inspects real SDK tools in %s without compiling schemas or executing them", async protocol => {
  const methods: string[] = [];
  const invoked = vi.fn(async () => ({ content: [{ type: "text" as const, text: "Fixture result" }] }));
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "inspection-sdk-fixture", version: "1" });
    server.registerTool("lookup", { inputSchema: z.object({ url: z.string().url() }),
      outputSchema: z.object({ updated_at: z.string().datetime() }),
      icons: [{ src: "https://assets.example.com/lookup.png", mimeType: "image/png" }],
      _meta: { "io.example/display": { label: "Lookup" } } }, invoked);
    return server;
  }, { route: "/mcp", legacy: "stateless" });
  const connector = createHttpRemoteConnector({ inspection: true, rules: () => [{ endpoint, protocol }], credential: async () => null,
    fetch: async (url, init) => {
      methods.push(JSON.parse(String(init?.body)).method);
      return handler.fetch(new Request(url, init));
    } });
  const compile = vi.spyOn(BoundedRemoteValidator.prototype, "getValidator");
  try {
    const inspect = createConnectorInspection({ connector, authorize: async () => "allowed", now: () => 1_000 });
    expect(await inspect(profile, new AbortController().signal)).toEqual(observed(protocol));
    expect(methods).toEqual(protocol === "2025-11-25" ? ["initialize", "notifications/initialized", "tools/list"] : ["server/discover", "tools/list"]);
    expect(compile).not.toHaveBeenCalled();
    expect(invoked).not.toHaveBeenCalled();
  } finally { compile.mockRestore(); }
});

it.each(extensions)("RM10 counts lawful $label while ordinary discovery retains publication checks", async ({ tool }) => {
  const inspection = fixture([{ tools: [tool] }]);
  expect(await inspection.run()).toEqual(observed());
  expect(inspection.methods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
  const publication = fixture([{ tools: [tool] }], false), dispatched = vi.fn();
  const session = await publication.connector.open(profile, new AbortController().signal, dispatched, async () => undefined);
  try { await expect(session.listTools()).rejects.toMatchObject({ code: "upstream_protocol_error" }); }
  finally { await session.close(); }
  expect(dispatched).not.toHaveBeenCalled();
  expect(publication.methods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
});

it("RM10 counts every tools page, including metadata outside the publication subset on a later page", async () => {
  const f = fixture([{ tools: [definition("first")], nextCursor: "page-two" },
    { tools: [{ ...extensions[0]!.tool, name: "second" }, { ...extensions[4]!.tool, name: "third" }] }]);
  expect(await f.run()).toEqual(observed("2025-11-25", 3));
  expect(f.cursors).toEqual([null, "page-two"]);
  expect(f.methods).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/list"]);
});

it("RM10 reports an empty tools catalog as zero", async () => {
  expect(await fixture([{ tools: [] }]).run()).toEqual(observed("2025-11-25", 0));
});

it.each([
  { label: "missing tool name", result: { tools: [{ inputSchema: { type: "object" } }] } },
  { label: "non-string tool name", result: { tools: [{ ...definition(), name: 42 }] } },
  { label: "null input schema", result: { tools: [{ ...definition(), inputSchema: null }] } },
  { label: "non-object input type", result: { tools: [{ ...definition(), inputSchema: { type: "array" } }] } },
  { label: "non-array tools", result: { tools: {} } },
  { label: "non-string cursor", result: { tools: [definition()], nextCursor: 42 } },
  { label: "invalid execution metadata", result: { tools: [{ ...definition(), execution: { taskSupport: "sometimes" } }] } },
])("RM10 retains SDK wire validation for $label", async ({ result }) => {
  const f = fixture([result]);
  expect(await f.run()).toEqual(protocolError);
  expect(f.methods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
});

it("RM10 rejects duplicate names across pages instead of reporting an ambiguous tool count", async () => {
  const f = fixture([{ tools: [definition()], nextCursor: "page-two" }, { tools: [extensions[0]!.tool] }]);
  expect(await f.run()).toEqual(protocolError);
  expect(f.cursors).toEqual([null, "page-two"]);
});

it("RM10 rejects a repeated page cursor instead of reporting a partial tool count", async () => {
  const f = fixture([{ tools: [definition("first")], nextCursor: "page-two" },
    { tools: [definition("second")], nextCursor: "page-two" }]);
  expect(await f.run()).toEqual(protocolError);
  expect(f.cursors).toEqual([null, "page-two"]);
});

it("RM10 retains the tool count and per-tool byte budgets during inspection", async () => {
  const tooMany = fixture([{ tools: Array.from({ length: CATALOG_LIMITS.tools + 1 }, (_, i) => definition(`tool_${i}`)) }]);
  expect(await tooMany.run()).toEqual(protocolError);
  const tooLarge = fixture([{ tools: [{ ...definition(), _meta: { description: "x".repeat(CATALOG_LIMITS.tool_bytes) } }] }]);
  expect(await tooLarge.run()).toEqual(protocolError);
});

it("RM10 bounds the complete descriptor set even when every tool fits its individual byte budget", async () => {
  const tools = Array.from({ length: 18 }, (_, i) => ({ ...definition(`tool_${i}`), _meta: { description: "x".repeat(30_000) } }));
  expect(await fixture([{ tools: tools.slice(0, 9), nextCursor: "page-two" }, { tools: tools.slice(9) }]).run()).toEqual(protocolError);
});

it.each([false, true])("RM10 enforces the pagination limit when continuation is %s", async continues => {
  const f = fixture(Array.from({ length: REMOTE_LIMITS.pages }, (_, i) => ({ tools: [definition(`tool_${i}`)],
    ...(i < REMOTE_LIMITS.pages - 1 || continues ? { nextCursor: `page-${i + 1}` } : {}) })));
  expect(await f.run()).toEqual(continues ? protocolError : observed("2025-11-25", REMOTE_LIMITS.pages));
  expect(f.cursors).toHaveLength(REMOTE_LIMITS.pages);
  expect(f.methods).not.toContain("tools/call");
});
