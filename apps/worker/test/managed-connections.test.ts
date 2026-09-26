import { expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import type { ConnectionProfile } from "../src/contracts/connectors.js";
import { createHttpRemoteConnector } from "../src/platform/connectors/remote-client.js";
import { connectionPolicy } from "../src/platform/connectors/connection-policy.js";
import { createManagedOAuth } from "../src/platform/connectors/managed-oauth.js";
import { createOAuthCipher, oauthRandom } from "../src/platform/connectors/oauth-crypto.js";
import { ManagedOAuthState, type ManagedOAuthRecord } from "../src/platform/connectors/managed-store.js";
import { catalogSha256 } from "../src/platform/capabilities/catalog-crypto.js";

const endpoint = "https://mcp.provider.com/mcp", origin = "https://runmesh.company.com", issuer = "https://login.provider.com";
const base: ConnectionProfile = { schema_version: 1, profile_id: "direct", connector_id: "direct", endpoint, revision: 2, enabled: true, credential: null, authentication: "none", owner: { kind: "instance_admin" } };
it.each(["modern", "legacy", "session"])("direct no-auth MCP negotiates %s and never sends an Authorization header", async mode => {
  const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "connected" }] }));
  const upstream = createMcpHandler(() => { const server = new McpServer({ name: "direct-fixture", version: "1" }); server.registerTool("read", { inputSchema: z.object({}).strict() }, execute); return server; }, { route: "/mcp", legacy: "stateless" });
  const seen: string[] = []; const sessionId = "isolated-session-123";
  const send = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers); expect(headers.has("authorization")).toBe(false); expect(headers.has("cookie")).toBe(false);
    if (init?.method === "DELETE") { seen.push("DELETE"); expect(headers.get("mcp-session-id")).toBe(sessionId); return new Response(null, { status: 204 }); }
    const method = JSON.parse(String(init?.body)).method as string; seen.push(method);
    if (mode !== "modern" && method === "server/discover") return Response.json({ jsonrpc: "2.0", id: JSON.parse(String(init?.body)).id, error: { code: -32601, message: "Method not found" } });
    const response = await upstream.fetch(new Request(url, init));
    if (mode === "session" && method === "initialize") { const h = new Headers(response.headers); h.set("mcp-session-id", sessionId); return new Response(response.body, { status: response.status, headers: h }); }
    if (mode === "session" && method !== "initialize") expect(headers.get("mcp-session-id")).toBe(sessionId);
    return response;
  });
  const connector = createHttpRemoteConnector({ policy: () => undefined, rules: p => connectionPolicy(p, undefined), credential: async () => null, fetch: send });
  const session = await connector.open(base, new AbortController().signal, () => undefined, async () => undefined);
  const tools = await session.listTools(); expect(tools[0]?.name).toBe("read");
  expect(await session.callTool(tools[0]!, {}, async () => undefined)).toMatchObject({ isError: false }); await session.close();
  expect(execute).toHaveBeenCalledTimes(1); expect(seen.filter(m => m === "tools/call")).toHaveLength(1);
  expect(seen.includes("DELETE")).toBe(mode === "session");
});
it("legacy null credentials do not acquire anonymous egress permission", () => {
  const { authentication: _, ...legacy } = base; expect(connectionPolicy(legacy, undefined)).toBeUndefined();
  expect(connectionPolicy({ ...base, endpoint: "https://127.0.0.1/mcp" }, undefined)).toBeUndefined();
});

