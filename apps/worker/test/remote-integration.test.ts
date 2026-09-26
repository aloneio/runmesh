import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { CapabilitiesDOv1 } from "../src/capabilities-do.js";
import { handleCentralAdmin } from "../src/http/central.js";
import { handleMcpSecret } from "../src/http/mcp.js";
import { ADMIN_CSRF_COOKIE, ADMIN_SESSION_COOKIE } from "../src/http/constants.js";
import { internalHeaders, passwordVerifier, randomBase64Url, sha256Hex } from "../src/security.js";
import type { WorkerEnv } from "../src/platform/env.js";
import type { CentralRemote } from "../src/contracts/remote.js";
import type { CentralDirectoryReader } from "../src/contracts/catalog.js";
import type { CentralToolVisibilityReader } from "../src/contracts/capabilities.js";

const endpoint = "https://remote.example.com/mcp";
const registry = () => env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
async function administrator() {
  const raw = randomBase64Url(), csrf = randomBase64Url(), hash = await sha256Hex(raw), csrfHash = await sha256Hex(csrf);
  const verifier = await passwordVerifier("central-remote-test-password");
  await runInDurableObject(registry(), instance => {
    const now = Date.now(); instance.setupAdmin(verifier, now);
    expect(instance.createAdminSession(hash, csrfHash, now + 60_000, now, 1)).toBe(true);
  });
  return { hash, headers: { cookie: `${ADMIN_SESSION_COOKIE}=${raw}; ${ADMIN_CSRF_COOKIE}=${csrf}`,
    origin: "https://worker.test", "content-type": "application/json", "x-csrf-token": csrf } };
}
async function client(native = false) {
  const secret = randomBase64Url(), id = "remote-client-" + crypto.randomUUID(), path = "/auth/clients";
  const body = JSON.stringify({ identity_version: 2, client_id: id, label: native ? "Services and computer access" : "Remote only", native_scopes: native ? ['coding:read'] : [],
    secret_verifier: await sha256Hex(secret), secret_prefix: "fixture" });
  const response = await registry().fetch(new Request(`https://registry.internal${path}`, { method: "POST", body,
    headers: await internalHeaders(env.INTERNAL_CONTROL_SECRET, "POST", path, body) }));
  expect(response.status).toBe(200); return { secret, principal: { client_id: id, secret_version: 1 } };
}
async function rpc(config: WorkerEnv, secret: string, method: string, params: unknown) {
  const request = new Request(`https://worker.test/${secret}/mcp`, { method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer inbound-must-not-propagate" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "test", method, params }) });
  const response = await handleMcpSecret(request, config, new URL(request.url)); expect(response.status).toBe(200);
  const text = await response.text();
  const messages = response.headers.get("content-type")?.includes("text/event-stream") ? text.replaceAll("\r\n", "\n").split("\n\n").flatMap(event => {
    const data = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    return data ? [JSON.parse(data)] : [];
  }) : [JSON.parse(text)];
  return messages.find(message => message.id === "test");
}

async function fixture(native = false) {
  const admin = await administrator(), current = await client(native);
  const ns = (env as unknown as { CAPABILITIES: DurableObjectNamespace<CapabilitiesDOv1> }).CAPABILITIES;
  const stub = ns.get(ns.idFromName("remote-fixture-" + crypto.randomUUID()));
  const configured = { ...env, RUNMESH_PUBLIC_ORIGIN: "https://worker.test" } as WorkerEnv;
  let instance: CapabilitiesDOv1;
  await runInDurableObject(stub, (_original, state) => { instance = new CapabilitiesDOv1(state, configured); });
  const call = <T>(action: (owner: CapabilitiesDOv1) => Promise<T>) => runInDurableObject(stub, () => action(instance));
  const port: CentralRemote & CentralDirectoryReader & CentralToolVisibilityReader = { toolVisibility: principal => call(owner => owner.toolVisibility(principal)),
    listRemoteProfiles: principal => call(owner => owner.listRemoteProfiles(principal)),
    listDirectory: principal => call(owner => owner.listDirectory(principal)),
    callRemote: (principal, input) => call(owner => owner.callRemote(principal, input)),
    listCatalog: (principal, input) => call(owner => owner.listCatalog(principal, input)),
    discoverRemote: (hash, id, revision) => call(owner => owner.discoverRemote(hash, id, revision)) };
  const config = { ...configured, CAPABILITIES: { idFromName: () => "central", get: () => port } } as unknown as WorkerEnv;
  const id = "docs";
  expect(await call(owner => owner.mutateProfile(admin.hash, { action: "connect", profile_id: id, connector_id: "example", endpoint,
    authentication: "none" }))).toMatchObject({ state: "written" });
  expect(await call(owner => owner.mutateProfile(admin.hash, { action: "enable", profile_id: id, expected_revision: 1 }))).toMatchObject({ state: "written" });
  let description = "Return a fixture value";
  const execute = vi.fn(async ({ value }: { value: number }) => ({ content: [{ type: "text" as const, text: String(value) },
    { type: "image" as const, mimeType: "image/png", data: "AA==" }], structuredContent: { value } }));
  const upstream = createMcpHandler(() => {
    const server = new McpServer({ name: "test-upstream", version: "1" });
    server.registerTool("lookup", { description, inputSchema: z.object({ value: z.number().int() }).strict(),
      outputSchema: z.object({ value: z.number().int() }).strict() }, execute); return server;
  }, { route: "/mcp", legacy: "stateless" });
  const methods: string[] = [];
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(String(input)).toBe(endpoint); expect(init?.redirect).toBe("manual"); expect(init?.credentials).toBe("omit");
    const headers = new Headers(init?.headers); expect(headers.get("authorization")).toBeNull();
    expect(headers.has("cookie")).toBe(false); expect(JSON.stringify(init)).not.toContain(current.secret);
    const body = JSON.parse(String(init?.body)); methods.push(body.method);
    return upstream.fetch(new Request(input, init));
  });
  const discover = async (headers = admin.headers) => {
    const request = new Request(`https://worker.test/admin/central/discovery/${id}`, { method: "POST", headers, body: '{"expected_revision":0}' });
    return handleCentralAdmin(request, config, new URL(request.url));
  };
  const approve = async () => {
    const observed = await call(owner => owner.getCatalog(admin.hash, id));
    if (observed.state !== "found") throw new Error("missing fixture catalog");
    expect(await call(owner => owner.mutateCatalog(admin.hash, { action: "approve", profile_id: id, expected_revision: 1,
      digest: observed.snapshot.digest, tool_names: ["lookup"] }))).toMatchObject({ state: "written" });
    const tool = observed.snapshot.tools[0]!;
    return { profile_id: id, tool_id: tool.tool_id, version: tool.version, arguments: { value: 7 } };
  };
  return { admin, current, config, call, port, discover, approve, execute, network, methods, drift: () => { description = "Unreviewed change"; } };
}

