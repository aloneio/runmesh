// Audit-only tests: an isolated DO and disposable session, never production.
import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { randomBase64Url, sha256Hex, passwordVerifier } from "../src/security.js";
import { LOGIN_CSRF_COOKIE } from "../src/http/constants.js";

async function fixture() {
  const id = env.REGISTRY.idFromName(`audit-admin-${crypto.randomUUID()}`), stub = env.REGISTRY.get(id);
  const session = randomBase64Url(), csrf = randomBase64Url();
  const hash = await sha256Hex(session), csrfHash = await sha256Hex(csrf), verifier = await passwordVerifier("synthetic-admin-password");
  await runInDurableObject(stub, instance => {
    const now = Date.now(); expect(instance.setupAdmin(verifier, now)).toBe(true);
    expect(instance.createAdminSession(hash, csrfHash, now + 60000, now, 1)).toBe(true);
  });
  const localEnv = { ...env, REGISTRY: { idFromName: () => id, get: () => stub } } as unknown as typeof env;
  const headers = { origin: "https://audit.test", cookie: `__Host-runmesh_admin_session=${session}; __Host-runmesh_admin_csrf=${csrf}`, "content-type": "application/x-www-form-urlencoded" };
  return { stub, localEnv, hash, csrf, headers };
}

it("AUDIT-ADMIN: revoking a session while its POST body is held prevents later credential creation", async () => {
  const f = await fixture();
  let signalVerified!: () => void;
  const verified = new Promise<void>(resolve => { signalVerified = resolve; });
  const original = f.localEnv.REGISTRY.get.bind(f.localEnv.REGISTRY);
  (f.localEnv.REGISTRY as any).get = (id: DurableObjectId) => ({ fetch: async (request: Request) => {
    const response = await original(id).fetch(request);
    if (new URL(request.url).pathname === "/auth/sessions/verify") signalVerified();
    return response;
  } });
  let bodyController!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { bodyController = controller; } });
  const pending = worker.fetch(new Request("https://audit.test/admin/clients", { method: "POST", headers: f.headers, body }), f.localEnv, {} as ExecutionContext);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([verified, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("audit fixture admission timeout")), 2000); })]);
    await runInDurableObject(f.stub, instance => {
      instance.logoutAdminSession(f.hash);
      expect(instance.verifyAdminSession(f.hash, Date.now())).toBeUndefined();
    });
    bodyController.enqueue(new TextEncoder().encode(new URLSearchParams({ csrf_token: f.csrf, label: "audit-after-revocation", scopes: "coding:exec" }).toString()));
    bodyController.close();
    const response = await pending;
    await response.body?.cancel();
    const created = await runInDurableObject(f.stub, instance => instance.listMcpClients().filter(client => client.label === "audit-after-revocation").length);
    console.log(JSON.stringify({ audit: "admin_pending_revocation", response_status: response.status, new_credentials_created: created }));
    expect(created).toBe(0);
  } finally { if (timer !== undefined) clearTimeout(timer); }
});

it("AUDIT-ADMIN: a session dependency outage is not a sign-out", async () => {
  const f = await fixture();
  (f.localEnv.REGISTRY as any).get = () => ({ fetch: () => Response.json({ error: "synthetic dependency unavailable" }, { status: 503 }) });
  const response = await worker.fetch(new Request("https://audit.test/admin", { headers: f.headers }), f.localEnv, {} as ExecutionContext);
  console.log(JSON.stringify({ audit: "admin_session_outage", status: response.status, cleared_session: (response.headers.get("set-cookie") ?? "").includes("Max-Age=0") }));
  await response.body?.cancel(); expect(response.status).toBe(503);
});

