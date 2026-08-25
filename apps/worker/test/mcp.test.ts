import { env, SELF, runInDurableObject } from "cloudflare:test";
import { passwordVerifier, randomBase64Url, sha256Hex } from "../src/security.js";
import { describe, expect, it } from "vitest";

const password = "administrator-password-for-tests";

type CookieJar = Map<string, string>;

describe.sequential("self-hosted admin and MCP client authentication", () => {
  it("atomically allows exactly one first setup and rejects expired opaque sessions", async () => {
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName(`auth-race-${crypto.randomUUID()}`));
    const verifier = await passwordVerifier("password-for-atomic-setup-test");
    const outcomes = await Promise.all([
      runInDurableObject(registry, (instance) => instance.setupAdmin(verifier, Date.now())),
      runInDurableObject(registry, (instance) => instance.setupAdmin(verifier, Date.now())),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const sessionHash = await sha256Hex(randomBase64Url());
    const csrfHash = await sha256Hex(randomBase64Url());
    await expect(runInDurableObject(registry, (instance) => instance.createAdminSession(sessionHash, csrfHash, Date.now() - 1, Date.now() - 2))).resolves.toBe(true);
    await expect(runInDurableObject(registry, (instance) => instance.verifyAdminSession(sessionHash, Date.now()))).resolves.toBeUndefined();
  });

  it("sets up once, authenticates a session, enforces CSRF, and manages independent secret URLs", async () => {
    const initial = await SELF.fetch("https://worker.test/");
    expect(initial.status).toBe(200);
    const setupCsrf = formToken(await initial.text());
    const setupCookie = cookieFrom(initial, "__Host-rcr_setup_csrf");
    expect(setupCsrf).toBe(setupCookie);
    expect(initial.headers.get("cache-control")).toBe("no-store");
    expect(initial.headers.get("referrer-policy")).toBe("no-referrer");
    expect(initial.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");

    const rejectedSetup = await submit("https://worker.test/setup", { password, confirm_password: password }, new Map(), false);
    expect(rejectedSetup.status).toBe(403);

    const setup = await submit("https://worker.test/setup", { csrf_token: setupCsrf, password, confirm_password: password }, jar([["__Host-rcr_setup_csrf", setupCookie]]));
    expect(setup.status).toBe(303);
    const repeated = await SELF.fetch("https://worker.test/setup", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf_token: setupCsrf, password, confirm_password: password }) });
    expect([403, 409]).toContain(repeated.status);

    const login = await SELF.fetch("https://worker.test/");
    const loginCsrf = formToken(await login.text());
    const loginCookie = cookieFrom(login, "__Host-rcr_login_csrf");
    const wrong = await submit("https://worker.test/login", { csrf_token: loginCsrf, password: "wrong-password" }, jar([["__Host-rcr_login_csrf", loginCookie]]));
    expect(wrong.status).toBe(403);
    const loggedIn = await submit("https://worker.test/login", { csrf_token: loginCsrf, password }, jar([["__Host-rcr_login_csrf", loginCookie]]));
    expect(loggedIn.status).toBe(303);
    const session = cookieFrom(loggedIn, "__Host-rcr_admin_session");
    const csrf = cookieFrom(loggedIn, "__Host-rcr_admin_csrf");
    expect(loggedIn.headers.get("set-cookie")).toContain("HttpOnly");
    expect(loggedIn.headers.get("set-cookie")).toContain("SameSite=Strict");
    const adminJar = jar([["__Host-rcr_admin_session", session], ["__Host-rcr_admin_csrf", csrf]]);

    const deniedCreate = await submit("https://worker.test/admin/clients", { label: "denied", scopes: "coding:read" }, adminJar);
    expect(deniedCreate.status).toBe(403);

    const created = await submit("https://worker.test/admin/clients", { csrf_token: csrf, label: "Read only ChatGPT", scopes: "coding:read" }, adminJar);
    expect(created.status).toBe(200);
    const createdHtml = await created.text();
    const secretUrl = oneTimeSecretUrl(createdHtml);
    expect(secretUrl).toMatch(/^https:\/\/worker\.test\/[A-Za-z0-9_-]{43}\/mcp$/);
    expect(createdHtml).toContain("will not be shown again");

    const direct = await SELF.fetch("https://worker.test/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(toolsList()) });
    expect(direct.status).toBe(404);
    const wrongSecret = await SELF.fetch("https://worker.test/not-a-valid-secret/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(toolsList()) });
    expect(wrongSecret.status).toBe(404);

    const list = await mcp(secretUrl, toolsList());
    expect(list.status).toBe(200);
    const listBody = await readMcp(list) as { result?: { tools?: { name: string }[] } };
    expect(listBody.result?.tools?.map((tool) => tool.name)).toContain("runner_list");
    const readOnlyExec = await mcp(secretUrl, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "exec_start", arguments: { runner_id: "offline", workspace_id: "workspace", command: "echo" } } });
    const readOnlyBody = await readMcp(readOnlyExec) as { result?: { isError?: boolean; structuredContent?: { error?: { code?: string } } } };
    expect(readOnlyBody.result).toMatchObject({ isError: true, structuredContent: { error: { code: "insufficient_scope" } } });

    const dashboard = await SELF.fetch("https://worker.test/admin", { headers: { cookie: cookies(adminJar) } });
    const dashboardText = await dashboard.text();
    expect(dashboardText).toContain("Read only ChatGPT");
    expect(dashboardText).not.toContain(new URL(secretUrl).pathname);
    const clientId = /\/admin\/clients\/(client-[a-f0-9]+)\/rename/.exec(dashboardText)?.[1];
    expect(clientId).toBeDefined();

    const rotated = await submit(`https://worker.test/admin/clients/${clientId as string}/rotate`, { csrf_token: csrf }, adminJar);
    expect(rotated.status).toBe(200);
    const rotatedUrl = oneTimeSecretUrl(await rotated.text());
    expect((await mcp(secretUrl, toolsList())).status).toBe(404);
    expect((await mcp(rotatedUrl, toolsList())).status).toBe(200);

    const revoked = await submit(`https://worker.test/admin/clients/${clientId as string}/revoke`, { csrf_token: csrf }, adminJar);
    expect(revoked.status).toBe(303);
    expect((await mcp(rotatedUrl, toolsList())).status).toBe(404);

    const logout = await submit("https://worker.test/admin/logout", { csrf_token: csrf }, adminJar);
    expect(logout.status).toBe(303);
    expect((await SELF.fetch("https://worker.test/admin", { redirect: "manual", headers: { cookie: cookies(adminJar) } })).status).toBe(303);
  });

  it("invalidates every old session after password change", async () => {
    const loginPage = await SELF.fetch("https://worker.test/");
    const loginCsrf = formToken(await loginPage.text());
    const loginCookie = cookieFrom(loginPage, "__Host-rcr_login_csrf");
    const loggedIn = await submit("https://worker.test/login", { csrf_token: loginCsrf, password }, jar([["__Host-rcr_login_csrf", loginCookie]]));
    const session = cookieFrom(loggedIn, "__Host-rcr_admin_session"); const csrf = cookieFrom(loggedIn, "__Host-rcr_admin_csrf");
    const sessionJar = jar([["__Host-rcr_admin_session", session], ["__Host-rcr_admin_csrf", csrf]]);
    const changed = await submit("https://worker.test/admin/password", { csrf_token: csrf, current_password: password, password: "changed-administrator-password", confirm_password: "changed-administrator-password" }, sessionJar);
    expect(changed.status).toBe(303);
    expect((await SELF.fetch("https://worker.test/admin", { redirect: "manual", headers: { cookie: cookies(sessionJar) } })).status).toBe(303);

    const nextLogin = await SELF.fetch("https://worker.test/");
    const nextCsrf = formToken(await nextLogin.text()); const nextCookie = cookieFrom(nextLogin, "__Host-rcr_login_csrf");
    const oldLogin = await submit("https://worker.test/login", { csrf_token: nextCsrf, password }, jar([["__Host-rcr_login_csrf", nextCookie]]));
    expect(oldLogin.status).toBe(403);
    const fresh = await SELF.fetch("https://worker.test/");
    const freshCsrf = formToken(await fresh.text()); const freshCookie = cookieFrom(fresh, "__Host-rcr_login_csrf");
    const newLogin = await submit("https://worker.test/login", { csrf_token: freshCsrf, password: "changed-administrator-password" }, jar([["__Host-rcr_login_csrf", freshCookie]]));
    expect(newLogin.status).toBe(303);
  });
});