it("W05 admin discovery to approval to client invocation crosses the real HTTP/DO/SDK chain with no Runner", async () => {
  const f = await fixture();
  try {
    expect((await f.discover()).status).toBe(200);
    expect(await f.call(owner => owner.getCatalog(f.admin.hash, "docs"))).toMatchObject({ head: { approved_digest: null, revision: 1 } });
    const command = await f.approve();
    const list = await rpc(f.config, f.current.secret, "tools/list", {});
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).toContain("remote_call");
    expect(list.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(['remote_call', 'remote_profiles', 'remote_tools']);
    const count = f.methods.length;
    const page = await rpc(f.config, f.current.secret, "tools/call", { name: "remote_tools", arguments: { profile_id: "docs" } });
    expect(JSON.parse(page.result.content[0].text).tools[0].tool_id).toBe(command.tool_id);
    expect(f.methods).toHaveLength(count);
    const response = await rpc(f.config, f.current.secret, "tools/call", { name: "remote_call", arguments: command });
    expect(response.result).toMatchObject({ isError: false, structuredContent: { value: 7 }, content: [{ type: "text", text: "7" }, { type: "image", data: "AA==" }] });
    expect(f.execute).toHaveBeenCalledOnce();
    await runInDurableObject(registry(), instance => { expect(instance.listRunners()).toEqual([]); });
  } finally { f.network.mockRestore(); }
});

