import { expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import type { ConnectionProfile } from "../src/contracts/connectors.js";
import { createHttpRemoteConnector } from "../src/platform/connectors/remote-client.js";
import { connectionPolicy } from "../src/platform/connectors/connection-policy.js";
import { createManagedOAuthProtocol } from "../src/platform/connectors/managed-oauth.js";
import { managedOAuthFetch, validDiscovery } from "../src/platform/connectors/managed-oauth-http.js";
import { createManagedOAuth } from '../src/application/connectors/managed-oauth.js';
import { MANAGED_OAUTH_DISCOVERY_BYTES, type ManagedOAuthRecord, type ManagedOAuthProtocol } from '../src/contracts/managed-oauth.js';
import { createSecretStorage } from "../src/platform/secret-storage.js";
import { SECRET_STORAGE_LIMITS } from "../src/contracts/secret-storage.js";
import { ManagedOAuthState } from "../src/platform/connectors/managed-store.js";
import { catalogSha256 } from "../src/platform/capabilities/catalog-crypto.js";
import { CapabilitiesDOv1 } from "../src/capabilities-do.js";
import type { WorkerEnv } from "../src/platform/env.js";
import { handleConnections } from "../src/http/central-connections.js";
import { ADMIN_CSRF_COOKIE, ADMIN_SESSION_COOKIE } from "../src/http/constants.js";
import { passwordVerifier, randomBase64Url, sha256Hex } from "../src/security.js";

const endpoint = "https://mcp.provider.com/mcp", origin = "https://runmesh.company.com", issuer = "https://login.provider.com";
const base: ConnectionProfile = { schema_version: 1, profile_id: "direct", connector_id: "direct", endpoint, revision: 2, enabled: true, credential: null, authentication: "none", owner: { kind: "instance_admin" } };
it.each(["a", "界"])("OAuth discovery counts UTF-8 bytes at the exact metadata boundary: %s", text => {
  const value = { authorizationServerUrl: issuer, authorizationServerMetadata: { issuer, authorization_endpoint: issuer + "/authorize", token_endpoint: issuer + "/token", description: "" } };
  const encoder = new TextEncoder(), available = MANAGED_OAUTH_DISCOVERY_BYTES - encoder.encode(JSON.stringify(value)).byteLength;
  const width = encoder.encode(text).byteLength;
  value.authorizationServerMetadata.description = text.repeat(Math.floor(available / width)) + "a".repeat(available % width);
  expect(encoder.encode(JSON.stringify(value)).byteLength).toBe(MANAGED_OAUTH_DISCOVERY_BYTES);
  expect(validDiscovery(value, origin)).toBe(true);
  value.authorizationServerMetadata.description += "a";
  expect(validDiscovery(value, origin)).toBe(false);
});

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
  const connector = createHttpRemoteConnector({ rules: p => connectionPolicy(p), credential: async () => null, fetch: send });
  const session = await connector.open(base, new AbortController().signal, () => undefined, async () => undefined);
  const tools = await session.listTools(); expect(tools[0]?.name).toBe("read");
  expect(await session.callTool(tools[0]!, {}, async () => undefined)).toMatchObject({ isError: false }); await session.close();
  expect(execute).toHaveBeenCalledTimes(1); expect(seen.filter(m => m === "tools/call")).toHaveLength(1);
  expect(seen.includes("DELETE")).toBe(mode === "session");
});
it("connections require an explicit supported authentication mode", () => {
  const { authentication: _, ...legacy } = base; expect(connectionPolicy(legacy as ConnectionProfile)).toBeUndefined();
  expect(connectionPolicy({ ...base, endpoint: "https://127.0.0.1/mcp" })).toBeUndefined();
});

const fixtureControlSecret = "test-existing-internal-control-secret";
function oauthFixture(cimd = false, configuredOrigin: string | null = origin, protocol?: ManagedOAuthProtocol, secret: () => unknown = () => fixtureControlSecret) {
  let record: ManagedOAuthRecord | undefined, now = 1_800_000_000_000, allowed = true, live = { ...base, authentication: "oauth" as const };
  let failToken = false, revokeOnToken = false, privateToken = false, challengeMetadata: string | undefined;
  let resource = endpoint;
  let tokenResponse: Record<string, unknown> = {};
  const posts: string[] = [], state = { registration: 0, exchanges: 0, refreshes: 0 };
  const cipher = createSecretStorage("managed-test", secret);
  const repository = { read: () => record ? structuredClone(record) : undefined, find: (hash: string) => record?.state_hash === hash ? structuredClone(record) : undefined, replace: (value: ManagedOAuthRecord, expected: number) => { if ((record?.revision ?? 0) !== expected) return false; record = JSON.parse(JSON.stringify(value)) as ManagedOAuthRecord; return true; } };
  const send = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const address = String(url); expect(init?.redirect).toBe("manual"); expect(init?.credentials).toBe("omit");
    if (address === endpoint) {
      expect(init?.method).toBe("POST"); expect(JSON.parse(String(init?.body))).toMatchObject({ method: "server/discover" });
      expect(new Headers(init?.headers).has("authorization")).toBe(false); expect(new Headers(init?.headers).has("cookie")).toBe(false);
      const quote = String.fromCharCode(34);
      return new Response(null, { status: 401, headers: { "www-authenticate": challengeMetadata
        ? "Bearer resource_metadata=" + quote + challengeMetadata + quote + ", scope=" + quote + "read profile" + quote : "Bearer" } });
    }
    if ((init?.method ?? "GET") === "GET") {
      if (challengeMetadata && address === challengeMetadata) return Response.json({ resource, authorization_servers: [issuer], scopes_supported: ["read"] });
      if (challengeMetadata && address.includes("oauth-protected-resource")) return new Response(null, { status: 404 });
      if (address.includes("oauth-protected-resource")) return Response.json({ resource, authorization_servers: [issuer], scopes_supported: ["read"] });
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
    return Response.json({ access_token: "synthetic-managed-access-" + state.refreshes, refresh_token: "synthetic-managed-refresh", token_type: "Bearer", expires_in: 60, ...tokenResponse });
  });
  const service = (storage = cipher) => createManagedOAuth({ repository, cipher: storage, profile: () => live, admin: async () => allowed ? "allowed" : "denied", origin: () => configuredOrigin ?? undefined, hash: catalogSha256, random: randomBase64Url, now: () => now, protocol: protocol ?? createManagedOAuthProtocol(send) });
  const hash = "a".repeat(64), selection = { profile_id: base.profile_id, expected_revision: base.revision };
  const begin = async () => { const result = await service().run(hash, "begin", selection); expect(result.state).toBe("started"); if (result.state !== "started") throw new Error(JSON.stringify(result)); return new URL(result.authorization_url).searchParams.get("state")!; };
  return { service, begin, hash, selection, state, posts, send, repository, cipher, record: () => record, now: (elapsed = 40_000) => { now += elapsed; },
    callback: (value: string) => ({ state: value, code: "synthetic-one-use-code", iss: issuer }), fail: () => { failToken = true; }, revokeOnToken: () => { revokeOnToken = true; }, privateToken: () => { privateToken = true; }, pause: () => { live = { ...live, revision: 3, enabled: false }; },
    resume: () => { live = { ...live, revision: 4, enabled: true }; return live; },
    challenge: (url: string) => { challengeMetadata = url; }, resource: (value: string) => { resource = value; },
    tokens: (value: Record<string, unknown>) => { tokenResponse = value; } };
}

