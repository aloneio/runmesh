import { env, SELF, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { ADMIN_CSRF_COOKIE, ADMIN_SESSION_COOKIE } from "../src/http/constants.js";
import { handleCentralAdmin } from "../src/http/central.js";
import { passwordVerifier, randomBase64Url, sha256Hex } from "../src/security.js";
import type { WorkerEnv } from "../src/platform/env.js";
import type { CapabilitiesDOv1 } from "../src/capabilities-do.js";
import { handleBrowserAdmin } from "../src/http/admin.js";
import { localizeHtmlResponse } from "../src/i18n/html.js";
import { secretCreatedPage } from "../src/admin/auth-views.js";

const registry = () => env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
const namespace = () => (env as unknown as { CAPABILITIES: DurableObjectNamespace<CapabilitiesDOv1> }).CAPABILITIES;
const central = () => namespace().get(namespace().idFromName("central"));
const configured = () => ({ ...env, RUNMESH_PUBLIC_ORIGIN: "https://worker.test" }) as WorkerEnv;
const creation = { action: "connect", connector_id: "test-docs", endpoint: "https://docs.example.com/mcp", authentication: "none" };

it("direct public connections and Skill installation are available without deployment endpoint configuration", async () => {
  const admin = await session();
  const request = new Request('https://worker.test/admin/central?lang=zh-CN', { headers: admin.headers });
  const config = { ...configured(), CENTRAL_SKILLS_ENABLED: '1', CENTRAL_VAULT_KEYRING: undefined };
  const response = localizeHtmlResponse(request, await handleBrowserAdmin(request, config, new URL(request.url)));
  expect(response.status).toBe(200);
  const markup = await response.text();
  expect(markup).toContain('MCP 地址');
  expect(markup).toContain('无身份验证');
  expect(markup).toContain('value="oauth"');
  expect(markup).not.toContain('<fieldset disabled>');
  expect(markup).not.toContain('data-central-admin');
  expect(markup).not.toContain('name="token"');
  expect(markup).toContain('data-skill-import');
  expect(markup).toContain('AI 连接');
  expect(markup).not.toContain('CENTRAL_VAULT_KEYRING');
});

it("client handoff opens the shared library without putting its credential in the link", () => {
  const page = secretCreatedPage('MCP client created', 'https://worker.test/synthetic-secret/mcp', 'client-product');
  expect(page).toContain('href="/admin/central"');
  expect(page).toContain('Copy this connection URL into your AI client.');
  expect(page).not.toContain('client=synthetic-secret');
  expect(secretCreatedPage('MCP client created', 'https://worker.test/synthetic-secret/mcp')).not.toContain('<section class="central-next-step">');
});
const url = (id: string) => `https://worker.test/admin/central/profiles/${id}`;

async function session() {
  const raw = randomBase64Url(), csrf = randomBase64Url();
  const hash = await sha256Hex(raw), csrfHash = await sha256Hex(csrf), verifier = await passwordVerifier("central-test-administrator-password");
  await runInDurableObject(registry(), instance => {
    const now = Date.now(); instance.setupAdmin(verifier, now);
    expect(instance.createAdminSession(hash, csrfHash, now + 60_000, now, 1)).toBe(true);
  });
  return { hash, headers: { cookie: `${ADMIN_SESSION_COOKIE}=${raw}; ${ADMIN_CSRF_COOKIE}=${csrf}`,
    origin: "https://worker.test", "content-type": "application/json", "x-csrf-token": csrf } };
}

it("W03 admin HTTP stores connection metadata, defaults disabled and checks revisions", async () => {
  const admin = await session(), id = "profile-" + crypto.randomUUID();
  const call = (value: unknown) => SELF.fetch(url(id), { method: "POST", headers: admin.headers, body: JSON.stringify(value) });
  const created = await call(creation);
  expect(created.status).toBe(200); expect(created.headers.get("cache-control")).toBe("no-store");
  expect(await created.json()).toMatchObject({ state: "written", profile: { enabled: false, revision: 1, authentication: "none", credential: null } });
  expect(await (await call({ action: "enable", expected_revision: 1 })).json()).toMatchObject({ profile: { enabled: true, revision: 2 } });
  const stale = await call({ action: "disable", expected_revision: 1 });
  expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ error: { current_revision: 2, operation_state: "not_started" } });
  expect(await (await call({ action: "disable", expected_revision: 2 })).json()).toMatchObject({ profile: { enabled: false, revision: 3 } });
  expect(await (await SELF.fetch(url(id), { headers: admin.headers })).json()).toMatchObject({ state: "found", profile: { profile_id: id, revision: 3 } });
  await runInDurableObject(central(), (_instance, state) => {
    expect(state.storage.sql.exec<{ envelope_json: string }>("SELECT envelope_json FROM connection_profiles_v1 WHERE profile_id=?", id).one().envelope_json).toBe("null");
    expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name IN ('runners','mcp_clients','jobs')").toArray()).toEqual([]);
  });
});