function toolsList(): Record<string, unknown> { return { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }; }
async function mcp(url: string, body: unknown): Promise<Response> { return SELF.fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer deliberately-ignored" }, body: JSON.stringify(body) }); }
async function readMcp(response: Response): Promise<unknown> { const text = await response.text(); if (!response.headers.get("content-type")?.includes("text/event-stream")) return JSON.parse(text) as unknown; const data = text.split("\n").find((line) => line.trimStart().startsWith("data:"))?.trimStart().slice(5).trim(); return data === undefined ? undefined : JSON.parse(data) as unknown; }
function formToken(html: string): string { const token = /name="csrf_token" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1]; if (token === undefined) throw new Error("csrf token absent"); return token; }
function oneTimeSecretUrl(html: string): string { const url = /<code>(https:\/\/worker\.test\/[A-Za-z0-9_-]{43}\/mcp)<\/code>/.exec(html)?.[1]; if (url === undefined) throw new Error("secret URL absent"); return url; }
function cookieFrom(response: Response, name: string): string { const setCookie = response.headers.get("set-cookie") ?? ""; const value = new RegExp(`${name}=([^;]+)`).exec(setCookie)?.[1]; if (value === undefined) throw new Error(`cookie ${name} absent`); return value; }
function jar(entries: readonly (readonly [string, string])[]): CookieJar { return new Map(entries); }
function cookies(values: CookieJar): string { return [...values].map(([name, value]) => `${name}=${value}`).join("; "); }
async function submit(url: string, values: Record<string, string>, valuesJar: CookieJar, origin = true): Promise<Response> { return SELF.fetch(url, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookies(valuesJar), ...(origin ? { origin: "https://worker.test" } : {}) }, body: new URLSearchParams(values) }); }