async function storedOAuthValue(f: ReturnType<typeof oauthFixture>, kind: "client" | "tokens") {
  const record = f.record()!;
  const context = `connection:${record.profile_id}:${record.state_hash}:${kind}`;
  return { record, context, value: await f.cipher.open(context, record[kind]!) as Record<string, unknown> };
}

it.each([20, 30, 60])("OAuth without a refresh token remains usable until its actual %s-second expiry", async lifetime => {
  const f = oauthFixture(); f.tokens({ refresh_token: undefined, expires_in: lifetime });
  const state = await f.begin();
  expect(await f.service().run(f.hash, "complete", f.callback(state))).toMatchObject({ state: "linked" });
  const saved = f.record(), selected = { ...base, authentication: "oauth" as const };
  const credential = () => f.service().credential(selected, new AbortController().signal, async () => undefined);
  const first = await credential(); expect(first.current()).toBe(true);
  f.now(lifetime * 1000 - 1);
  const last = await credential(); expect(last.current()).toBe(true); expect(first.current()).toBe(true);
  expect(f.record()).toEqual(saved); expect(f.state.refreshes).toBe(0);
  f.now(1);
  expect(first.current()).toBe(false); expect(last.current()).toBe(false);
  await expect(credential()).rejects.toMatchObject({ code: "reauthorization_required" });
  expect(f.record()).toEqual(saved); expect(f.state.exchanges).toBe(1); expect(f.state.refreshes).toBe(0);
});

it("OAuth still refreshes a short-lived token early when a refresh token is available", async () => {
  const f = oauthFixture(); f.tokens({ expires_in: 20 });
  const state = await f.begin();
  expect(await f.service().run(f.hash, "complete", f.callback(state))).toMatchObject({ state: "linked" });
  const lease = await f.service().credential({ ...base, authentication: "oauth" }, new AbortController().signal, async () => undefined);
  expect(lease.current()).toBe(true); expect(f.state.exchanges).toBe(1); expect(f.state.refreshes).toBe(1);
});

it("OAuth rechecks actual expiry after awaited admission before returning a credential", async () => {
  const f = oauthFixture(); f.tokens({ refresh_token: undefined, expires_in: 20 });
  const state = await f.begin();
  expect(await f.service().run(f.hash, "complete", f.callback(state))).toMatchObject({ state: "linked" });
  let admissions = 0;
  await expect(f.service().credential({ ...base, authentication: "oauth" }, new AbortController().signal, async () => {
    if (++admissions === 2) f.now(20_000);
  })).rejects.toMatchObject({ code: "reauthorization_required" });
  expect(admissions).toBe(2); expect(f.state.refreshes).toBe(0);
});

it.each([false, true])("OAuth preserves the discovered issuer through encrypted storage and refresh (CIMD=%s)", async cimd => {
  const f = oauthFixture(cimd);
  f.tokens({ issuer: "https://other.provider.com" });
  const state = await f.begin();
  expect((await storedOAuthValue(f, "client")).value.issuer).toBe(issuer);
  expect(await f.service().run(f.hash, "complete", f.callback(state))).toMatchObject({ state: "linked" });
  expect((await storedOAuthValue(f, "tokens")).value.issuer).toBe(issuer);
  f.now();
  await f.service().credential({ ...base, authentication: "oauth" }, new AbortController().signal, async () => undefined);
  expect((await storedOAuthValue(f, "tokens")).value.issuer).toBe(issuer);
  expect(f.state).toEqual({ registration: cimd ? 0 : 1, exchanges: 1, refreshes: 1 });
});

it.each(["https://other.provider.com", issuer + "/"])("OAuth rejects a saved client issuer mismatch before exchanging a code: %s", async changedIssuer => {
  const f = oauthFixture(), state = await f.begin();
  const { record, context, value } = await storedOAuthValue(f, "client");
  const changed = { ...record, revision: record.revision + 1, client: await f.cipher.seal(context, { ...value, issuer: changedIssuer }) };
  expect(f.repository.replace(changed, record.revision)).toBe(true);
  f.send.mockClear();
  expect(await f.service().run(f.hash, "complete", f.callback(state))).toMatchObject({ state: "failed", code: "reauthorization_required", operation_state: "not_started" });
  expect(f.send).not.toHaveBeenCalled(); expect(f.state.exchanges).toBe(0);
  expect(f.record()).toMatchObject({ state: "pending", revision: changed.revision });
});

