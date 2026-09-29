import { expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import type { ConnectionProfile } from "../src/contracts/connectors.js";
import { createHttpRemoteConnector } from "../src/platform/connectors/remote-client.js";
import { connectionPolicy } from "../src/platform/connectors/connection-policy.js";
import { createManagedOAuthProtocol } from "../src/platform/connectors/managed-oauth.js";
import { managedOAuthFetch } from "../src/platform/connectors/managed-oauth-http.js";
import { createManagedOAuth } from '../src/application/connectors/managed-oauth.js';
import type { ManagedOAuthRecord, ManagedOAuthProtocol } from '../src/contracts/managed-oauth.js';
import { createOAuthCipher, oauthRandom } from "../src/platform/connectors/oauth-crypto.js";
import { ManagedOAuthState } from "../src/platform/connectors/managed-store.js";
import { catalogSha256 } from "../src/platform/capabilities/catalog-crypto.js";
import { CapabilitiesDOv1 } from "../src/capabilities-do.js";
import type { WorkerEnv } from "../src/platform/env.js";
import { handleConnections } from "../src/http/central-connections.js";
import { ADMIN_CSRF_COOKIE, ADMIN_SESSION_COOKIE } from "../src/http/constants.js";
import { passwordVerifier, randomBase64Url, sha256Hex } from "../src/security.js";

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
  let tokenResponse: Record<string, unknown> = {};
  const posts: string[] = [], state = { registration: 0, exchanges: 0, refreshes: 0 };
  const cipher = createOAuthCipher("managed-test", secret);
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
      if (challengeMetadata && address === challengeMetadata) return Response.json({ resource: endpoint, authorization_servers: [issuer], scopes_supported: ["read"] });
      if (challengeMetadata && address.includes("oauth-protected-resource")) return new Response(null, { status: 404 });
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
    return Response.json({ access_token: "synthetic-managed-access-" + state.refreshes, refresh_token: "synthetic-managed-refresh", token_type: "Bearer", expires_in: 60, ...tokenResponse });
  });
  const service = () => createManagedOAuth({ repository, cipher, profile: () => live, admin: async () => allowed ? "allowed" : "denied", origin: () => configuredOrigin ?? undefined, hash: catalogSha256, random: oauthRandom, now: () => now, protocol: protocol ?? createManagedOAuthProtocol(send) });
  const hash = "a".repeat(64), selection = { profile_id: base.profile_id, expected_revision: base.revision };
  const begin = async () => { const result = await service().run(hash, "begin", selection); expect(result.state).toBe("started"); if (result.state !== "started") throw new Error(JSON.stringify(result)); return new URL(result.authorization_url).searchParams.get("state")!; };
  return { service, begin, hash, selection, state, posts, send, repository, record: () => record, now: (elapsed = 40_000) => { now += elapsed; },
    callback: (value: string) => ({ state: value, code: "synthetic-one-use-code", iss: issuer }), fail: () => { failToken = true; }, revokeOnToken: () => { revokeOnToken = true; }, privateToken: () => { privateToken = true; }, pause: () => { live = { ...live, revision: 3, enabled: false }; },
    resume: () => { live = { ...live, revision: 4, enabled: true }; return live; },
    challenge: (url: string) => { challengeMetadata = url; }, tokens: (value: Record<string, unknown>) => { tokenResponse = value; } };
}
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
it("OAuth account revocation during resume admission prevents rebinding", async () => {
  const f = oauthFixture(), state = await f.begin();
  await f.service().run(f.hash, "complete", f.callback(state));
  f.pause(); const selected = f.resume(); let admissions = 0;
  await expect(f.service().credential(selected, new AbortController().signal, async () => {
    if (++admissions === 2) await f.service().run(f.hash, "revoke", { ...f.selection, expected_revision: selected.revision });
  })).rejects.toMatchObject({ code: "reauthorization_required" });
  expect(f.record()?.state).toBe("revoked"); expect(f.record()?.tokens).toBeUndefined();
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
  await expect(protocol.begin({ endpoint, origin, state: oauthRandom(), signal: new AbortController().signal, authorize: async () => undefined })).rejects.toThrow();
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
  await expect(protocol.begin({ endpoint, origin, state: oauthRandom(), signal: new AbortController().signal,
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
it.each([false, true])("OAuth HTTP handoff and callback persist through the real owner (CIMD=%s)", async cimd => {
  const raw = randomBase64Url(), csrf = randomBase64Url(), hash = await sha256Hex(raw), csrfHash = await sha256Hex(csrf);
  const verifier = await passwordVerifier("oauth-integration-administrator-password");
  const registry = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
  await runInDurableObject(registry, owner => {
    const now = Date.now(); owner.setupAdmin(verifier, now);
    expect(owner.createAdminSession(hash, csrfHash, now + 60_000, now, 1)).toBe(true);
  });
  const namespace = (env as unknown as { CAPABILITIES: DurableObjectNamespace<CapabilitiesDOv1> }).CAPABILITIES;
  const stub = namespace.get(namespace.idFromName("oauth-integration-" + crypto.randomUUID()));
  const bindings = { ...env, RUNMESH_PUBLIC_ORIGIN: origin } as WorkerEnv;
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
      expect(f.record()?.state).toBe("exchanging"); await input.authorize();
      expect(input.client).toEqual({ registration: 'opaque' }); expect(input.verifier).toBe('opaque-verifier');
      return { access_token: 'synthetic-port-access', token_type: 'Bearer', refresh_token: 'synthetic-port-refresh', expires_in: 60 };
    }),
    refresh: vi.fn(async input => {
      expect(f.record()?.state).toBe("refreshing"); await input.authorize();
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
    complete: async () => ({ access_token: 'synthetic-initial-token', refresh_token: 'synthetic-refresh-token', token_type: 'Bearer', expires_in: 1 }),
    refresh: vi.fn(async () => ({ access_token: 'synthetic-short-lived-token', token_type: 'Bearer', expires_in: 2 })),
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
