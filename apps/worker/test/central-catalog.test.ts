import { env, SELF, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import type { CapabilitiesDOv1 } from "../src/capabilities-do.js";
import type { CatalogSnapshot, RemoteToolDefinition } from "../src/contracts/catalog.js";
import { ADMIN_CSRF_COOKIE, ADMIN_SESSION_COOKIE } from "../src/http/constants.js";
import { handleCentralCatalogAdmin } from "../src/http/central-catalog.js";
import { internalHeaders, passwordVerifier, randomBase64Url, sha256Hex } from "../src/security.js";
import type { WorkerEnv } from "../src/platform/env.js";
import { catalogDefinition, catalogProfile } from "../../../test/domain/catalog-fixtures.js";
import { handleMcpSecret } from "../src/http/mcp.js";

const registry = () => env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
const namespace = () => (env as unknown as { CAPABILITIES: DurableObjectNamespace<CapabilitiesDOv1> }).CAPABILITIES;
const owner = () => namespace().get(namespace().idFromName("central"));
const url = (id: string) => `https://worker.test/admin/central/catalogs/${encodeURIComponent(id)}`;

async function session() {
  const raw = randomBase64Url(), csrf = randomBase64Url(), hash = await sha256Hex(raw), csrfHash = await sha256Hex(csrf);
  const verifier = await passwordVerifier("catalog-administrator-fixture-password");
  await runInDurableObject(registry(), instance => {
    const now = Date.now(); instance.setupAdmin(verifier, now);
    expect(instance.createAdminSession(hash, csrfHash, now + 60_000, now, 1)).toBe(true);
  });
  return { hash, headers: { cookie: `${ADMIN_SESSION_COOKIE}=${raw}; ${ADMIN_CSRF_COOKIE}=${csrf}`, origin: "https://worker.test",
    "content-type": "application/json", "x-csrf-token": csrf } };
}
async function client(secret = randomBase64Url()) {
  const client_id = "catalog-client-" + crypto.randomUUID(), verifier = await sha256Hex(secret);
  const path = "/auth/clients", body = JSON.stringify({ identity_version: 2, client_id, label: "Catalog-only fixture", native_scopes: [],
    secret_verifier: verifier, secret_prefix: "test-only" });
  const result = await registry().fetch(new Request(`https://registry.internal${path}`, { method: "POST", body,
    headers: await internalHeaders(env.INTERNAL_CONTROL_SECRET, "POST", path, body) }));
  expect(result.status).toBe(200);
  return { client_id, secret_version: 1 };
}
async function fixture(tools: readonly RemoteToolDefinition[] = [catalogDefinition("a"), catalogDefinition("b"), catalogDefinition("c")], id = `catalog-${crypto.randomUUID()}`) {
  const admin = await session(), profile = catalogProfile(id);
  expect(await owner().mutateProfile(admin.hash, { action: "connect", profile_id: id, connector_id: profile.connector_id, endpoint: profile.endpoint,
    authentication: "none" })).toMatchObject({ state: "written" });
  expect(await owner().mutateProfile(admin.hash, { action: "enable", profile_id: id, expected_revision: 1 })).toMatchObject({ state: "written" });
  const post = (body: unknown) => SELF.fetch(url(id), { method: "POST", headers: admin.headers, body: JSON.stringify(body) });
  expect((await post({ action: "stage", expected_revision: 0, tools })).status).toBe(200);
  const inspection = await owner().getCatalog(admin.hash, id);
  expect(inspection.state).toBe("found");
  if (inspection.state !== "found") throw new Error("missing fixture");
  const snapshot = inspection.snapshot;
  const approve = async (names = tools.map(tool => tool.name), digest = snapshot.digest, revision = 1) => {
    const response = await post({ action: "approve", expected_revision: revision, digest, tool_names: names });
    expect(response.status).toBe(200); return response.json();
  };
  return { admin, id, post, snapshot, approve };
}

it.each(["catalog-", "catalog:"])("W04 real admin HTTP stages and reviews a catalog without an upstream fetch (%s)", async prefix => {
  const network = vi.spyOn(globalThis, "fetch");
  try {
    const f = await fixture(undefined, prefix + crypto.randomUUID());
    const response = await SELF.fetch(url(f.id), { headers: f.admin.headers }), text = await response.text();
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(text).not.toContain("synthetic-private-catalog-token");
    expect(JSON.parse(text)).toMatchObject({ state: "found", head: { approved_digest: null }, changes: [{ name: "a", state: "added" }, { name: "b", state: "added" }, { name: "c", state: "added" }] });
    await f.approve(["a", "c"]);
    expect((await (await SELF.fetch(url(f.id), { headers: f.admin.headers })).json()) as unknown).toMatchObject({ head: { approved_names: ["a", "c"], revision: 2 } });
    expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); }
});