it.each(["create", "create_oauth", "rotate", "rekey"])("removed profile action %s cannot resolve the owner", async action => {
  const admin = await session(), get = vi.fn(() => { throw new Error("must not resolve"); });
  const config = { ...configured(), CAPABILITIES: { idFromName: () => "central", get } } as unknown as WorkerEnv;
  const request = new Request(url("removed-action"), { method: "POST", headers: admin.headers, body: JSON.stringify({ ...creation, action }) });
  expect((await handleCentralAdmin(request, config, new URL(request.url))).status).toBe(400); expect(get).not.toHaveBeenCalled();
});

it.each(["none", "oauth"])("control panel creates an explicit %s connection without a deployment endpoint allowlist", async authentication => {
  const admin = await session(), id = `direct-${crypto.randomUUID()}`;
  const config = { ...configured(), CENTRAL_VAULT_KEYRING: undefined };
  const request = new Request(url(id), { method: "POST", headers: admin.headers, body: JSON.stringify({ action: "connect",
    connector_id: id, endpoint: "https://mcp.provider.com/mcp", authentication }) });
  const response = await handleCentralAdmin(request, config, new URL(request.url));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ state: "written", profile: { profile_id: id, authentication, credential: null, enabled: false, revision: 1 } });
  const enabled = await SELF.fetch(url(id), { method: "POST", headers: admin.headers, body: JSON.stringify({ action: "enable", expected_revision: 1 }) });
  expect(await enabled.json()).toMatchObject({ profile: { authentication, enabled: true, revision: 2 } });
});

it.each(["no-session", "no-csrf", "wrong-csrf", "cross-origin", "bearer-only"])("W03 rejects %s before resolving the owner", async variant => {
  const admin = await session(), headers = new Headers(admin.headers);
  if (variant === "no-session" || variant === "bearer-only") headers.delete("cookie");
  if (variant === "no-csrf") headers.delete("x-csrf-token");
  if (variant === "wrong-csrf") headers.set("x-csrf-token", "incorrect");
  if (variant === "cross-origin") headers.set("origin", "https://untrusted.example");
  if (variant === "bearer-only") headers.set("authorization", `Bearer ${env.ADMIN_TOKEN}`);
  const get = vi.fn(() => { throw new Error("must not resolve"); });
  const local = { ...configured(), CAPABILITIES: { idFromName: () => "central", get } } as unknown as WorkerEnv;
  const request = new Request(url("not-written"), { method: "POST", headers, body: JSON.stringify(creation) });
  const response = await handleCentralAdmin(request, local, new URL(request.url));
  expect(response.status).toBe(403); expect(get).not.toHaveBeenCalled();
});

it("W03 disabled integration avoids the identity and central stores entirely", async () => {
  const get = vi.fn(() => { throw new Error("unexpected identity request"); });
  const local = { ...configured(), CAPABILITIES: undefined, REGISTRY: { idFromName: () => "registry", get } } as unknown as WorkerEnv;
  const request = new Request(url("disabled"), { method: "POST", body: JSON.stringify(creation) });
  const response = await handleCentralAdmin(request, local, new URL(request.url));
  expect(response.status).toBe(404); expect(get).not.toHaveBeenCalled();
});