it.each(["client", "tokens"] as const)("OAuth checks the stored %s issuer before dispatching a refresh", async kind => {
  const f = oauthFixture(), state = await f.begin();
  expect(await f.service().run(f.hash, "complete", f.callback(state))).toMatchObject({ state: "linked" });
  const { record, context, value } = await storedOAuthValue(f, kind);
  const changed = { ...record, revision: record.revision + 1, [kind]: await f.cipher.seal(context, { ...value, issuer: "https://other.provider.com" }) };
  expect(f.repository.replace(changed, record.revision)).toBe(true);
  f.now(); f.send.mockClear();
  await expect(f.service().credential({ ...base, authentication: "oauth" }, new AbortController().signal, async () => undefined)).rejects.toMatchObject({ code: "reauthorization_required" });
  expect(f.send).not.toHaveBeenCalled(); expect(f.state.refreshes).toBe(0);
  expect(f.record()).toMatchObject({ state: "ready", revision: changed.revision });
});

it("OAuth refreshes unstamped stored credentials against their saved discovery after restart", async () => {
  const f = oauthFixture(), state = await f.begin();
  expect(await f.service().run(f.hash, "complete", f.callback(state))).toMatchObject({ state: "linked" });
  for (const kind of ["client", "tokens"] as const) {
    const { record, context, value } = await storedOAuthValue(f, kind);
    const { issuer: _issuer, ...unstamped } = value;
    expect(f.repository.replace({ ...record, revision: record.revision + 1, [kind]: await f.cipher.seal(context, unstamped) }, record.revision)).toBe(true);
  }
  f.now(); f.send.mockClear();
  const lease = await f.service().credential({ ...base, authentication: "oauth" }, new AbortController().signal, async () => undefined);
  expect(lease.current()).toBe(true);
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(String(f.send.mock.calls[0]![0])).toBe(issuer + "/token");
  expect((await storedOAuthValue(f, "tokens")).value.issuer).toBe(issuer);
  expect(f.state).toEqual({ registration: 1, exchanges: 1, refreshes: 1 });
});

it("OAuth code exchange and refresh preserve an exact pathless resource indicator", async () => {
  const f = oauthFixture(), resource = "https://mcp.provider.com";
  f.resource(resource);
  const state = await f.begin();
  expect(await f.service().run(f.hash, "complete", f.callback(state))).toMatchObject({ state: "linked" });
  f.now();
  await f.service().credential({ ...base, authentication: "oauth" }, new AbortController().signal, async () => undefined);
  const requests = f.send.mock.calls.filter(([url]) => String(url) === issuer + "/token");
  expect(requests).toHaveLength(2);
  expect(requests.map(([, init]) => new URLSearchParams(String(init?.body)).get("resource"))).toEqual([resource, resource]);
});

it.each([false, true])("opaque Cloudflare-style tokens survive exchange, persistence and refresh (CIMD=%s)", async cimd => {
  const f = oauthFixture(cimd), token = "synthetic-user:synthetic-grant:opaque-secret_9-";
  f.tokens({ access_token: token, refresh_token: "synthetic-user:synthetic-grant:refresh-secret", scope: "read:".repeat(1500) });
  const state = await f.begin();
  expect(await f.service().run(f.hash, "complete", f.callback(state))).toEqual({ state: "linked", profile_id: base.profile_id });
  const selected = { ...base, authentication: "oauth" as const };
  const credential = await f.service().credential(selected, new AbortController().signal, async () => undefined);
  expect(credential.credential).toEqual({ kind: "bearer", token });
  expect(new Headers({ authorization: "Bearer " + credential.credential.token }).get("authorization")).toBe("Bearer " + token);
  expect(JSON.stringify(f.record())).not.toContain(token);
  f.now();
  const refreshed = await f.service().credential(selected, new AbortController().signal, async () => undefined);
  expect(refreshed.credential.token).toBe(token); expect(refreshed.current()).toBe(true);
  expect(f.state.exchanges).toBe(1); expect(f.state.refreshes).toBe(1);
});
it("maximum-sized access and refresh tokens survive shared storage and refresh", async () => {
  const f = oauthFixture(), token = "a".repeat(4096), refresh = "r".repeat(4096);
  f.tokens({ access_token: token, refresh_token: refresh });
  const state = await f.begin();
  expect(await f.service().run(f.hash, "complete", f.callback(state))).toMatchObject({ state: "linked" });
  f.now();
  const lease = await f.service().credential({ ...base, authentication: "oauth" }, new AbortController().signal, async () => undefined);
  expect(lease.credential.token).toBe(token); expect(lease.current()).toBe(true);
  expect(f.state.refreshes).toBe(1); expect(JSON.stringify(f.record())).not.toContain(refresh);
});