function oauthFixture(cimd = false, configuredOrigin: string | null = origin) {
  let record: ManagedOAuthRecord | undefined, now = 1_800_000_000_000, allowed = true, live = { ...base, authentication: "oauth" as const };
  let failToken = false, revokeOnToken = false, privateToken = false;
  const posts: string[] = [], state = { registration: 0, exchanges: 0, refreshes: 0 };
  const cipher = createOAuthCipher("managed-test", () => JSON.stringify({ schema_version: 1, active_key_id: "test-key", keys: { "test-key": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE" } }), () => []);
  const repository = { read: () => record ? structuredClone(record) : undefined, find: (hash: string) => record?.state_hash === hash ? structuredClone(record) : undefined, replace: (value: ManagedOAuthRecord, expected: number) => { if ((record?.revision ?? 0) !== expected) return false; record = JSON.parse(JSON.stringify(value)) as ManagedOAuthRecord; return true; } };
  const send = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const address = String(url); expect(init?.redirect).toBe("manual"); expect(init?.credentials).toBe("omit");
    if ((init?.method ?? "GET") === "GET") {
      if (address.includes("oauth-protected-resource")) return Response.json({ resource: endpoint, authorization_servers: [issuer], scopes_supported: ["read"] });
      if (address.includes("oauth-authorization-server")) return Response.json({ issuer, authorization_endpoint: issuer + "/authorize", token_endpoint: privateToken ? "https://127.0.0.1/token" : issuer + "/token",
        registration_endpoint: issuer + "/register", response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], authorization_response_iss_parameter_supported: true, client_id_metadata_document_supported: cimd });
      return new Response(null, { status: 404 });
    }
    posts.push(address);
    if (address === issuer + "/register") { state.registration++; const input = JSON.parse(String(init?.body)); expect(input.redirect_uris).toEqual([origin + "/admin/central/connections/callback"]); return Response.json({ ...input, client_id: "fixture-client" }, { status: 201 }); }
    expect(address).toBe(issuer + "/token"); const params = new URLSearchParams(String(init?.body));
    if (params.get("grant_type") === "refresh_token") state.refreshes++; else { state.exchanges++; expect(params.get("code_verifier")).toBeTruthy(); }
    if (revokeOnToken) allowed = false;
    if (failToken) return Response.json({ error: "invalid_grant" }, { status: 400 });
    return Response.json({ access_token: "synthetic-managed-access-" + state.refreshes, refresh_token: "synthetic-managed-refresh", token_type: "Bearer", expires_in: 60 });
  });
  const service = () => createManagedOAuth({ repository, cipher, profile: () => live, admin: async () => allowed ? "allowed" : "denied", origin: () => configuredOrigin ?? undefined, hash: catalogSha256, random: oauthRandom, now: () => now, send });
  const hash = "a".repeat(64), selection = { profile_id: base.profile_id, expected_revision: base.revision };
  const begin = async () => { const result = await service().run(hash, "begin", selection); expect(result.state).toBe("started"); if (result.state !== "started") throw new Error(JSON.stringify(result)); return new URL(result.authorization_url).searchParams.get("state")!; };
  return { service, begin, hash, selection, state, posts, send, repository, record: () => record, now: () => { now += 40_000; },
    callback: (value: string) => ({ state: value, code: "synthetic-one-use-code", iss: issuer }), fail: () => { failToken = true; }, revokeOnToken: () => { revokeOnToken = true; }, privateToken: () => { privateToken = true; }, pause: () => { live = { ...live, revision: 3, enabled: false }; } };
}
it.each([false, true])("OAuth discovers provider and registers automatically (CIMD=%s), survives restart and binds the browser session", async cimd => {
  const f = oauthFixture(cimd), state = await f.begin();
  expect(f.state.registration).toBe(cimd ? 0 : 1); expect(JSON.stringify(f.record())).not.toContain("fixture-client");
  expect(await f.service().run("b".repeat(64), "complete", f.callback(state))).toMatchObject({ state: "failed", code: "invalid_callback" });
  expect(f.state.exchanges).toBe(0);
  expect(await f.service().run(f.hash, "complete", f.callback(state))).toEqual({ state: "linked", profile_id: base.profile_id });
  expect(JSON.stringify(f.record())).not.toContain("synthetic-managed"); expect(f.record()?.verifier).toBeUndefined();
  expect(await f.service().run(f.hash, "complete", f.callback(state))).toMatchObject({ state: "failed", code: "invalid_callback" }); expect(f.state.exchanges).toBe(1);
  const lease = await f.service().credential({ ...base, authentication: "oauth" }, new AbortController().signal, async () => undefined); expect(lease.current()).toBe(true);
  f.now(); const refreshed = await f.service().credential({ ...base, authentication: "oauth" }, new AbortController().signal, async () => undefined); expect(f.state.refreshes).toBe(1); expect(lease.current()).toBe(false);
  expect(await f.service().run(f.hash, "revoke", f.selection)).toMatchObject({ state: "revoked" }); expect(refreshed.current()).toBe(false); expect(f.record()?.tokens).toBeUndefined();
});
it("OAuth rejects issuer mixup and never retries an invalid one-use code", async () => {
  const f = oauthFixture(), state = await f.begin();
  expect(await f.service().run(f.hash, "complete", { ...f.callback(state), iss: "https://attacker.com" })).toMatchObject({ state: "failed" }); expect(f.state.exchanges).toBe(0);
  const again = await f.begin(); f.fail(); expect(await f.service().run(f.hash, "complete", f.callback(again))).toMatchObject({ state: "failed" }); expect(f.state.exchanges).toBe(1);
  expect(await f.service().run(f.hash, "complete", f.callback(again))).toMatchObject({ state: "failed", code: "invalid_callback" }); expect(f.state.exchanges).toBe(1);
});
it("OAuth does not persist tokens after browser authorization is revoked during exchange", async () => {
  const f = oauthFixture(), state = await f.begin(); f.revokeOnToken();
  expect(await f.service().run(f.hash, "complete", f.callback(state))).toMatchObject({ state: "failed" }); expect(f.record()?.tokens).toBeUndefined();
});
it("OAuth rejects a private discovered token endpoint before registration or token exchange", async () => {
  const f = oauthFixture(); f.privateToken(); expect(await f.service().run(f.hash, "begin", f.selection)).toMatchObject({ state: "failed", code: "provider_unsupported" }); expect(f.posts).toHaveLength(0);
});
it("OAuth claims a rotating refresh token before concurrent callers can reuse it", async () => {
  const f = oauthFixture(), state = await f.begin();
  await f.service().run(f.hash, "complete", f.callback(state)); f.now();
  const credential = () => f.service().credential({ ...base, authentication: "oauth" }, new AbortController().signal, async () => undefined);
  const results = await Promise.allSettled([credential(), credential()]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(f.state.refreshes).toBe(1); expect(f.record()?.state).toBe("ready");
});
it("OAuth does not replay a failed refresh after service restart", async () => {
  const f = oauthFixture(), state = await f.begin();
  await f.service().run(f.hash, "complete", f.callback(state)); f.now(); f.fail();
  const credential = () => f.service().credential({ ...base, authentication: "oauth" }, new AbortController().signal, async () => undefined);
  await expect(credential()).rejects.toThrow();
  await expect(credential()).rejects.toThrow();
  expect(f.state.refreshes).toBe(1); expect(f.record()?.state).toBe("refreshing");
});
it("managed OAuth SQLite claims survive repository recreation and reject stale writers", async () => {
  const namespace = (env as unknown as { CAPABILITIES: DurableObjectNamespace }).CAPABILITIES;
  await runInDurableObject(namespace.get(namespace.idFromName("managed-storage-test")), async (_instance, state) => {
    const open = () => new ManagedOAuthState(state.storage, () => undefined);
    const record: ManagedOAuthRecord = { profile_id: "durable", profile_revision: 2, revision: 1, state: "pending",
      session_hash: "a".repeat(64), state_hash: "b".repeat(64), origin, expires_at: 1_800_000_060_000, token_expires_at: 0 };
    expect(open().replace(record, 0)).toBe(true); expect(open().find(record.state_hash)).toEqual(record);
    const claimed = { ...record, revision: 2, state: "exchanging" as const };
    expect(open().replace(claimed, 1)).toBe(true); expect(open().replace(claimed, 1)).toBe(false);
    expect(open().read(record.profile_id)).toEqual(claimed);
    expect(() => open().replace({ ...claimed, revision: 3, state_hash: "invalid" }, 2)).toThrow();
    expect(open().read(record.profile_id)?.revision).toBe(2);
  });
});
it("OAuth binds the authenticated browser origin and refreshes after restart without a deployment origin variable", async () => {
  const f = oauthFixture(false, null);
  const start = await f.service().run(f.hash, "begin", f.selection, origin);
  expect(start.state).toBe("started"); if (start.state !== "started") throw new Error("Authorization did not start");
  const state = new URL(start.authorization_url).searchParams.get("state")!;
  expect(f.record()?.origin).toBe(origin);
  expect(await f.service().run(f.hash, "complete", f.callback(state), "https://other.company.com")).toMatchObject({ state: "failed", code: "invalid_callback" });
  expect(f.state.exchanges).toBe(0);
  expect(await f.service().run(f.hash, "complete", f.callback(state), origin)).toMatchObject({ state: "linked" });
  f.now();
  const lease = await f.service().credential({ ...base, authentication: "oauth" }, new AbortController().signal, async () => undefined);
  expect(f.state.refreshes).toBe(1); expect(lease.current()).toBe(true);
});