it("W03 session revoked during a pending request body cannot commit later", async () => {
  const admin = await session(), id = `pending-${crypto.randomUUID()}`;
  let controller!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, pull() { entered(); } }, { highWaterMark: 0 });
  const request = new Request(url(id), { method: "POST", headers: admin.headers, body: stream });
  const pending = handleCentralAdmin(request, configured(), new URL(request.url));
  await reading;
  await runInDurableObject(registry(), instance => { instance.logoutAdminSession(admin.hash); });
  controller.enqueue(new TextEncoder().encode(JSON.stringify(creation))); controller.close();
  expect((await pending).status).toBe(403);
  const fresh = await session();
  expect(await central().getProfile(fresh.hash, id)).toEqual({ state: "missing" });
});

it("W03 concurrent creates commit once without overwriting a competing connection", async () => {
  const admin = await session(), id = `competing-${crypto.randomUUID()}`;
  const responses = await Promise.all([0, 1].map(() => SELF.fetch(url(id), { method: "POST", headers: admin.headers, body: JSON.stringify(creation) })));
  expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
  expect(await central().getProfile(admin.hash, id)).toMatchObject({ state: "found", profile: { revision: 1 } });
});

it.each([null, {}, { state: "private-status-do-not-reflect" }, { state: "conflict", current_revision: "private-status-do-not-reflect" },
  { state: "conflict", current_revision: -1 }, { state: "conflict", current_revision: 1.5 },
])("W03 malformed state-owner receipts cannot inject error content: %j", async result => {
  const admin = await session();
  const local = { ...configured(), CAPABILITIES: { idFromName: () => "central", get: () => ({ mutateProfile: async () => result }) } } as unknown as WorkerEnv;
  const request = new Request(url("invalid-result"), { method: "POST", headers: admin.headers, body: JSON.stringify(creation) });
  const response = await handleCentralAdmin(request, local, new URL(request.url));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: { code: "central_result_unconfirmed", operation_state: "unknown" } });
});

it("W03 wrong profile identity and write/read receipts cannot masquerade as success", async () => {
  const admin = await session();
  const profile = { schema_version: 1, profile_id: "other-profile", connector_id: "docs", endpoint: "https://docs.example/mcp",
    owner: { kind: "instance_admin" }, enabled: false, revision: 1, authentication: "oauth", credential: null };
  for (const state of ["found", "written"]) {
    const local = { ...configured(), CAPABILITIES: { idFromName: () => "central", get: () => ({ getProfile: async () => ({ state, profile }) }) } } as unknown as WorkerEnv;
    const request = new Request(url("expected-profile"), { headers: admin.headers });
    const response = await handleCentralAdmin(request, local, new URL(request.url));
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("other-profile");
  }
});

it("W03 public input caps and closed routing fields prevent profile creation", async () => {
  const admin = await session(), id = `invalid-${crypto.randomUUID()}`;
  const oversized = await SELF.fetch(url(id), { method: "POST", headers: admin.headers, body: "x".repeat(16_385) });
  expect(oversized.status).toBe(413);
  for (const extra of [{ profile_id: "other" }, { owner: { kind: "other" } }, { expected_revision: 0 }]) {
    const response = await SELF.fetch(url(id), { method: "POST", headers: admin.headers, body: JSON.stringify({ ...creation, ...extra }) });
    expect(response.status).toBe(400);
  }
  expect(await central().getProfile(admin.hash, id)).toEqual({ state: "missing" });
});


it('product service names preserve Unicode without changing endpoint or credential boundaries', async () => {
  const admin = await session(), id = 'named-' + crypto.randomUUID();
  const response = await SELF.fetch(url(id), { method: 'POST', headers: admin.headers,
    body: JSON.stringify({ ...creation, display_name: '团队文档 <script>' }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ profile: { display_name: '团队文档 <script>', enabled: false } });
  expect(await (await SELF.fetch(url(id), { headers: admin.headers })).json()).toMatchObject({ profile: { display_name: '团队文档 <script>' } });
  for (const display_name of ['', 'a'.repeat(65), 'bad\nname']) {
    expect((await SELF.fetch(url('invalid-name-' + crypto.randomUUID()), { method: 'POST', headers: admin.headers,
      body: JSON.stringify({ ...creation, display_name }) })).status).toBe(400);
  }
});
