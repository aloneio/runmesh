import { expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { createHttpRemoteConnector } from "../src/platform/connectors/remote-client.js";
import { createRemoteDiscovery } from "../src/application/capabilities/remote-discovery.js";
import type { CatalogHead, CatalogRepository, CatalogSnapshot } from "../src/contracts/catalog.js";
import type { ConnectionProfile } from "../src/contracts/connectors.js";
import { RemoteFault } from "../src/contracts/remote.js";

const endpoint = "https://sessions.example.com/mcp", token = "synthetic-session-bearer";
const profile: ConnectionProfile = { schema_version: 1, profile_id: "docs", connector_id: "docs", endpoint, revision: 1,
  enabled: true, authentication: "oauth", credential: null, owner: { kind: "instance_admin" } };
function fixture(afterCleanup: () => void = () => undefined) {
  const sessions = new Set<string>(), seen: Array<{ method: string; session: string | null }> = [];
  const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "done" }] }));
  const server = createMcpHandler(() => {
    const s = new McpServer({ name: "ephemeral-fixture", version: "1" });
    s.registerTool("read", { inputSchema: z.object({}).strict() }, execute); return s;
  }, { route: "/mcp", legacy: "stateless" });
  let changed = false, expired = false, current = true, allowSession = true, changeOnResponse = false;
  const send = vi.fn(async (url: string | URL, init?: RequestInit) => {
    expect(String(url)).toBe(endpoint); expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
    const id = new Headers(init?.headers).get("mcp-session-id");
    if (init?.method === "DELETE") { seen.push({ method: "DELETE", session: id }); sessions.delete(id!); afterCleanup(); return new Response(null, { status: 204 }); }
    const method = JSON.parse(String(init?.body)).method as string; seen.push({ method, session: id });
    if (method !== "initialize" && (expired || !sessions.has(id!))) return new Response(null, { status: 404 });
    const response = await server.fetch(new Request(url, init));
    if (method === "tools/call" && changeOnResponse) allowSession = false;
    const headers = new Headers(response.headers);
    if (method === "initialize") { const value = crypto.randomUUID(); sessions.add(value); headers.set("mcp-session-id", value); }
    else if (changed) headers.set("mcp-session-id", "unexpected-new-session");
    return new Response(response.body, { status: response.status, headers });
  });
  const rules = () => [{ endpoint, protocol: "2025-11-25" as const, ...(allowSession ? { session: "ephemeral" as const } : {}) }];
  const connector = createHttpRemoteConnector({ rules, fetch: send,
    credential: async () => ({ credential: { kind: "bearer", token }, current: () => current }) });
  const open = () => connector.open(profile, new AbortController().signal, () => undefined, async () => undefined);
  return { connector, open, seen, execute, send, sessions, change: () => { changed = true; }, expire: () => { expired = true; }, revoke: () => { current = false; },
    changePolicy: () => { allowSession = false; }, changeOnResponse: () => { changeOnResponse = true; } };
}
it.each(["publish", "admin", "profile", "catalog"])("W06 discovery closes its session before publication and rechecks %s", async change => {
  let allowed = true, currentProfile = { ...profile }, head: CatalogHead | undefined, snapshot: CatalogSnapshot | undefined;
  const f = fixture(() => {
    if (change === "admin") allowed = false;
    if (change === "profile") currentProfile = { ...profile, revision: 2, enabled: false };
    if (change === "catalog") head = { schema_version: 1, profile_id: profile.profile_id, revision: 1,
      observed_digest: "a".repeat(64), approved_digest: null, approved_names: [] };
  });
  const publish = vi.fn<CatalogRepository["publish"]>((value, expected) => {
    if ((head?.revision ?? 0) !== expected) return { state: "conflict", current_revision: head?.revision ?? 0 };
    snapshot = value;
    head = { schema_version: 1, profile_id: value.profile_id, revision: expected + 1,
      observed_digest: value.digest, approved_digest: value.digest, approved_names: value.tools.map(tool => tool.definition.name) };
    return { state: "written", head };
  });
  const repository: CatalogRepository = { readHead: () => head, readSnapshot: () => snapshot, publish,
    stage: () => ({ state: "invalid" }), approve: () => ({ state: "invalid" }), disable: () => ({ state: "invalid" }) };
  const discover = createRemoteDiscovery({ repository, connector: f.connector, profile: () => currentProfile,
    authorize: async () => allowed ? "allowed" : "denied",
    digest: async value => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, "0")).join("") });
  const result = await discover(profile.profile_id, 0, new AbortController().signal);
  expect(f.seen.filter(request => request.method === "DELETE")).toHaveLength(1);
  expect(f.sessions.size).toBe(0);
  expect(f.execute).not.toHaveBeenCalled();
  if (change === "publish") {
    expect(result).toMatchObject({ state: "written", head: { revision: 1, approved_names: ["read"] } });
    expect(publish).toHaveBeenCalledOnce();
  } else {
    expect(result).toMatchObject({ state: "failed", operation_state: "not_started" });
    expect(publish).not.toHaveBeenCalled();
  }
});
it("W06 ephemeral sessions are isolated per operation and closed once", async () => {
  const f = fixture(), a = await f.open(), b = await f.open();
  const at = await a.listTools(), bt = await b.listTools();
  await a.callTool(at[0]!, {}, async () => undefined); await b.callTool(bt[0]!, {}, async () => undefined);
  await a.close(); await a.close(); await b.close();
  const ids = f.seen.filter(s => s.method === "tools/call").map(s => s.session);
  expect(new Set(ids).size).toBe(2); expect(ids.every(Boolean)).toBe(true);
  expect(f.seen.filter(s => s.method === "DELETE")).toHaveLength(2); expect(f.sessions.size).toBe(0);
  expect(f.seen.filter(s => s.method === "initialize").every(s => s.session === null)).toBe(true);
  expect(f.execute).toHaveBeenCalledTimes(2);
});
it("W06 session replacement is rejected instead of silently switching identities", async () => {
  const f = fixture(), session = await f.open(); f.change();
  await expect(session.listTools()).rejects.toMatchObject({ code: "upstream_protocol_error" });
  await session.close(); expect(f.execute).not.toHaveBeenCalled();
});
it("W06 expired-session tool calls are not replayed after a new handshake", async () => {
  const f = fixture(), session = await f.open(), tools = await session.listTools(); f.expire();
  await expect(session.callTool(tools[0]!, {}, async () => undefined)).rejects.toBeInstanceOf(RemoteFault);
  await session.close();
  expect(f.seen.filter(s => s.method === "initialize")).toHaveLength(1);
  expect(f.seen.filter(s => s.method === "tools/call")).toHaveLength(1);
});
it("W06 revoked credential leases prevent both invocation and cleanup network requests", async () => {
  const f = fixture(), session = await f.open(), tools = await session.listTools(); f.revoke(); const before = f.send.mock.calls.length;
  await expect(session.callTool(tools[0]!, {}, async () => undefined)).rejects.toMatchObject({ code: "authorization_required" });
  await session.close(); expect(f.send).toHaveBeenCalledTimes(before);
});

it("W06 removing session permission during preparation blocks dispatch", async () => {
  const f = fixture(), session = await f.open(), tools = await session.listTools(); f.changePolicy();
  await expect(session.callTool(tools[0]!, {}, async () => undefined)).rejects.toMatchObject({ code: "egress_denied" });
  await session.close(); expect(f.execute).not.toHaveBeenCalled();
});
it("W06 an egress change while a response is pending withholds its result", async () => {
  const f = fixture(), session = await f.open(), tools = await session.listTools(); f.changeOnResponse();
  await expect(session.callTool(tools[0]!, {}, async () => undefined)).rejects.toMatchObject({ code: "result_withheld" });
  await session.close(); expect(f.execute).toHaveBeenCalledOnce();
  expect(f.seen.filter(s => s.method === "tools/call")).toHaveLength(1);
});