it("an existing MCP without a discovered catalog is empty, while missing profiles and snapshots stay missing", async () => {
  const admin = await session(), id = "empty-" + crypto.randomUUID(), profile = catalogProfile(id);
  expect(await owner().mutateProfile(admin.hash, { action: "connect", profile_id: id, connector_id: profile.connector_id,
    endpoint: profile.endpoint, authentication: "oauth" })).toMatchObject({ state: "written" });
  const empty = await SELF.fetch(url(id), { headers: admin.headers });
  expect(empty.status).toBe(200); expect(await empty.json()).toEqual({ state: "empty" });
  expect(empty.headers.get("cache-control")).toBe("no-store");
  const archived = await SELF.fetch(url(id) + "?snapshot=" + "a".repeat(64), { headers: admin.headers });
  expect(archived.status).toBe(404);
  expect(await archived.json()).toMatchObject({ error: { code: "central_missing" } });
  expect((await SELF.fetch(url("missing-" + crypto.randomUUID()), { headers: admin.headers })).status).toBe(404);
  expect((await SELF.fetch(url(id))).status).toBe(403);
});

it("complete publication replaces a pending catalog atomically and stale retries cannot overwrite it", async () => {
  const f = await fixture(), principal = await client();
  const tools = f.snapshot.tools.map(tool => tool.definition);
  const response = await f.post({ action: "publish", expected_revision: 1, tools });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ state: "written", head: { revision: 2,
    observed_digest: f.snapshot.digest, approved_digest: f.snapshot.digest, approved_names: ["a", "b", "c"] } });
  expect((await f.post({ action: "publish", expected_revision: 1, tools: [] })).status).toBe(409);
  expect(await (await SELF.fetch(url(f.id), { headers: f.admin.headers })).json()).toMatchObject({ head: { revision: 2, approved_names: ["a", "b", "c"] } });
  const page = await owner().listCatalog(principal, { profile_id: f.id });
  expect(page.state).toBe("listed");
  if (page.state === "listed") expect(page.tools.map(tool => tool.definition.name)).toEqual(["a", "b", "c"]);
});

it("published nested output schemas survive catalog RPC and pagination for generated service identifiers", async () => {
  const tools: RemoteToolDefinition[] = [
    { name: "migration_guide", annotations: { readOnlyHint: true, title: "Migration guide" },
      inputSchema: { "$schema": "https://json-schema.org/draft/2020-12/schema", type: "object", properties: {} } },
    { name: "search_documentation", description: "Search documentation.\n\tReturn relevant results.",
      annotations: { readOnlyHint: true, title: "Search documentation" },
      inputSchema: { "$schema": "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      outputSchema: { "$schema": "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false,
        properties: { results: { type: "array", items: { type: "object", additionalProperties: false,
          properties: { id: { type: "string" }, similarity: { type: "number" }, text: { type: "string" }, title: { type: "string" }, url: { type: "string" } },
          required: ["similarity", "id", "url", "title", "text"] } } }, required: ["results"] } },
  ];
  const secret = randomBase64Url(), f = await fixture(tools, "service-" + crypto.randomUUID()), principal = await client(secret);
  await f.approve();
  const page = await owner().listCatalog(principal, { profile_id: f.id });
  expect(page).toMatchObject({ state: "listed", next_cursor: null });
  if (page.state !== "listed") throw new Error("missing published tools");
  expect(page.tools.map(tool => tool.definition)).toEqual(tools);
  const first = await owner().listCatalog(principal, { profile_id: f.id, limit: 1 });
  if (first.state !== "listed" || !first.next_cursor) throw new Error("missing cursor");
  expect(await owner().listCatalog(principal, { profile_id: f.id, cursor: first.next_cursor }))
    .toMatchObject({ state: "listed", next_cursor: null, tools: [page.tools[1]] });
  const rpc = async (method: string, params: unknown) => {
    const request = new Request("https://worker.test/" + secret + "/mcp", { method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const response = await handleMcpSecret(request, { ...env, CENTRAL_SKILLS_ENABLED: "1", CENTRAL_DIRECT_TOOLS_ENABLED: "1" } as WorkerEnv, new URL(request.url));
    expect(response.status).toBe(200);
    const text = await response.text();
    const messages = response.headers.get("content-type")?.includes("text/event-stream")
      ? text.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5))) : [JSON.parse(text)];
    return messages.find(message => message.id === 1);
  };
  const listed = await rpc("tools/call", { name: "remote_tools", arguments: { profile_id: f.id } });
  expect(listed.result.isError).not.toBe(true);
  expect(JSON.parse(listed.result.content[0].text)).toEqual({ tools: page.tools, next_cursor: null });
  const direct = await rpc("tools/list", {});
  const directNames = direct.result.tools.map((tool: { name: string }) => tool.name).filter((name: string) => name.startsWith("rm_"));
  expect(directNames).toEqual(expect.arrayContaining(page.tools.map(tool => tool.public_name)));
  const status = await rpc("tools/call", { name: "remote_status", arguments: {} });
  expect(JSON.parse(status.result.content[0].text)).toEqual({ state: "listed", direct_tools: directNames.length });
});

