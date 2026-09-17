// Audit-only tests: an isolated DO and disposable session, never production.
import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.js";
import { randomBase64Url, sha256Hex, passwordVerifier } from "../src/security.js";

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