it.each([undefined, "", "short"])("OAuth reports invalid existing server configuration before contacting the provider: %s", async unavailable => {
  let secret: unknown = unavailable;
  const f = oauthFixture(false, origin, undefined, () => secret);
  expect(await f.service().run(f.hash, "begin", f.selection)).toEqual({ state: "failed", code: "configuration_required", operation_state: "not_started" });
  expect(f.send).not.toHaveBeenCalled(); expect(f.record()).toBeUndefined();
  secret = fixtureControlSecret;
  await f.begin();
  expect(f.state.registration).toBe(1);
});
it("an unavailable control secret does not replace an existing account during reconnect", async () => {
  let secret: unknown = fixtureControlSecret;
  const f = oauthFixture(false, origin, undefined, () => secret), state = await f.begin();
  expect(await f.service().run(f.hash, "complete", f.callback(state))).toMatchObject({ state: "linked" });
  const previous = f.record(), requests = f.send.mock.calls.length; secret = undefined;
  expect(await f.service().run(f.hash, "begin", f.selection)).toEqual({ state: "failed", code: "configuration_required", operation_state: "not_started" });
  expect(f.record()).toEqual(previous); expect(f.send.mock.calls).toHaveLength(requests);
  secret = fixtureControlSecret;
  expect((await f.service().credential({ ...base, authentication: "oauth" }, new AbortController().signal, async () => undefined)).current()).toBe(true);
});
it("OAuth callback can resume after a temporary cipher failure before token exchange", async () => {
  let secret: unknown = fixtureControlSecret;
  const f = oauthFixture(false, origin, undefined, () => secret), state = await f.begin();
  const pending = f.record(), requests = f.send.mock.calls.length;
  secret = undefined;
  expect(await f.service().run(f.hash, "complete", f.callback(state))).toMatchObject({ state: "failed" });
  expect(f.record()).toEqual(pending); expect(f.send.mock.calls).toHaveLength(requests);
  secret = fixtureControlSecret;
  expect(await f.service().run(f.hash, "complete", f.callback(state))).toMatchObject({ state: "linked" });
  expect(f.state.exchanges).toBe(1);
});
it("OAuth refresh can resume after its last admission check fails before token dispatch", async () => {
  let failAdmission = false;
  const protocol = createManagedOAuthProtocol((url, init) => f.send(url, init));
  const f = oauthFixture(false, origin, { ...protocol, refresh: input => protocol.refresh({ ...input, authorize: async () => {
    await input.authorize(); if (failAdmission) throw new Error("temporary-admission-unavailable");
  } }) });
  const state = await f.begin();
  await f.service().run(f.hash, "complete", f.callback(state)); f.now();
  const ready = f.record(), requests = f.send.mock.calls.length;
  const owner = f.service();
  const credential = () => owner.credential({ ...base, authentication: "oauth" }, new AbortController().signal, async () => undefined);
  failAdmission = true;
  await expect(credential()).rejects.toThrow("temporary-admission-unavailable");
  expect(f.record()).toEqual(ready); expect(f.send.mock.calls).toHaveLength(requests);
  failAdmission = false;
  expect((await credential()).current()).toBe(true); expect(f.state.refreshes).toBe(1);
});
it("resuming a paused OAuth service keeps the account and replaces old leases without another consent", async () => {
  const f = oauthFixture(), state = await f.begin(), signal = new AbortController().signal;
  expect(await f.service().run(f.hash, "complete", f.callback(state))).toMatchObject({ state: "linked" });
  const selected = { ...base, authentication: "oauth" as const };
  const previous = await f.service().credential(selected, signal, async () => undefined);
  expect(previous.current()).toBe(true);
  f.pause(); expect(previous.current()).toBe(false);
  await expect(f.service().credential(selected, signal, async () => undefined)).rejects.toMatchObject({ code: "reauthorization_required" });
  const resumed = f.resume(); expect(previous.current()).toBe(false);
  const current = await f.service().credential(resumed, signal, async () => undefined);
  expect(current.current()).toBe(true); expect(previous.current()).toBe(false);
  expect(f.record()?.profile_revision).toBe(resumed.revision);
  expect(f.state).toEqual({ registration: 1, exchanges: 1, refreshes: 0 });
});
it("resuming sharing cannot revive an explicitly disconnected OAuth account", async () => {
  const f = oauthFixture(), state = await f.begin();
  await f.service().run(f.hash, "complete", f.callback(state));
  await f.service().run(f.hash, "revoke", f.selection);
  f.pause(); const selected = f.resume();
  await expect(f.service().credential(selected, new AbortController().signal, async () => undefined)).rejects.toMatchObject({ code: "reauthorization_required" });
  expect(f.record()?.state).toBe("revoked"); expect(f.record()?.tokens).toBeUndefined();
});
it("concurrent OAuth resume callers share the current account without another consent or binding write", async () => {
  const f = oauthFixture(), state = await f.begin(), signal = new AbortController().signal;
  await f.service().run(f.hash, "complete", f.callback(state));
  f.pause(); const selected = f.resume(), owner = f.service();
  let admissions = 0, entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const earlier = owner.credential(selected, signal, async () => {
    if (++admissions === 2) { entered(); await gate; }
  });
  try {
    await waiting;
    const later = await owner.credential(selected, signal, async () => undefined);
    const settled = f.record();
    expect(later.current()).toBe(true); expect(settled?.profile_revision).toBe(selected.revision);
    release();
    const original = await earlier;
    expect(original.current()).toBe(true); expect(later.current()).toBe(true);
    expect(original.credential).toEqual(later.credential); expect(f.record()).toEqual(settled);
    expect(f.state).toEqual({ registration: 1, exchanges: 1, refreshes: 0 });
  } finally { release(); await earlier.catch(() => undefined); }
});
it("OAuth account revocation during resume admission prevents rebinding", async () => {
  const f = oauthFixture(), state = await f.begin();
  await f.service().run(f.hash, "complete", f.callback(state));
  f.pause(); const selected = f.resume(); let admissions = 0;
  await expect(f.service().credential(selected, new AbortController().signal, async () => {
    if (++admissions === 2) await f.service().run(f.hash, "revoke", { ...f.selection, expected_revision: selected.revision });
  })).rejects.toMatchObject({ code: "reauthorization_required" });
  expect(f.record()?.state).toBe("revoked"); expect(f.record()?.tokens).toBeUndefined();
});
it.each([false, true])("OAuth resume cannot borrow an account replaced during admission (completed=%s)", async completed => {
  const f = oauthFixture(), state = await f.begin();
  await f.service().run(f.hash, "complete", f.callback(state));
  f.pause(); const selected = f.resume(); let admissions = 0;
  let replacement: ManagedOAuthRecord | undefined;
  await expect(f.service().credential(selected, new AbortController().signal, async () => {
    if (++admissions !== 2) return;
    const owner = f.service(), begun = await owner.run(f.hash, "begin", { ...f.selection, expected_revision: selected.revision });
    expect(begun.state).toBe("started");
    if (begun.state !== "started") throw new Error("replacement authorization did not start");
    if (completed) {
      const callback = f.callback(new URL(begun.authorization_url).searchParams.get("state")!);
      expect(await owner.run(f.hash, "complete", callback)).toMatchObject({ state: "linked" });
    }
    replacement = f.record();
  })).rejects.toMatchObject({ code: "reauthorization_required" });
  expect(f.record()).toEqual(replacement); expect(f.record()?.state).toBe(completed ? "ready" : "pending");
});
it("pause-resume does not revive an unfinished OAuth handoff", async () => {
  const f = oauthFixture(), state = await f.begin();
  f.pause(); const selected = f.resume();
  await expect(f.service().credential(selected, new AbortController().signal, async () => undefined)).rejects.toMatchObject({ code: "reauthorization_required" });
  expect(await f.service().run(f.hash, "complete", f.callback(state))).toMatchObject({ state: "failed", code: "conflict" });
  expect(f.state.exchanges).toBe(0);
});
it("OAuth connects through advertised resource metadata instead of requiring a well-known location", async () => {
  const f = oauthFixture(), metadata = "https://mcp.provider.com/auth/resource"; f.challenge(metadata);
  const started = await f.service().run(f.hash, "begin", f.selection);
  expect(started.state).toBe("started"); if (started.state !== "started") throw new Error("OAuth did not discover the challenge");
  const url = new URL(started.authorization_url); expect(url.searchParams.get("scope")).toBe("read profile");
  expect(f.record()?.discovery?.resourceMetadataUrl).toBe(metadata);
  expect(await f.service().run(f.hash, "complete", f.callback(url.searchParams.get("state")!))).toMatchObject({ state: "linked" });
  expect(f.send.mock.calls.filter(([url]) => String(url) === endpoint)).toHaveLength(1);
  expect(f.state).toEqual({ registration: 1, exchanges: 1, refreshes: 0 });
});
it.each(["https://127.0.0.1/resource", origin + "/resource"])("OAuth rejects an unsafe advertised resource before fetching it: %s", async metadata => {
  const f = oauthFixture(); f.challenge(metadata);
  expect(await f.service().run(f.hash, "begin", f.selection)).toMatchObject({ state: "failed", code: "provider_unsupported" });
  expect(f.send.mock.calls.some(([url]) => String(url) === metadata)).toBe(false); expect(f.posts).toHaveLength(0);
});
it.each([302, 307, 429, 503])("OAuth challenge HTTP %s cancels its body without redirecting or registering", async status => {
  const cancelled = vi.fn(), send = vi.fn(async () => new Response(new ReadableStream({ cancel: cancelled }),
    { status, headers: { location: issuer + "/redirect" } }));
  const protocol = createManagedOAuthProtocol(send);
  await expect(protocol.begin({ endpoint, origin, state: randomBase64Url(), signal: new AbortController().signal, authorize: async () => undefined })).rejects.toThrow();
  expect(send).toHaveBeenCalledTimes(1); expect(cancelled).toHaveBeenCalledTimes(1);
});
it.each(["errored", "rejected", "stalled"] as const)("OAuth redirect denial handles %s response cleanup without following it", async mode => {
  const failure = new Error("upstream response cleanup failed");
  const cancel = vi.fn(() => mode === "rejected" ? Promise.reject(failure) : new Promise<void>(() => undefined));
  const send = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { if (mode === "errored") controller.error(failure); }, cancel,
  }), { status: 302, headers: { location: issuer + "/redirect" } }));
  const request = managedOAuthFetch({ signal: new AbortController().signal, authorize: async () => undefined,
    discovery: () => undefined, origin, phase: "begin", send });
  await expect(request(issuer + "/metadata")).rejects.toThrow("oauth_redirect_denied");
  expect(send).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledTimes(mode === "errored" ? 0 : 1);
  // Let a rejected cleanup reach the runtime's unhandled-rejection check.
  await new Promise(resolve => setTimeout(resolve, 0));
});
it("OAuth revalidates admission after the service challenge before discovery or registration", async () => {
  let allowed = true; const send = vi.fn(async () => { allowed = false; return new Response(null, { status: 401 }); });
  const protocol = createManagedOAuthProtocol(send);
  await expect(protocol.begin({ endpoint, origin, state: randomBase64Url(), signal: new AbortController().signal,
    authorize: async () => { if (!allowed) throw new Error("revoked"); } })).rejects.toThrow("revoked");
  expect(send).toHaveBeenCalledTimes(1);
});
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
it.each([false, true].flatMap(cimd => [false, true].map(configuredOrigin => ({ cimd, configuredOrigin }))))("OAuth HTTP handoff and callback persist through the real owner (CIMD=$cimd, configured origin=$configuredOrigin)", async ({ cimd, configuredOrigin }) => {
  const raw = randomBase64Url(), csrf = randomBase64Url(), hash = await sha256Hex(raw), csrfHash = await sha256Hex(csrf);
  const verifier = await passwordVerifier("oauth-integration-administrator-password");
  const registry = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
  await runInDurableObject(registry, owner => {
    const now = Date.now(); owner.setupAdmin(verifier, now);
    expect(owner.createAdminSession(hash, csrfHash, now + 60_000, now, 1)).toBe(true);
  });
  const namespace = (env as unknown as { CAPABILITIES: DurableObjectNamespace<CapabilitiesDOv1> }).CAPABILITIES;
  const stub = namespace.get(namespace.idFromName("oauth-integration-" + crypto.randomUUID()));
  const bindings = { ...env, RUNMESH_PUBLIC_ORIGIN: configuredOrigin ? origin : undefined } as WorkerEnv;
  let owner: CapabilitiesDOv1;
  await runInDurableObject(stub, (_existing, storage) => { owner = new CapabilitiesDOv1(storage, bindings); });
  const call = <T>(operation: (instance: CapabilitiesDOv1) => Promise<T>) => runInDurableObject(stub, () => operation(owner));
  const configured = { ...bindings, CAPABILITIES: { idFromName: () => "central", get: () => ({
    connectionOAuth: (...args: Parameters<CapabilitiesDOv1["connectionOAuth"]>) => call(instance => instance.connectionOAuth(...args)),
  }) } } as unknown as WorkerEnv;
  expect(await call(instance => instance.mutateProfile(hash, { action: "connect", profile_id: base.profile_id,
    connector_id: base.connector_id, endpoint, authentication: "oauth" }))).toMatchObject({ state: "written" });
  expect(await call(instance => instance.mutateProfile(hash, { action: "enable", profile_id: base.profile_id, expected_revision: 1 }))).toMatchObject({ state: "written" });
  const f = oauthFixture(cimd), network = vi.spyOn(globalThis, "fetch").mockImplementation(f.send);
  const request = async (action: string, input: unknown) => {
    const url = new URL(origin + "/admin/central/connections/" + action);
    return handleConnections(new Request(url, { method: "POST", body: JSON.stringify(input), headers: {
      origin, "content-type": "application/json", "x-csrf-token": csrf,
      cookie: ADMIN_SESSION_COOKIE + "=" + raw + "; " + ADMIN_CSRF_COOKIE + "=" + csrf,
    } }), configured, url);
  };
  try {
    const metadataUrl = new URL(origin + "/admin/central/connections/client-metadata");
    const metadata = await handleConnections(new Request(metadataUrl, { headers: { host: metadataUrl.host } }), configured, metadataUrl);
    expect({ status: metadata.status, body: await metadata.json() }).toMatchObject({ status: 200, body: {
      client_id: metadataUrl.href, redirect_uris: [origin + "/admin/central/connections/callback"],
    } });
    // The real Durable Object uses only the existing control secret binding.
    const begin = await request("begin", f.selection), started = await begin.json() as { authorization_url: string };
    expect({ status: begin.status, body: started }).toMatchObject({ status: 200, body: { state: "started" } });
    await runInDurableObject(stub, (_existing, storage) => { owner = new CapabilitiesDOv1(storage, bindings); });
    const completed = await request("complete", f.callback(new URL(started.authorization_url).searchParams.get("state")!));
    expect({ status: completed.status, body: await completed.json() }).toMatchObject({ status: 200, body: { state: "linked" } });
    expect(f.state).toEqual({ registration: cimd ? 0 : 1, exchanges: 1, refreshes: 0 });
    await runInDurableObject(stub, (_existing, storage) => {
      const record = new ManagedOAuthState(storage.storage, () => undefined).read(base.profile_id);
      expect(record?.state).toBe("ready"); expect(record?.verifier).toBeUndefined();
      expect(JSON.stringify(record)).not.toContain("synthetic-managed");
    });
  } finally { network.mockRestore(); }
});
it("OAuth rejects issuer mixup and never retries an invalid one-use code", async () => {
  const f = oauthFixture(), state = await f.begin();
  expect(await f.service().run(f.hash, "complete", { ...f.callback(state), iss: "https://attacker.com" })).toMatchObject({ state: "failed" }); expect(f.state.exchanges).toBe(0);
  const again = await f.begin(); f.fail(); expect(await f.service().run(f.hash, "complete", f.callback(again))).toMatchObject({ state: "failed" }); expect(f.state.exchanges).toBe(1);
  expect(await f.service().run(f.hash, "complete", f.callback(again))).toMatchObject({ state: "failed", code: "invalid_callback" }); expect(f.state.exchanges).toBe(1);
});
it("concurrent OAuth callbacks claim the authorization code once at token dispatch", async () => {
  const f = oauthFixture(), state = await f.begin();
  const results = await Promise.all([0, 1].map(() => f.service().run(f.hash, "complete", f.callback(state))));
  expect(results.filter(result => result.state === "linked")).toHaveLength(1);
  expect(results.filter(result => result.state === "failed")).toHaveLength(1);
  expect(f.state.exchanges).toBe(1); expect(f.record()?.state).toBe("ready");
});
it("OAuth does not persist tokens after browser authorization is revoked during exchange", async () => {
  const f = oauthFixture(), state = await f.begin(); f.revokeOnToken();
  expect(await f.service().run(f.hash, "complete", f.callback(state))).toMatchObject({ state: "failed" }); expect(f.record()?.tokens).toBeUndefined();
});
it("OAuth rejects a private discovered token endpoint before registration or token exchange", async () => {
  const f = oauthFixture(); f.privateToken(); expect(await f.service().run(f.hash, "begin", f.selection)).toMatchObject({ state: "failed", code: "provider_unsupported" }); expect(f.posts).toHaveLength(0);
});
it("managed account lifecycle uses protocol ports without network or SDK-owned state", async () => {
  const protocol: ManagedOAuthProtocol = {
    begin: vi.fn(async input => {
      expect(f.record()?.state).toBe("starting"); await input.authorize();
      return { authorization_url: issuer + '/authorize?state=' + input.state, discovery: { provider_version: 1 }, client: { registration: 'opaque' }, verifier: 'opaque-verifier' };
    }),
    complete: vi.fn(async input => {
      expect(f.record()?.state).toBe("pending"); await input.authorize(); input.beforeTokenRequest();
      expect(f.record()?.state).toBe("exchanging");
      expect(input.client).toEqual({ registration: 'opaque' }); expect(input.verifier).toBe('opaque-verifier');
      return { access_token: 'synthetic-port-access', token_type: 'Bearer', refresh_token: 'synthetic-port-refresh', expires_in: 60 };
    }),
    refresh: vi.fn(async input => {
      expect(f.record()?.state).toBe("ready"); await input.authorize(); input.beforeTokenRequest();
      expect(f.record()?.state).toBe("refreshing");
      expect(input.refresh_token).toBe('synthetic-port-refresh');
      return { access_token: 'synthetic-port-refreshed', token_type: 'Bearer', expires_in: 60 };
    }),
  };
  const f = oauthFixture(false, origin, protocol), state = await f.begin();
  expect(await f.service().run(f.hash, 'complete', f.callback(state))).toMatchObject({ state: 'linked' });
  f.now(); const lease = await f.service().credential({ ...base, authentication: 'oauth' }, new AbortController().signal, async () => undefined);
  expect(lease.current()).toBe(true); expect(protocol.refresh).toHaveBeenCalledTimes(1); expect(f.send).not.toHaveBeenCalled();
  expect(await f.service().run(f.hash, 'revoke', f.selection)).toMatchObject({ state: 'revoked' }); expect(lease.current()).toBe(false);
});
it.each(['before-dispatch', 'during-response'] as const)("managed OAuth expires a short-lived refreshed lease %s", async phase => {
  const protocol: ManagedOAuthProtocol = {
    begin: async input => ({ authorization_url: issuer + '/authorize?state=' + input.state, discovery: {}, client: {}, verifier: 'fixture-verifier' }),
    complete: async input => { await input.authorize(); input.beforeTokenRequest(); return { access_token: 'synthetic-initial-token', refresh_token: 'synthetic-refresh-token', token_type: 'Bearer', expires_in: 1 }; },
    refresh: vi.fn(async input => { await input.authorize(); input.beforeTokenRequest(); return { access_token: 'synthetic-short-lived-token', token_type: 'Bearer', expires_in: 2 }; }),
  };
  const f = oauthFixture(false, origin, protocol), state = await f.begin();
  expect(await f.service().run(f.hash, 'complete', f.callback(state))).toMatchObject({ state: 'linked' });
  const selected = { ...base, authentication: 'oauth' as const };
  const lease = await f.service().credential(selected, new AbortController().signal, async () => undefined);
  const execute = vi.fn(async () => {
    if (phase === 'during-response') f.now(1);
    return { content: [{ type: 'text' as const, text: 'expired private result' }] };
  });
  const upstream = createMcpHandler(() => {
    const server = new McpServer({ name: 'expiry-fixture', version: '1' });
    server.registerTool('read', { inputSchema: z.object({}).strict() }, execute); return server;
  }, { route: '/mcp', legacy: 'stateless' });
  const send = vi.fn(async (url: string | URL, init?: RequestInit) => upstream.fetch(new Request(url, init)));
  const dispatched = vi.fn();
  const connector = createHttpRemoteConnector({ rules: profile => connectionPolicy(profile), credential: async () => lease, fetch: send });
  const session = await connector.open(selected, new AbortController().signal, dispatched, async () => undefined);
  try {
    const tools = await session.listTools();
    f.now(1999); expect(lease.current()).toBe(true);
    if (phase === 'before-dispatch') f.now(1);
    const requests = send.mock.calls.length;
    await expect(session.callTool(tools[0]!, {}, async () => undefined)).rejects.toMatchObject({ code: phase === 'before-dispatch' ? 'authorization_required' : 'result_withheld' });
    const calls = phase === 'before-dispatch' ? 0 : 1;
    expect(lease.current()).toBe(false); expect(send).toHaveBeenCalledTimes(requests + calls);
    expect(execute).toHaveBeenCalledTimes(calls); expect(dispatched).toHaveBeenCalledTimes(calls);
    expect(protocol.refresh).toHaveBeenCalledOnce();
    const renewed = await f.service().credential(selected, new AbortController().signal, async () => undefined);
    expect(renewed.current()).toBe(true); expect(lease.current()).toBe(false); expect(protocol.refresh).toHaveBeenCalledTimes(2);
  } finally { await session.close(); }
});