it("AUDIT-ADMIN: password settings outage is not an incorrect current password", async () => {
  const f = await fixture();
  const original = f.localEnv.REGISTRY.get.bind(f.localEnv.REGISTRY);
  (f.localEnv.REGISTRY as any).get = (id: DurableObjectId) => ({ fetch: (request: Request) => new URL(request.url).pathname === "/auth/settings" ? Response.json({ error: "synthetic dependency unavailable" }, { status: 503 }) : original(id).fetch(request) });
  const body = new URLSearchParams({ csrf_token: f.csrf, current_password: "synthetic-admin-password", password: "new-synthetic-admin-password", confirm_password: "new-synthetic-admin-password" });
  const response = await worker.fetch(new Request("https://audit.test/admin/password", { method: "POST", headers: f.headers, body }), f.localEnv, {} as ExecutionContext);
  const html = await response.text();
  console.log(JSON.stringify({ audit: "admin_password_settings_outage", status: response.status, claimed_wrong_password: html.includes("Current administrator password is invalid.") }));
  expect(response.status).toBe(503);
});

it.each(["revoke", "rotate-password"])("SEC01 rechecks %s at the signed Registry write, after the final page check", async action => {
  const f = await fixture();
  const original = f.localEnv.REGISTRY.get.bind(f.localEnv.REGISTRY);
  let mutationChecked = false;
  (f.localEnv.REGISTRY as any).get = (id: DurableObjectId) => ({ fetch: async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname === "/auth/clients" && request.method === "POST") {
      expect(url.searchParams.get("admin_session")).toBe(f.hash);
      await runInDurableObject(f.stub, instance => {
        if (action === "revoke") instance.logoutAdminSession(f.hash);
        else instance.changeAdminPassword("synthetic-rotated-verifier", Date.now());
      });
      mutationChecked = true;
    }
    return original(id).fetch(request);
  } });
  const body = new URLSearchParams({ csrf_token: f.csrf, label: "late-revocation", scopes: "coding:exec" });
  const response = await worker.fetch(new Request("https://audit.test/admin/clients", { method: "POST", headers: f.headers, body }), f.localEnv, {} as ExecutionContext);
  await response.body?.cancel();
  expect(mutationChecked).toBe(true); expect(response.status).toBeGreaterThanOrEqual(400);
  expect(await runInDurableObject(f.stub, instance => instance.listMcpClients())).toHaveLength(0);
});

it.each([429, 500, 502, 503, 504, "malformed", "oversized"])("SEC04 preserves session cookies when its dependency returns %s", async failure => {
  const f = await fixture();
  (f.localEnv.REGISTRY as any).get = () => ({ fetch: () => typeof failure === "number" ? new Response("synthetic failure", { status: failure }) : new Response(failure === "malformed" ? "{" : "x".repeat(17000)) });
  const response = await worker.fetch(new Request("https://audit.test/admin", { headers: f.headers }), f.localEnv, {} as ExecutionContext);
  expect(response.status).toBe(503); expect(response.headers.get("set-cookie")).toBeNull();
  await response.body?.cancel();
});

it.each([401, 403, 404])("SEC04 an actual session denial %s still signs out", async status => {
  const f = await fixture();
  (f.localEnv.REGISTRY as any).get = () => ({ fetch: () => new Response("denied", { status }) });
  const response = await worker.fetch(new Request("https://audit.test/admin", { headers: f.headers }), f.localEnv, {} as ExecutionContext);
  expect(response.status).toBe(303); expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  await response.body?.cancel();
});

it("SEC04 bounds a stalled authorization body and cancels its reader", async () => {
  const { boundedJsonResponse } = await import("../src/platform/bounded-json.js");
  let signal: AbortSignal | undefined, cancelled = false;
  const result = await boundedJsonResponse(async value => { signal = value; return new Response(new ReadableStream({ cancel() { cancelled = true; } })); }, 10);
  expect(result).toBeUndefined(); expect(signal?.aborted).toBe(true); expect(cancelled).toBe(true);
});