it("W05 shared clients discover publications without grants and invalid arguments precede network", async () => {
  const f = await fixture();
  try {
    expect((await f.discover()).status).toBe(200); const command = await f.approve(), other = await client(), before = f.methods.length;
    const config = { ...f.config, CENTRAL_SKILLS_ENABLED: '1', CENTRAL_DIRECT_TOOLS_ENABLED: '1' };
    const shared = (await rpc(config, other.secret, 'tools/list', {})).result.tools;
    const profiles = await rpc(config, other.secret, 'tools/call', { name: 'remote_profiles', arguments: {} });
    expect(JSON.parse(profiles.result.content[0].text)).toMatchObject({ state: 'listed', profiles: [{ profile_id: 'docs' }] });
    const tools = (await rpc(config, f.current.secret, 'tools/list', {})).result.tools;
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual(shared.map((tool: { name: string }) => tool.name));
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(['remote_profiles', 'remote_tools', 'remote_call', 'remote_status']));
    expect(tools.some((tool: { name: string }) => tool.name.startsWith('skill_'))).toBe(false);
    expect(await f.port.callRemote(f.current.principal, { ...command, arguments: { value: "7" } })).toMatchObject({ code: "invalid_arguments", operation_state: "not_started" });
    expect(f.methods).toHaveLength(before); expect(f.execute).not.toHaveBeenCalled();
    expect(await f.port.callRemote(other.principal, command)).toMatchObject({ state: "completed" });
    expect(f.execute).toHaveBeenCalledOnce();
  } finally { f.network.mockRestore(); }
});

it("W05 live description changes block invocation without auto-approving or overwriting the reviewed catalog", async () => {
  const f = await fixture();
  try {
    expect((await f.discover()).status).toBe(200); const command = await f.approve(); f.drift();
    expect(await f.port.callRemote(f.current.principal, command)).toMatchObject({ code: "stale_catalog", operation_state: "not_started" });
    expect(f.execute).not.toHaveBeenCalled();
    expect(await f.call(owner => owner.getCatalog(f.admin.hash, "docs"))).toMatchObject({ head: { revision: 2 } });
  } finally { f.network.mockRestore(); }
});

it("W05 a lost response is unknown at the public MCP boundary and never causes a second execution", async () => {
  const f = await fixture();
  try {
    expect((await f.discover()).status).toBe(200); const command = await f.approve();
    const http = f.network.getMockImplementation()!;
    f.network.mockImplementation(async (input, init) => {
      const response = await http(input, init);
      return JSON.parse(String(init?.body)).method === "tools/call" ? new Response("lost response", { status: 503 }) : response;
    });
    const response = await rpc(f.config, f.current.secret, "tools/call", { name: "remote_call", arguments: command });
    expect(response.result.isError).toBe(true);
    expect(JSON.parse(response.result.content[0].text)).toMatchObject({ error: { operation_state: "unknown", code: "remote_upstream_unavailable" } });
    expect(f.execute).toHaveBeenCalledOnce(); expect(f.methods.filter(method => method === "tools/call")).toHaveLength(1);
  } finally { f.network.mockRestore(); }
});

it.each([401, 403])("W05 upstream HTTP %s preserves authorization guidance and uncertain effects across public boundaries", async status => {
  const f = await fixture();
  try {
    const http = f.network.getMockImplementation()!;
    f.network.mockImplementation(async () => new Response("untrusted upstream rejection", { status }));
    const discovery = await f.discover();
    expect(discovery.status).toBe(503);
    expect(await discovery.json()).toMatchObject({ error: { code: "remote_authorization_required", operation_state: "not_started" } });
    expect(f.network).toHaveBeenCalledOnce(); expect(f.execute).not.toHaveBeenCalled();
    expect(await f.call(owner => owner.getCatalog(f.admin.hash, "docs"))).toMatchObject({ state: "missing" });
    f.network.mockImplementation(http);
    expect((await f.discover()).status).toBe(200); const command = await f.approve();
    f.network.mockImplementation(async (input, init) => {
      const response = await http(input, init);
      return JSON.parse(String(init?.body)).method === "tools/call" ? new Response("untrusted upstream rejection", { status }) : response;
    });
    const response = await rpc(f.config, f.current.secret, "tools/call", { name: "remote_call", arguments: command });
    expect(response.result.isError).toBe(true);
    expect(JSON.parse(response.result.content[0].text)).toMatchObject({ error: { code: "remote_authorization_required",
      failure_class: "authorization", operation_state: "unknown", next_action: "inspect_upstream_state" } });
    expect(JSON.stringify(response)).not.toContain("untrusted upstream rejection");
    expect(f.execute).toHaveBeenCalledOnce(); expect(f.methods.filter(method => method === "tools/call")).toHaveLength(1);
    expect(await f.call(owner => owner.getCatalog(f.admin.hash, "docs"))).toMatchObject({ head: { revision: 2 } });
  } finally { f.network.mockRestore(); }
});

