import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { oauthRuntimeFixture, oauthClient, oauthAdmin, oauthRegistry } from "./oauth-fixture.js";
import { handleCentralAdmin } from "../src/http/central.js";
import { createOAuthCipher, oauthChallenge } from "../src/platform/connectors/oauth-crypto.js";
import { oauthTokenContext } from "../src/contracts/oauth-values.js";
import { OAuthState } from "../src/platform/connectors/oauth-store.js";
import type { OAuthLink } from "../src/contracts/oauth.js";
import { oauthPolicy } from "../../../test/domain/oauth-fixtures.js";
afterEach(() => vi.restoreAllMocks());

it("W06 HTTP PKCE consent, encrypted storage and two-account MCP calls require no Runner", async () => {
  const f = await oauthRuntimeFixture(), b = await oauthClient();
  const first = await f.link(), second = await f.link(b.principal, "account-B");
  expect(first.params.get("code_challenge_method")).toBe("S256");
  expect(await oauthChallenge(f.exchanges[0]!.get("code_verifier")!)).toBe(first.params.get("code_challenge"));
  expect(first.params.get("state")).not.toBe(second.params.get("state"));
  expect(f.exchanges[0]!.get("redirect_uri")).toBe("https://worker.test/admin/central/oauth/callback");
  expect(await f.call(o => o.discoverRemote(f.admin.hash, "docs", 0, f.client.principal))).toMatchObject({ state: "written" });
  const catalog = await f.call(o => o.getCatalog(f.admin.hash, "docs"));
  if (catalog.state !== "found") throw new Error("missing catalog");
  expect(await f.call(o => o.mutateCatalog(f.admin.hash, { action: "approve", profile_id: "docs", expected_revision: 1,
    digest: catalog.snapshot.digest, tool_names: ["account"] }))).toMatchObject({ state: "written" });
  const tool = catalog.snapshot.tools[0]!;
  for (const client of [f.client, b]) {
    expect(await f.call(o => o.replaceGrant({ client_id: client.principal.client_id, expected_revision: 0, enabled: true,
      rules: [{ kind: "remote_tool", resource_id: tool.tool_id, version: tool.version, connection_profile_id: "docs" }] }))).toMatchObject({ state: "written" });
  }
  const command = { profile_id: "docs", tool_id: tool.tool_id, version: tool.version, arguments: {} };
  expect(await f.call(o => o.callRemote(f.client.principal, command))).toMatchObject({ state: "completed", result: { structuredContent: { account: "account-A" } } });
  expect(await f.call(o => o.callRemote(b.principal, command))).toMatchObject({ state: "completed", result: { structuredContent: { account: "account-B" } } });
  await runInDurableObject(f.stub, async (_, state) => {
    const rows = state.storage.sql.exec<{ link_json: string }>("SELECT link_json FROM oauth_links_v1").toArray();
    expect(rows).toHaveLength(2); expect(JSON.stringify(rows)).not.toContain("private-access-token");
    expect(JSON.stringify(rows)).not.toContain("private-refresh-token");
    expect(state.storage.sql.exec("SELECT * FROM oauth_flows_v1").toArray()).toHaveLength(0);
    const stored = JSON.parse(rows[0]!.link_json) as OAuthLink;
    const cipher = createOAuthCipher(state.id.toString(), () => f.configured.CENTRAL_VAULT_KEYRING, () => []);
    expect(await cipher.open(oauthTokenContext(stored), stored.envelope!)).toHaveProperty("access_token");
    await expect(cipher.open(oauthTokenContext({ ...stored, binding: { ...stored.binding, client_id: "different" } }), stored.envelope!))
      .rejects.toMatchObject({ code: "unavailable" });
  });
  await runInDurableObject(oauthRegistry(), o => { expect(o.listRunners()).toEqual([]); });
});
it("W06 browser callbacks have a static non-reflecting landing and single-use POST", async () => {
  const f = await oauthRuntimeFixture(), flow = await f.start();
  const request = new Request("https://worker.test/admin/central/oauth/callback?code=PRIVATE_CODE&state=PRIVATE_STATE");
  const landing = await handleCentralAdmin(request, f.config, new URL(request.url)), html = await landing.text();
  expect(landing.status).toBe(200); expect(landing.headers.get("cache-control")).toBe("no-store");
  expect(landing.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(html).toContain("history.replaceState"); expect(html).not.toContain("PRIVATE_CODE"); expect(html).not.toContain("PRIVATE_STATE");
  expect(f.exchanges).toHaveLength(0);
  const responses = await Promise.all([f.post("complete", flow.callback), f.post("complete", flow.callback)]);
  expect(responses.filter(r => r.status === 200)).toHaveLength(1); expect(f.exchanges).toHaveLength(1);
  expect((await f.post("complete", flow.callback)).status).toBe(400); expect(f.exchanges).toHaveLength(1);
});
it.each(["csrf", "origin", "session", "issuer"])("W06 rejects invalid %s before token exchange", async bad => {
  const f = await oauthRuntimeFixture(), flow = await f.start(), headers = { ...f.admin.headers };
  if (bad === "csrf") headers["x-csrf-token"] = "invalid";
  if (bad === "origin") headers.origin = "https://elsewhere.example.com";
  if (bad === "session") headers.cookie = (await oauthAdmin()).headers.cookie;
  const response = await f.post("complete", bad === "issuer" ? { ...flow.callback, iss: "https://wrong.example.com" } : flow.callback, headers);
  expect(response.status).not.toBe(200); expect(f.exchanges).toHaveLength(0);
});
it("W06 administrator logout during the token request prevents storing a usable link", async () => {
  const f = await oauthRuntimeFixture(), flow = await f.start(), send = f.network.getMockImplementation()!;
  f.network.mockImplementation(async (url, init) => {
    const response = await send(url, init);
    if (String(url) === oauthPolicy.token_endpoint) await runInDurableObject(oauthRegistry(), o => { o.logoutAdminSession(f.admin.hash); });
    return response;
  });
  expect((await f.post("complete", flow.callback)).status).not.toBe(200);
  await runInDurableObject(f.stub, (_, state) => {
    const link = JSON.parse(state.storage.sql.exec<{ link_json: string }>("SELECT link_json FROM oauth_links_v1").one().link_json) as OAuthLink;
    expect(link.state).toBe("reauthorize"); expect(link.envelope).toBeNull();
  });
});
it("W06 revocation works after OAuth policies and encryption keys are removed", async () => {
  const f = await oauthRuntimeFixture(); await f.link();
  delete f.configured.CENTRAL_OAUTH_POLICIES; delete f.configured.CENTRAL_VAULT_KEYRING;
  const response = await f.post("revoke", f.selection(f.client.principal, 2));
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ state: "revoked", link: { revision: 3 } });
  expect(f.exchanges).toHaveLength(1);
});
it("W06 unknown OAuth storage schema is preserved rather than reset", async () => {
  const f = await oauthRuntimeFixture(); await f.link();
  await runInDurableObject(f.stub, (_, state) => {
    state.storage.sql.exec("UPDATE oauth_meta SET schema_version=9");
    expect(() => new OAuthState(state.storage, () => undefined).read("a".repeat(64))).toThrow();
    expect(state.storage.sql.exec("SELECT * FROM oauth_links_v1").toArray()).toHaveLength(1);
    expect(state.storage.sql.exec<{ schema_version: number }>("SELECT schema_version FROM oauth_meta").one().schema_version).toBe(9);
  });
});
it("W06 malformed provider metadata never authorizes or silently follows new endpoints", async () => {
  const f = await oauthRuntimeFixture(); f.network.mockResolvedValue(Response.json({ issuer: "https://wrong.example.com" }));
  const response = await f.post("begin", f.selection()); expect(response.status).not.toBe(200);
  expect(f.network).toHaveBeenCalledOnce(); expect(f.exchanges).toHaveLength(0);
});