it.each([200, 202, 401, 403, 404, 429, 500, 502, 503, 504, "transport"])("SEC04 logout does not acknowledge an unconfirmed revocation (%s)", async failure => {
  const f = await fixture();
  const original = f.localEnv.REGISTRY.get.bind(f.localEnv.REGISTRY);
  let attempts = 0;
  (f.localEnv.REGISTRY as any).get = (id: DurableObjectId) => ({ fetch: (request: Request) => {
    if (new URL(request.url).pathname !== "/auth/sessions/logout") return original(id).fetch(request);
    attempts++;
    if (failure === "transport") throw new Error("synthetic transport failure");
    return new Response("synthetic revocation failure", { status: failure as number });
  } });
  const response = await worker.fetch(new Request("https://audit.test/admin/logout", { method: "POST", headers: f.headers, body: new URLSearchParams({ csrf_token: f.csrf }) }), f.localEnv, {} as ExecutionContext);
  expect(response.status).toBe(503); expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("set-cookie")).toBeNull(); expect(attempts).toBe(1);
  await response.body?.cancel();
  expect(await runInDurableObject(f.stub, instance => instance.verifyAdminSession(f.hash, Date.now()))).toBeDefined();
});

it("SEC04 successful logout revokes the server session before clearing cookies", async () => {
  const f = await fixture();
  const response = await worker.fetch(new Request("https://audit.test/admin/logout", { method: "POST", headers: f.headers, body: new URLSearchParams({ csrf_token: f.csrf }) }), f.localEnv, {} as ExecutionContext);
  expect(response.status).toBe(303); expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  await response.body?.cancel();
  expect(await runInDurableObject(f.stub, instance => instance.verifyAdminSession(f.hash, Date.now()))).toBeUndefined();
});

it("SEC04 bounds empty response chunks even when they consume no byte budget", async () => {
  const { boundedJsonResponse } = await import("../src/platform/bounded-json.js");
  let pulls = 0, cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (++pulls <= 4096) controller.enqueue(new Uint8Array());
      else { controller.enqueue(new TextEncoder().encode("{}")); controller.close(); }
    },
    cancel() { cancelled = true; },
  });
  expect(await boundedJsonResponse(async () => new Response(stream), 5000, 2)).toBeUndefined();
  expect(cancelled).toBe(true); expect(pulls).toBeLessThanOrEqual(1026);
});

it("SEC04 accepts occasional empty chunks and fragmented UTF-8 within the byte budget", async () => {
  const { boundedJsonResponse } = await import("../src/platform/bounded-json.js");
  const value = { value: "中文😀" }, bytes = new TextEncoder().encode(JSON.stringify(value));
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) { controller.enqueue(new Uint8Array()); controller.enqueue(Uint8Array.of(byte)); }
    controller.close();
  } });
  expect(await boundedJsonResponse(async () => new Response(stream), 5000, bytes.length)).toEqual({ status: 200, value });
});

it.each([200, 201, 202, 206, 401, 403, 404, 429, 500, 503, "transport"])("SEC04 login requires a completed session-creation receipt (%s)", async failure => {
  const f = await fixture();
  const original = f.localEnv.REGISTRY.get.bind(f.localEnv.REGISTRY);
  let attempts = 0;
  (f.localEnv.REGISTRY as any).get = (id: DurableObjectId) => ({ fetch: (request: Request) => {
    if (new URL(request.url).pathname !== "/auth/sessions") return original(id).fetch(request);
    attempts++;
    if (failure === "transport") throw new Error("synthetic session receipt failure");
    return new Response("synthetic unconfirmed session", { status: failure });
  } });
  const headers = { ...f.headers, cookie: `${LOGIN_CSRF_COOKIE}=${f.csrf}` };
  const body = new URLSearchParams({ csrf_token: f.csrf, password: "synthetic-admin-password" });
  const response = await worker.fetch(new Request("https://audit.test/", { method: "POST", headers, body }), f.localEnv, {} as ExecutionContext);
  expect(response.status).toBe(503); expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("set-cookie")).toBeNull(); expect(attempts).toBe(1);
  await response.body?.cancel();
});