it("W05 same-client concurrent remote work is refused instead of queued or replayed", async () => {
  const f = await fixture(); let release: () => void = () => undefined;
  try {
    expect((await f.discover()).status).toBe(200); const command = await f.approve();
    let entered: () => void = () => undefined;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const original = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async args => { entered(); await held; return original(args); });
    await f.call(async owner => {
      const first = owner.callRemote(f.current.principal, command);
      await started;
      expect(await owner.callRemote(f.current.principal, command)).toEqual({ state: "failed", code: "busy", operation_state: "not_started" });
      release(); expect(await first).toMatchObject({ state: "completed" });
    });
    expect(f.execute).toHaveBeenCalledOnce();
  } finally { release(); f.network.mockRestore(); }
});

it("W05 completed data is withheld if the client is revoked during upstream execution", async () => {
  const f = await fixture();
  try {
    expect((await f.discover()).status).toBe(200); const command = await f.approve(), original = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async args => {
      await runInDurableObject(registry(), instance => { instance.revokeMcpClient(f.current.principal.client_id, Date.now()); });
      return original(args);
    });
    expect(await f.port.callRemote(f.current.principal, command)).toEqual({ state: "failed", code: "result_withheld", operation_state: "completed" });
    expect(f.execute).toHaveBeenCalledOnce();
  } finally { f.network.mockRestore(); }
});

it("W05 discovery requires the existing browser CSRF boundary before any upstream request", async () => {
  const f = await fixture();
  try { expect((await f.discover({ ...f.admin.headers, "x-csrf-token": "wrong" })).status).toBe(403); expect(f.network).not.toHaveBeenCalled(); }
  finally { f.network.mockRestore(); }
});

it("W05 unavailable central state retains native tools when no deployment endpoint list is configured", async () => {
  const current = await client(true), get = vi.fn(() => { throw new Error("must not resolve"); });
  const config = { ...env, CAPABILITIES: { idFromName: get, get } } as unknown as WorkerEnv;
  const response = await rpc(config, current.secret, "tools/list", {});
  expect(response.result.tools).toHaveLength(10); expect(get).toHaveBeenCalledWith("central");
  const centralOnly = await client();
  expect((await rpc(config, centralOnly.secret, 'tools/list', {})).result.tools).toEqual([]);
  expect(get).toHaveBeenCalledTimes(2);
});

it("W05 a relay hop cannot recursively enter another Runmesh MCP endpoint", async () => {
  const request = new Request("https://worker.test/unused/mcp", { headers: { "x-runmesh-mcp-hop": "1" } });
  expect((await handleMcpSecret(request, env, new URL(request.url))).status).toBe(508);
});

it('W08 direct tools preserve reviewed schemas and stale names cannot bypass a disabled service', async () => {
  const f = await fixture(true); try {
    expect((await f.discover()).status).toBe(200); await f.approve(); const config = { ...f.config, CENTRAL_DIRECT_TOOLS_ENABLED: '1' };
    const listed = await rpc(config, f.current.secret, 'tools/list', {}); const direct = listed.result.tools.find((t: { name: string }) => t.name.startsWith('rm_'));
    expect(direct.inputSchema.properties.value.type).toBe('integer'); const called = await rpc(config, f.current.secret, 'tools/call', { name: direct.name, arguments: { value: 9 } });
    expect(called.result.structuredContent).toEqual({ value: 9 }); expect(f.execute).toHaveBeenCalledOnce();
    await f.call(o => o.mutateProfile(f.admin.hash, { action: 'disable', profile_id: 'docs', expected_revision: 2 }));
    const denied = await rpc(config, f.current.secret, 'tools/call', { name: direct.name, arguments: { value: 10 } }); expect(denied.result?.isError ?? !!denied.error).toBe(true); expect(f.execute).toHaveBeenCalledOnce();
    f.port.listDirectory = async () => { throw new Error('central failure'); }; const degraded = await rpc(config, f.current.secret, 'tools/list', {}); expect(degraded.result.tools.some((t: { name: string }) => t.name === 'shell')).toBe(true);
    const status = await rpc(config, f.current.secret, 'tools/call', { name: 'remote_status', arguments: {} }); expect(JSON.parse(status.result.content[0].text).state).toBe('unavailable');
    // A malformed state-owner result must not take down the native provider.
    f.port.listDirectory = async () => JSON.parse('{"state":"listed","view_version":"' + 'a'.repeat(64) + '","tools":[null]}');
    const malformed = await rpc(config, f.current.secret, 'tools/list', {});
    expect(malformed.result.tools.some((t: { name: string }) => t.name === 'shell')).toBe(true);
    expect(malformed.result.tools.some((t: { name: string }) => t.name.startsWith('rm_'))).toBe(false);
  } finally { f.network.mockRestore(); }
});
