import { env, runInDurableObject } from "cloudflare:test";
import { expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { CapabilitiesDOv1 } from "../src/capabilities-do.js";
import { handleCentralAdmin } from "../src/http/central.js";
import { internalHeaders, passwordVerifier, randomBase64Url, sha256Hex } from "../src/security.js";
import { ADMIN_CSRF_COOKIE, ADMIN_SESSION_COOKIE } from "../src/http/constants.js";
import type { WorkerEnv } from "../src/platform/env.js";
import { oauthPolicy } from "../../../test/domain/oauth-fixtures.js";

export const oauthRegistry = () => env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
export async function oauthAdmin() {
  const raw = randomBase64Url(), csrf = randomBase64Url(), hash = await sha256Hex(raw), csrfHash = await sha256Hex(csrf);
  const verifier = await passwordVerifier("oauth-administrator-fixture-password");
  await runInDurableObject(oauthRegistry(), instance => {
    const now = Date.now(); instance.setupAdmin(verifier, now);
    expect(instance.createAdminSession(hash, csrfHash, now + 300_000, now, 1)).toBe(true);
  });
  return { hash, headers: { cookie: `${ADMIN_SESSION_COOKIE}=${raw}; ${ADMIN_CSRF_COOKIE}=${csrf}`,
    origin: "https://worker.test", "content-type": "application/json", "x-csrf-token": csrf } };
}
export async function oauthClient() {
  const secret = randomBase64Url(), client_id = "oauth-" + crypto.randomUUID(), path = "/auth/clients";
  const body = JSON.stringify({ identity_version: 2, client_id, label: "OAuth fixture", native_scopes: [], secret_prefix: "fixture",
    secret_verifier: await sha256Hex(secret) });
  expect((await oauthRegistry().fetch(new Request(`https://registry.internal${path}`, { method: "POST", body,
    headers: await internalHeaders(env.INTERNAL_CONTROL_SECRET, "POST", path, body) }))).status).toBe(200);
  return { secret, principal: { client_id, secret_version: 1 } };
}
export async function oauthRuntimeFixture() {
  const admin = await oauthAdmin(), client = await oauthClient();
  const ns = (env as unknown as { CAPABILITIES: DurableObjectNamespace<CapabilitiesDOv1> }).CAPABILITIES;
  const stub = ns.get(ns.idFromName("oauth-fixture-" + crypto.randomUUID()));
  const configured = { ...env, RUNMESH_PUBLIC_ORIGIN: "https://worker.test", CENTRAL_OAUTH_POLICIES: JSON.stringify([oauthPolicy]),
    CENTRAL_MCP_EGRESS: JSON.stringify({ schema_version: 1, endpoints: [{ endpoint: oauthPolicy.resource, protocol: "2026-07-28" }] }) } as WorkerEnv;
  let instance: CapabilitiesDOv1;
  await runInDurableObject(stub, (_, state) => { instance = new CapabilitiesDOv1(state, configured); });
  const call = <T>(action: (owner: CapabilitiesDOv1) => Promise<T>) => runInDurableObject(stub, () => action(instance));
  const port = { beginOAuth: (hash: string, input: unknown) => call(o => o.beginOAuth(hash, input)),
    completeOAuth: (hash: string, input: unknown) => call(o => o.completeOAuth(hash, input)),
    inspectOAuth: (hash: string, input: unknown) => call(o => o.inspectOAuth(hash, input)),
    revokeOAuth: (hash: string, input: unknown) => call(o => o.revokeOAuth(hash, input)),
    mutateProfile: (hash: string, input: unknown) => call(o => o.mutateProfile(hash, input)) };
  const config = { ...configured, CAPABILITIES: { idFromName: () => "central", get: () => port } } as unknown as WorkerEnv;
  const post = (action: string, input: unknown, headers = admin.headers) => {
    const request = new Request(`https://worker.test/admin/central/oauth/${action}`, { method: "POST", headers, body: JSON.stringify(input) });
    return handleCentralAdmin(request, config, new URL(request.url));
  };
  expect(await call(o => o.mutateProfile(admin.hash, { action: "create_oauth", profile_id: "docs", connector_id: "remote", endpoint: oauthPolicy.resource }))).toMatchObject({ state: "written", profile: { credential: null } });
  expect(await call(o => o.mutateProfile(admin.hash, { action: "enable", profile_id: "docs", expected_revision: 1 }))).toMatchObject({ state: "written" });
  const tokens = new Map<string, string>(), exchanges: URLSearchParams[] = [], calls: string[] = [];
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(init?.redirect).toBe("manual"); expect(init?.credentials).toBe("omit");
    const headers = new Headers(init?.headers); expect(headers.has("cookie")).toBe(false);
    if (String(input) === oauthPolicy.metadata_endpoint) return Response.json({ issuer: oauthPolicy.issuer,
      authorization_endpoint: oauthPolicy.authorization_endpoint, token_endpoint: oauthPolicy.token_endpoint,
      response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
      grant_types_supported: ["authorization_code", "refresh_token"], authorization_response_iss_parameter_supported: true, scopes_supported: ["read"] });
    if (String(input) === oauthPolicy.token_endpoint) {
      expect(headers.has("authorization")).toBe(false);
      const form = new URLSearchParams(String(init?.body)); exchanges.push(form);
      expect(form.get("resource")).toBe(oauthPolicy.resource); expect(form.get("client_id")).toBe(oauthPolicy.oauth_client_id);
      const account = form.get("code") ?? "refreshed", access = "private-access-token-" + account;
      tokens.set(access, account);
      return Response.json({ token_type: "Bearer", access_token: access, refresh_token: "private-refresh-token-" + account, expires_in: 3600, scope: "read" });
    }
    expect(String(input)).toBe(oauthPolicy.resource);
    const access = headers.get("authorization")?.slice(7), account = access === undefined ? undefined : tokens.get(access);
    expect(account).toBeDefined(); calls.push(account!);
    const server = createMcpHandler(() => {
      const mcp = new McpServer({ name: "oauth-resource", version: "1" });
      mcp.registerTool("account", { inputSchema: z.object({}).strict(), outputSchema: z.object({ account: z.string() }).strict() },
        async () => ({ content: [{ type: "text", text: "Account " + account }], structuredContent: { account: account! } }));
      return mcp;
    }, { route: "/mcp", legacy: "stateless" });
    return server.fetch(new Request(input, init));
  });
  const selection = (principal = client.principal, expected_revision = 0) => ({ profile_id: "docs", principal, expected_revision });
  const start = async (principal = client.principal, code = "account-A") => {
    const response = await post("begin", selection(principal)); expect(response.status).toBe(200);
    const started = await response.json() as { state: string; authorization_url: string; link: { revision: number; link_id: string } };
    const params = new URL(started.authorization_url).searchParams;
    return { started, params, callback: { state: params.get("state")!, iss: oauthPolicy.issuer, code } };
  };
  const link = async (principal = client.principal, code = "account-A") => {
    const flow = await start(principal, code), response = await post("complete", flow.callback);
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ state: "linked", link: { state: "ready" } }); return flow;
  };
  return { admin, client, call, config, configured, post, selection, start, link, exchanges, calls, network, stub };
}