it("SEC04 a completed login persists its session before issuing browser cookies", async () => {
  const f = await fixture();
  const headers = { ...f.headers, cookie: `${LOGIN_CSRF_COOKIE}=${f.csrf}` };
  const body = new URLSearchParams({ csrf_token: f.csrf, password: "synthetic-admin-password" });
  const response = await worker.fetch(new Request("https://audit.test/", { method: "POST", headers, body }), f.localEnv, {} as ExecutionContext);
  expect(response.status).toBe(303); expect(response.headers.get("location")).toBe("/admin");
  expect(response.headers.get("set-cookie")).toContain("__Host-runmesh_admin_session=");
  await response.body?.cancel();
  expect(await runInDurableObject(f.stub, (_instance, state) => state.storage.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM admin_sessions").one().total)).toBe(2);
});

it.each([200, 201, 202, 206, 401, 403, 404, 409, 429, 500, 503, "transport"])("SEC04 password change requires a completed mutation receipt (%s)", async failure => {
  const f = await fixture();
  const original = f.localEnv.REGISTRY.get.bind(f.localEnv.REGISTRY);
  const previous = await runInDurableObject(f.stub, instance => instance.adminPasswordVerifier());
  let attempts = 0;
  (f.localEnv.REGISTRY as any).get = (id: DurableObjectId) => ({ fetch: (request: Request) => {
    if (new URL(request.url).pathname !== "/auth/password") return original(id).fetch(request);
    attempts++;
    if (failure === "transport") throw new Error("synthetic password receipt failure");
    return new Response("synthetic unconfirmed password", { status: failure });
  } });
  const body = new URLSearchParams({ csrf_token: f.csrf, current_password: "synthetic-admin-password", password: "new-synthetic-admin-password", confirm_password: "new-synthetic-admin-password" });
  const response = await worker.fetch(new Request("https://audit.test/admin/password", { method: "POST", headers: f.headers, body }), f.localEnv, {} as ExecutionContext);
  expect(response.status).toBe(503); expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("set-cookie")).toBeNull(); expect(attempts).toBe(1);
  await response.body?.cancel();
  expect(await runInDurableObject(f.stub, instance => instance.adminPasswordVerifier())).toBe(previous);
  expect(await runInDurableObject(f.stub, instance => instance.verifyAdminSession(f.hash, Date.now()))).toBeDefined();
});

it("SEC04 a completed password change revokes the old server session", async () => {
  const f = await fixture();
  const previous = await runInDurableObject(f.stub, instance => instance.adminPasswordVerifier());
  const body = new URLSearchParams({ csrf_token: f.csrf, current_password: "synthetic-admin-password", password: "new-synthetic-admin-password", confirm_password: "new-synthetic-admin-password" });
  const response = await worker.fetch(new Request("https://audit.test/admin/password", { method: "POST", headers: f.headers, body }), f.localEnv, {} as ExecutionContext);
  expect(response.status).toBe(303); expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  await response.body?.cancel();
  expect(await runInDurableObject(f.stub, instance => instance.adminPasswordVerifier())).not.toBe(previous);
  expect(await runInDurableObject(f.stub, instance => instance.verifyAdminSession(f.hash, Date.now()))).toBeUndefined();
});

it.each([401, 403, 404, 503])("SEC04 an expired status observation (%s) is unavailable, not a fresh denial", async status => {
  const { boundedJsonResponse } = await import("../src/platform/bounded-json.js");
  let clock = 0, signal: AbortSignal | undefined;
  const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
  try {
    const response = await boundedJsonResponse(async input => { signal = input; clock = 10; return new Response("synthetic late status", { status }); }, 10);
    expect(response).toBeUndefined(); expect(signal?.aborted).toBe(true);
  } finally { now.mockRestore(); }
});