it("W04 zero-Runner central-only clients see the same approved tools without grant rows", async () => {
  const f = await fixture(), principal = await client();

  expect(await owner().listCatalog(principal, { profile_id: f.id })).toEqual({ state: "listed", tools: [], next_cursor: null });
  await f.approve(["a", "c"]);
  const page = await owner().listCatalog(principal, { profile_id: f.id });
  expect(page.state).toBe("listed");
  if (page.state === "listed") expect(page.tools.map(tool => tool.definition.name)).toEqual(["a", "c"]);
  await runInDurableObject(registry(), instance => {
    expect(instance.listRunners()).toEqual([]);
    expect(instance.revalidateMcpClient(principal.client_id, 1)).toBeUndefined();
  });
});

it("W04 MAC-bound pages cannot be reused by another client or with changed page limits", async () => {
  const f = await fixture(), a = await client(), b = await client();
  await f.approve();
  const first = await owner().listCatalog(a, { profile_id: f.id, limit: 1 });
  expect(first.state).toBe("listed");
  if (first.state !== "listed" || first.next_cursor === null) throw new Error("missing page");
  expect(first.tools).toHaveLength(1);
  const next = await owner().listCatalog(a, { profile_id: f.id, cursor: first.next_cursor });
  expect(next.state).toBe("listed");
  if (next.state === "listed") expect(next.tools[0]!.tool_id).not.toBe(first.tools[0]!.tool_id);
  expect(await owner().listCatalog(b, { profile_id: f.id, cursor: first.next_cursor })).toEqual({ state: "stale_cursor" });
  expect(await owner().listCatalog(a, { profile_id: f.id, limit: 2, cursor: first.next_cursor })).toEqual({ state: "stale_cursor" });
  const changed = (first.next_cursor[0] === "A" ? "B" : "A") + first.next_cursor.slice(1);
  expect(await owner().listCatalog(a, { profile_id: f.id, cursor: changed })).toEqual({ state: "stale_cursor" });
});

it.each(["profile", "catalog", "identity"])("W04 stale pages are fenced after %s changes", async changed => {
  const f = await fixture(), principal = await client(); await f.approve();
  const first = await owner().listCatalog(principal, { profile_id: f.id, limit: 1 });
  if (first.state !== "listed" || first.next_cursor === null) throw new Error("missing page");
  if (changed === "profile") await owner().mutateProfile(f.admin.hash, { action: "enable", profile_id: f.id, expected_revision: 2 });
  if (changed === "catalog") await f.post({ action: "stage", expected_revision: 2, tools: f.snapshot.tools.map(tool => tool.definition) });
  if (changed === "identity") await runInDurableObject(registry(), instance => { instance.revokeMcpClient(principal.client_id, Date.now()); });
  expect(await owner().listCatalog(principal, { profile_id: f.id, cursor: first.next_cursor })).toEqual({ state: changed === "identity" ? "denied" : "stale_cursor" });
});