it("OAuth claims a rotating refresh token before concurrent callers can reuse it", async () => {
  const f = oauthFixture(), state = await f.begin();
  await f.service().run(f.hash, "complete", f.callback(state)); f.now();
  const credential = () => f.service().credential({ ...base, authentication: "oauth" }, new AbortController().signal, async () => undefined);
  const results = await Promise.allSettled([credential(), credential()]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(f.state.refreshes).toBe(1); expect(f.record()?.state).toBe("ready");
});
it.each(["refreshing-row", "earlier-ready-row", "completed-refresh"] as const)("OAuth reports temporary contention for a same-owner refresh from %s", async phase => {
  let releaseRefresh!: () => void, enteredRefresh!: () => void, releaseRead!: () => void, enteredRead!: () => void;
  const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });
  const refreshEntered = new Promise<void>(resolve => { enteredRefresh = resolve; });
  const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
  const readEntered = new Promise<void>(resolve => { enteredRead = resolve; });
  const protocol = createManagedOAuthProtocol((url, init) => f.send(url, init));
  const f = oauthFixture(false, origin, { ...protocol, refresh: async input => {
    const value = await protocol.refresh(input); enteredRefresh(); await refreshGate; return value;
  } });
  const state = await f.begin(); await f.service().run(f.hash, "complete", f.callback(state)); f.now();
  let reads = 0;
  const owner = f.service({ ...f.cipher, open: async (context, value) => {
    const result = await f.cipher.open(context, value);
    if (phase !== "refreshing-row" && context.endsWith(":tokens") && ++reads === 1) { enteredRead(); await readGate; }
    return result;
  } });
  const credential = () => owner.credential({ ...base, authentication: "oauth" }, new AbortController().signal, async () => undefined);
  let contender: ReturnType<typeof credential> | undefined, refresh: ReturnType<typeof credential> | undefined;
  try {
    if (phase !== "refreshing-row") { contender = credential(); await readEntered; }
    refresh = credential(); await refreshEntered;
    expect(f.record()?.state).toBe("refreshing");
    if (phase === "completed-refresh") { releaseRefresh(); expect((await refresh).current()).toBe(true); }
    if (contender === undefined) contender = credential();
    const rejection = expect(contender).rejects.toMatchObject({ code: "unavailable" }); releaseRead(); await rejection;
    // A contending call cannot release the first caller's ownership.
    if (phase !== "completed-refresh") await expect(credential()).rejects.toMatchObject({ code: "unavailable" });
    releaseRefresh(); expect((await refresh).current()).toBe(true);
    expect((await credential()).current()).toBe(true); expect(f.state.refreshes).toBe(1);
  } finally { releaseRead(); releaseRefresh(); await Promise.allSettled([contender, refresh]); }
});
it("OAuth refresh ownership is scoped to one profile", async () => {
  const f = oauthFixture(), state = await f.begin(); await f.service().run(f.hash, "complete", f.callback(state));
  const original = f.record()!, sibling = { ...original, profile_id: "sibling" };
  for (const kind of ["client", "tokens"] as const) {
    const value = await f.cipher.open(`connection:${original.profile_id}:${original.state_hash}:${kind}`, original[kind]!);
    sibling[kind] = await f.cipher.seal(`connection:${sibling.profile_id}:${sibling.state_hash}:${kind}`, value);
  }
  const profiles = [{ ...base, authentication: "oauth" as const }, { ...base, authentication: "oauth" as const, profile_id: "sibling", endpoint: "https://second.provider.com/mcp" }];
  const records = new Map([[original.profile_id, original], [sibling.profile_id, sibling]]);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const protocol: ManagedOAuthProtocol = { begin: async () => { throw new Error("unused"); }, complete: async () => { throw new Error("unused"); },
    refresh: vi.fn(async input => {
      await input.authorize(); input.beforeTokenRequest();
      if (input.endpoint === base.endpoint) { entered(); await gate; }
      return { access_token: "synthetic-profile-refresh", token_type: "Bearer", expires_in: 60 };
    }) };
  const owner = createManagedOAuth({ cipher: f.cipher, protocol, origin: () => origin, admin: async () => "allowed", now: () => original.token_expires_at - 20_000,
    hash: catalogSha256, random: randomBase64Url, profile: id => profiles.find(profile => profile.profile_id === id),
    repository: { read: id => { const record = records.get(id); return record ? structuredClone(record) : undefined; }, find: () => undefined,
      replace: (value, expected) => { if (records.get(value.profile_id)?.revision !== expected) return false; records.set(value.profile_id, structuredClone(value)); return true; } } });
  const first = owner.credential(profiles[0]!, new AbortController().signal, async () => undefined);
  try {
    await started;
    expect((await owner.credential(profiles[1]!, new AbortController().signal, async () => undefined)).current()).toBe(true);
    expect(records.get(original.profile_id)?.state).toBe("refreshing");
    release(); expect((await first).current()).toBe(true); expect(protocol.refresh).toHaveBeenCalledTimes(2);
  } finally { release(); await first.catch(() => undefined); }
});
it("OAuth does not replay a failed refresh after service restart", async () => {
  const f = oauthFixture(), state = await f.begin();
  await f.service().run(f.hash, "complete", f.callback(state)); f.now(); f.fail();
  const owner = f.service();
  const credential = () => owner.credential({ ...base, authentication: "oauth" }, new AbortController().signal, async () => undefined);
  await expect(credential()).rejects.toThrow();
  await expect(credential()).rejects.toMatchObject({ code: "reauthorization_required" });
  await expect(f.service().credential({ ...base, authentication: "oauth" }, new AbortController().signal, async () => undefined)).rejects.toMatchObject({ code: "reauthorization_required" });
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
it("managed OAuth reads after reconstruction issue no schema writes", async () => {
  const namespace = (env as unknown as { CAPABILITIES: DurableObjectNamespace }).CAPABILITIES;
  await runInDurableObject(namespace.get(namespace.idFromName(crypto.randomUUID())), (_instance, state) => {
    const open = () => new ManagedOAuthState(state.storage, () => undefined);
    expect(open().read("missing")).toBeUndefined();
    const spy = vi.spyOn(state.storage.sql, "exec");
    try {
      for (let n = 0; n < 5; n++) { expect(open().read("missing")).toBeUndefined(); expect(open().find("a".repeat(64))).toBeUndefined(); }
      expect(spy.mock.calls.every(([query]) => query.startsWith("SELECT"))).toBe(true);
    } finally { spy.mockRestore(); }
  });
});
it("managed SQLite storage budgets are derived from the shared cipher and survive restart", async () => {
  const namespace = (env as unknown as { CAPABILITIES: DurableObjectNamespace }).CAPABILITIES;
  await runInDurableObject(namespace.get(namespace.idFromName("managed-storage-budget-test")), async (_instance, state) => {
    const cipher = createSecretStorage("storage-budget", () => fixtureControlSecret);
    const value = "x".repeat(SECRET_STORAGE_LIMITS.plaintext_bytes - 2);
    const record: ManagedOAuthRecord = { profile_id: "maximum-record", profile_revision: 2, revision: 1, state: "ready",
      session_hash: "a".repeat(64), state_hash: "c".repeat(64), origin, expires_at: 1_800_000_060_000, token_expires_at: 1_800_000_060_000,
      client: await cipher.seal("client", value), verifier: await cipher.seal("verifier", "synthetic-verifier"), tokens: await cipher.seal("tokens", value) };
    expect(new ManagedOAuthState(state.storage, () => undefined).replace(record, 0)).toBe(true);
    const restored = new ManagedOAuthState(state.storage, () => undefined).read(record.profile_id)!;
    expect(await cipher.open("client", restored.client!)).toBe(value);
    expect(await cipher.open("tokens", restored.tokens!)).toBe(value);
    expect(JSON.stringify(restored)).not.toContain(value);
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
