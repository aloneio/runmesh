import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { CapabilitiesDOv1 } from "../src/capabilities-do.js";
import type { ManagedOAuthRecord } from "../src/contracts/managed-oauth.js";
import { ADMIN_CSRF_COOKIE, ADMIN_SESSION_COOKIE } from "../src/http/constants.js";
import { handleCentralDiscovery } from "../src/http/central-discovery.js";
import type { WorkerEnv } from "../src/platform/env.js";
import { ManagedOAuthState } from "../src/platform/connectors/managed-store.js";
import { createSecretStorage } from "../src/platform/secret-storage.js";
import { passwordVerifier, randomBase64Url, sha256Hex } from "../src/security.js";

const origin = "https://app.example.com", endpoint = "https://remote.example.com/mcp", profileId = "credential-fixture";

async function fixture(linked = true) {
  const raw = randomBase64Url(), csrf = randomBase64Url(), hash = await sha256Hex(raw), csrfHash = await sha256Hex(csrf);
  const registry = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
  const verifier = await passwordVerifier("managed-credential-fixture-password");
  await runInDurableObject(registry, instance => {
    const now = Date.now(); instance.setupAdmin(verifier, now);
    expect(instance.createAdminSession(hash, csrfHash, now + 60_000, now, 1)).toBe(true);
  });
  let admission = 0, failureStatus: number | undefined;
  const configured = { ...env, RUNMESH_PUBLIC_ORIGIN: origin, REGISTRY: {
    idFromName: () => "registry", get: () => ({ fetch: (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/auth/sessions/verify");
      // Discovery and transport admission succeed; fail revalidation inside credential acquisition.
      if (++admission === 3 && failureStatus !== undefined) return Promise.resolve(new Response(null, { status: failureStatus }));
      return env.REGISTRY.get(env.REGISTRY.idFromName("registry")).fetch(request);
    } }),
  } } as unknown as WorkerEnv;
  const namespace = (env as unknown as { CAPABILITIES: DurableObjectNamespace<CapabilitiesDOv1> }).CAPABILITIES;
  const stub = namespace.get(namespace.idFromName("credential-fixture-" + crypto.randomUUID()));
  let owner: CapabilitiesDOv1;
  await runInDurableObject(stub, (_original, state) => { owner = new CapabilitiesDOv1(state, configured); });
  const call = <T>(action: (instance: CapabilitiesDOv1) => Promise<T>) => runInDurableObject(stub, () => action(owner));
  expect(await call(instance => instance.mutateProfile(hash, { action: "connect", profile_id: profileId,
    connector_id: "example", endpoint, authentication: "oauth" }))).toMatchObject({ state: "written" });
  expect(await call(instance => instance.mutateProfile(hash, { action: "enable", profile_id: profileId,
    expected_revision: 1 }))).toMatchObject({ state: "written" });
  if (linked) await runInDurableObject(stub, async (_instance, state) => {
    const cipher = createSecretStorage(state.id.toString(), () => env.INTERNAL_CONTROL_SECRET), stateHash = "b".repeat(64);
    const record: ManagedOAuthRecord = { profile_id: profileId, profile_revision: 2, revision: 1, state: "ready",
      session_hash: hash, state_hash: stateHash, origin, expires_at: Date.now() + 60_000, token_expires_at: Date.now() + 3_600_000,
      discovery: {}, client: await cipher.seal(`connection:${profileId}:${stateHash}:client`, { client_id: "synthetic-client" }),
      tokens: await cipher.seal(`connection:${profileId}:${stateHash}:tokens`, { access_token: "synthetic-access-token", token_type: "Bearer" }) };
    expect(new ManagedOAuthState(state.storage, () => undefined).replace(record, 0)).toBe(true);
  });
  const record = () => runInDurableObject(stub, (_instance, state) => new ManagedOAuthState(state.storage, () => undefined).read(profileId));
  const httpEnv = { ...env, CAPABILITIES: { idFromName: () => "central", get: () => ({
    discoverRemote: (session: string, id: string, revision: number) => call(instance => instance.discoverRemote(session, id, revision)),
  }) } } as unknown as WorkerEnv;
  const discover = () => {
    const request = new Request(`${origin}/admin/central/discovery/${profileId}`, { method: "POST",
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${raw}; ${ADMIN_CSRF_COOKIE}=${csrf}`, origin,
        "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ expected_revision: 0 }) });
    return handleCentralDiscovery(request, httpEnv, new URL(request.url));
  };
  const upstream = createMcpHandler(() => {
    const server = new McpServer({ name: "credential-fixture", version: "1" });
    server.registerTool("lookup", { description: "Read a fixture value", inputSchema: z.object({}).strict() },
      async () => ({ content: [{ type: "text", text: "fixture" }] }));
    return server;
  }, { route: "/mcp", legacy: "stateless" });
  const methods: string[] = [];
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(String(input)).toBe(endpoint);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-access-token");
    methods.push(JSON.parse(String(init?.body)).method);
    return upstream.fetch(new Request(input, init));
  });
  return { call, hash, record, discover, network, methods,
    failAdmission: (status?: number) => { admission = 0; failureStatus = status; }, admission: () => admission };
}

async function expectRecovery(f: Awaited<ReturnType<typeof fixture>>, before: ManagedOAuthRecord | undefined) {
  const recovered = await f.discover();
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toMatchObject({ state: "written" });
  expect(f.methods).toContain("tools/list");
  expect(await f.record()).toEqual(before);
}

it.each([
  { status: 503, code: "remote_dependency_unavailable" },
  { status: 403, code: "remote_permission_denied" },
])("credential admission HTTP $status keeps its classification and the linked account", async ({ status, code }) => {
  const f = await fixture();
  try {
    const before = await f.record();
    f.failAdmission(status);
    const failed = await f.discover();
    expect(f.admission()).toBe(3);
    expect(f.network).not.toHaveBeenCalled();
    expect(await f.record()).toEqual(before);
    expect(failed.status).toBe(status);
    expect(await failed.json()).toEqual({ error: { code, operation_state: "not_started" } });
    f.failAdmission();
    await expectRecovery(f, before);
  } finally { f.network.mockRestore(); }
});

it("credential decryption failure preserves the linked account and recovers without OAuth", async () => {
  const f = await fixture();
  const decrypt = vi.spyOn(crypto.subtle, "decrypt").mockRejectedValueOnce(new Error("synthetic cipher failure"));
  try {
    const before = await f.record(), failed = await f.discover();
    expect(decrypt).toHaveBeenCalledOnce();
    expect(f.network).not.toHaveBeenCalled();
    expect(await f.record()).toEqual(before);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: { code: "remote_dependency_unavailable", operation_state: "not_started" } });
    decrypt.mockRestore();
    await expectRecovery(f, before);
  } finally { decrypt.mockRestore(); f.network.mockRestore(); }
});

it.each(["missing", "revoked"] as const)("a %s account still requests OAuth authorization", async state => {
  const f = await fixture(state !== "missing");
  try {
    if (state === "revoked") expect(await f.call(instance => instance.connectionOAuth(f.hash, "revoke", {
      profile_id: profileId, expected_revision: 2 }))).toEqual({ state: "revoked", profile_id: profileId });
    const before = await f.record(), response = await f.discover();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "authorization_required" });
    expect(f.network).not.toHaveBeenCalled();
    expect(await f.record()).toEqual(before);
  } finally { f.network.mockRestore(); }
});