it("W04 observed changes quarantine old tools and approval publishes changed tools to all clients", async () => {
  const f = await fixture(), principal = await client(); await f.approve();
  const changed = [catalogDefinition("a"), catalogDefinition("b", "New behavior"), catalogDefinition("new")];
  expect((await f.post({ action: "stage", expected_revision: 2, tools: changed })).status).toBe(200);
  let page = await owner().listCatalog(principal, { profile_id: f.id });
  expect(page.state === "listed" && page.tools.map(tool => tool.definition.name)).toEqual(["a"]);
  const observation = await owner().getCatalog(f.admin.hash, f.id);
  if (observation.state !== "found") throw new Error("missing observation");
  await f.approve(["a", "b", "new"], observation.snapshot.digest, 3);
  page = await owner().listCatalog(principal, { profile_id: f.id });
  expect(page.state === "listed" && page.tools.map(tool => tool.definition.name)).toEqual(["a", "b", "new"]);
  const archived = await SELF.fetch(url(f.id) + `?snapshot=${f.snapshot.digest}`, { headers: f.admin.headers });
  expect((await archived.json()) as unknown).toMatchObject({ snapshot: { digest: f.snapshot.digest } });
});

it("W04 admin revocation and concurrent review protect the mutation boundary", async () => {
  const f = await fixture();
  const requests = [0, 1].map(() => f.post({ action: "approve", expected_revision: 1, digest: f.snapshot.digest, tool_names: ["a"] }));
  expect((await Promise.all(requests)).map(response => response.status).sort()).toEqual([200, 409]);
  await runInDurableObject(registry(), instance => { instance.logoutAdminSession(f.admin.hash); });
  expect((await f.post({ action: "disable", expected_revision: 2 })).status).toBe(403);
});

it.each(["no-session", "origin", "csrf", "body", "profile-id"])("W04 catalog HTTP rejects %s without writing", async failure => {
  const f = await fixture(), headers: Record<string, string> = { ...f.admin.headers };
  if (failure === "no-session") delete headers.cookie;
  if (failure === "origin") headers.origin = "https://other.invalid";
  if (failure === "csrf") headers["x-csrf-token"] = "wrong";
  const input = failure === "profile-id" ? { action: "disable", expected_revision: 1, profile_id: f.id } : { action: "disable", expected_revision: 1 };
  const response = await SELF.fetch(url(f.id), { method: "POST", headers, body: failure === "body" ? "null" : JSON.stringify(input) });
  expect(response.status).toBe(["body", "profile-id"].includes(failure) ? 400 : 403);
  expect(await owner().getCatalog(f.admin.hash, f.id)).toMatchObject({ head: { revision: 1 } });
});

it("W04 altered persisted content cannot become a successful directory result", async () => {
  const f = await fixture(), principal = await client(); await f.approve();
  await runInDurableObject(owner(), (_instance, state) => {
    const row = state.storage.sql.exec<{ snapshot_json: string }>("SELECT snapshot_json FROM catalog_snapshots_v1 WHERE profile_id=? AND digest=?", f.id, f.snapshot.digest).one();
    const snapshot = JSON.parse(row.snapshot_json) as CatalogSnapshot;
    (snapshot.tools[0]!.definition as { description: string }).description = "Tampered fixture";
    const encoded = JSON.stringify(snapshot);
    state.storage.sql.exec("UPDATE catalog_snapshots_v1 SET snapshot_json=?,bytes=? WHERE profile_id=? AND digest=?", encoded, new TextEncoder().encode(encoded).byteLength, f.id, f.snapshot.digest);
  });
  expect(await owner().listCatalog(principal, { profile_id: f.id })).toEqual({ state: "unavailable" });
  expect((await SELF.fetch(url(f.id), { headers: f.admin.headers })).status).toBe(503);
});

it("W04 absent optional binding performs no identity or catalog I/O", async () => {
  const get = vi.fn(() => { throw new Error("must not resolve"); });
  const configured = { REGISTRY: { get } } as unknown as WorkerEnv;
  const request = new Request(url("absent"), { method: "POST", body: "{}" });
  expect((await handleCentralCatalogAdmin(request, configured, new URL(request.url))).status).toBe(404);
  expect(get).not.toHaveBeenCalled();
});

it("W04 unknown owner receipts never reflect arbitrary strings or claim success", async () => {
  const f = await fixture();
  const config = { ...env, RUNMESH_PUBLIC_ORIGIN: "https://worker.test", CAPABILITIES: { idFromName: () => "central", get: () => ({
    mutateCatalog: async () => ({ state: "private-owner-error-do-not-reflect" }),
  }) } } as unknown as WorkerEnv;
  const request = new Request(url(f.id), { method: "POST", headers: f.admin.headers, body: JSON.stringify({ action: "disable", expected_revision: 1 }) });
  const response = await handleCentralCatalogAdmin(request, config, new URL(request.url));
  expect(response.status).toBe(503); expect(await response.text()).not.toContain("private-owner-error-do-not-reflect");
});
