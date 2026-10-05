import { expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { createHttpRemoteConnector } from "../src/platform/connectors/remote-client.js";
import { createRemoteDiscovery } from "../src/application/capabilities/remote-discovery.js";
import { createRemoteCaller } from "../src/application/capabilities/remote-call.js";
import { buildCatalogSnapshot } from "../src/domain/capabilities/catalog.js";
import { catalogSha256 } from "../src/platform/capabilities/catalog-crypto.js";
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
it.each(["complete", "repeated", "cycle"] as const)("W06 upstream pagination %s cannot publish an incomplete catalog", async pagination => {
  const cursors: Array<string | null> = [];
  const connector = createHttpRemoteConnector({ rules: () => [{ endpoint, protocol: "2025-11-25" }], credential: async () => ({ kind: "bearer", token }),
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      let result: Record<string, unknown>;
      if (request.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "pagination-fixture", version: "1" } };
      else {
        expect(request.method).toBe("tools/list");
        const cursor = request.params?.cursor ?? null; cursors.push(cursor);
        const nextCursor = cursor === null ? "page-a" : cursor === "page-a" ? pagination === "repeated" ? "page-a" : "page-b" : pagination === "cycle" ? "page-a" : undefined;
        result = { tools: [{ name: "tool_" + cursors.length, inputSchema: { type: "object" } }], ...(nextCursor === undefined ? {} : { nextCursor }) };
      }
      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    } });
  const previous = (await buildCatalogSnapshot(profile, [{ name: "previous", inputSchema: { type: "object" } }], catalogSha256, () => false))!;
  let snapshot = previous, head: CatalogHead = { schema_version: 1, profile_id: profile.profile_id, revision: 7,
    observed_digest: previous.digest, approved_digest: previous.digest, approved_names: ["previous"] };
  const initial = structuredClone(head);
  const publish = vi.fn<CatalogRepository["publish"]>((value, expected) => {
    expect(expected).toBe(head.revision); snapshot = value;
    head = { ...head, revision: expected + 1, observed_digest: value.digest, approved_digest: value.digest, approved_names: value.tools.map(tool => tool.definition.name) };
    return { state: "written", head };
  });
  const repository: CatalogRepository = { readHead: () => head, readSnapshot: () => snapshot, publish,
    stage: () => ({ state: "invalid" }), approve: () => ({ state: "invalid" }), disable: () => ({ state: "invalid" }) };
  const discover = createRemoteDiscovery({ repository, connector, profile: () => profile, authorize: async () => "allowed", digest: catalogSha256 });
  const result = await discover(profile.profile_id, 7, new AbortController().signal);
  expect(cursors).toEqual(pagination === "repeated" ? [null, "page-a"] : [null, "page-a", "page-b"]);
  if (pagination === "complete") {
    expect(result).toMatchObject({ state: "written", head: { revision: 8, approved_names: ["tool_1", "tool_2", "tool_3"] } });
    expect(publish).toHaveBeenCalledOnce();
  } else {
    expect(result).toEqual({ state: "failed", code: "upstream_protocol_error", operation_state: "not_started" });
    expect(publish).not.toHaveBeenCalled(); expect(head).toEqual(initial); expect(snapshot).toEqual(previous);
  }
});
it.each(["publish", "admin", "profile", "catalog", "credential", "egress", "credential-digest", "egress-digest"])("W06 discovery closes its session before publication and rechecks %s", async change => {
  let allowed = true, currentProfile = { ...profile }, head: CatalogHead | undefined, snapshot: CatalogSnapshot | undefined;
  const f = fixture(() => {
    if (change === "admin") allowed = false;
    if (change === "profile") currentProfile = { ...profile, revision: 2, enabled: false };
    if (change === "credential") f.revoke();
    if (change === "egress") f.changePolicy();
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
    digest: async value => {
      const digest = await catalogSha256(value);
      if (change === "credential-digest") f.revoke();
      if (change === "egress-digest") f.changePolicy();
      return digest;
    } });
  const result = await discover(profile.profile_id, 0, new AbortController().signal);
  expect(f.seen.filter(request => request.method === "DELETE")).toHaveLength(1);
  expect(f.sessions.size).toBe(0);
  expect(f.execute).not.toHaveBeenCalled();
  if (change === "publish") {
    expect(result).toMatchObject({ state: "written", head: { revision: 1, approved_names: ["read"] } });
    expect(publish).toHaveBeenCalledOnce();
  } else {
    expect(result).toMatchObject(change.endsWith("-digest") ? { state: "denied" } : { state: "failed", operation_state: "not_started" });
    expect(publish).not.toHaveBeenCalled();
  }
});
it.each(["unchanged", "identity", "profile", "catalog", "credential", "egress", "cleanup-failure"])("W06 completed calls revalidate after session cleanup: %s", async change => {
  let calling = false, allowed = true, currentProfile = { ...profile }, head: CatalogHead;
  const f = fixture(() => {
    if (!calling) return;
    if (change === "identity") allowed = false;
    if (change === "profile") currentProfile = { ...profile, revision: 2, enabled: false };
    if (change === "catalog") head = { ...head, revision: head.revision + 1 };
    if (change === "credential") f.revoke();
    if (change === "egress") f.changePolicy();
    if (change === "cleanup-failure") throw new Error("cleanup response lost");
  });
  const preparation = await f.open(), definitions = await preparation.listTools();
  await preparation.close();
  const snapshot = await buildCatalogSnapshot(profile, definitions, catalogSha256, () => false);
  if (!snapshot) throw new Error("missing fixture catalog");
  head = { schema_version: 1, profile_id: profile.profile_id, revision: 1,
    observed_digest: snapshot.digest, approved_digest: snapshot.digest, approved_names: ["read"] };
  const repository: CatalogRepository = { readHead: () => head, readSnapshot: () => snapshot,
    publish: () => ({ state: "invalid" }), stage: () => ({ state: "invalid" }), approve: () => ({ state: "invalid" }), disable: () => ({ state: "invalid" }) };
  const principal = { client_id: "session-reader", secret_version: 1 };
  const call = createRemoteCaller({ repository, connector: f.connector, profile: () => currentProfile, digest: catalogSha256,
    identity: async () => allowed ? { state: "allowed", identity: { schema_version: 2, ...principal, label: "Session reader", native_scopes: [] } } : { state: "denied" } });
  const before = f.seen.length, tool = snapshot.tools[0]!; calling = true;
  const result = await call(principal, { profile_id: profile.profile_id, tool_id: tool.tool_id, version: tool.version, arguments: {} }, new AbortController().signal);
  expect(f.execute).toHaveBeenCalledOnce();
  expect(f.seen.slice(before).filter(request => request.method === "tools/call")).toHaveLength(1);
  expect(f.seen.slice(before).filter(request => request.method === "DELETE")).toHaveLength(1);
  expect(f.sessions.size).toBe(0);
  if (change === "unchanged" || change === "cleanup-failure") {
    expect(result).toMatchObject({ state: "completed", operation_state: "completed", result: { content: [{ type: "text", text: "done" }] } });
  } else {
    expect(result).toEqual({ state: "failed", code: "result_withheld", operation_state: "completed" });
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
