import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, onTestFinished, vi } from "vitest";
import worker from "../src/index.js";
import { passwordVerifier, randomBase64Url } from "../src/security.js";

function fixture() {
  const id = env.REGISTRY.idFromName(`setup-open-${crypto.randomUUID()}`);
  const stub = env.REGISTRY.get(id);
  const localEnv = { ...env, REGISTRY: { idFromName: () => id, get: () => stub }, RUNMESH_TEST_MODE: "1" } as unknown as typeof env;
  return { stub, localEnv };
}

it("allows first setup without a bootstrap token but preserves CSRF, origin and atomic one-time setup", async () => {
  const { stub, localEnv } = fixture();
  const origin = "https://setup-regression.example";
  const request = (validCsrf = true, requestOrigin = origin) => {
    const csrf = randomBase64Url();
    return new Request(`${origin}/setup`, {
      method: "POST",
      headers: { origin: requestOrigin, cookie: `__Host-runmesh_setup_csrf=${csrf}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: validCsrf ? csrf : "wrong", password: "synthetic-setup-password", confirm_password: "synthetic-setup-password" }),
    });
  };
  expect((await worker.fetch(request(false), localEnv, {} as ExecutionContext)).status).toBe(403);
  expect((await worker.fetch(request(true, "https://other.example"), localEnv, {} as ExecutionContext)).status).toBe(403);
  expect(await runInDurableObject(stub, (instance) => instance.adminStatus().initialized)).toBe(false);
  const responses = await Promise.all([worker.fetch(request(), localEnv, {} as ExecutionContext), worker.fetch(request(), localEnv, {} as ExecutionContext)]);
  expect(responses.map((response) => response.status).sort()).toEqual([303, 409]);
  expect((await worker.fetch(request(), localEnv, {} as ExecutionContext)).status).toBe(409);
  expect((await worker.fetch(new Request(`${origin}/login`), localEnv, {} as ExecutionContext)).status).toBe(200);
});

it("shows no bootstrap-token field and uses a fresh matching script nonce per page", async () => {
  const { localEnv } = fixture();
  const nonces: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const response = await worker.fetch(new Request("https://setup-regression.example/setup"), localEnv, {} as ExecutionContext);
    expect(response.status).toBe(200);
    const policy = response.headers.get("content-security-policy") ?? "";
    const nonce = /script-src 'nonce-([^']+)'/.exec(policy)?.[1];
    expect(nonce).toBeDefined();
    const document = await response.text();
    expect(document).not.toContain('name="setup_token"');
    const scripts = [...document.matchAll(/<script\b([^>]*)>/g)];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.[1]).toContain(`nonce="${nonce}"`);
    nonces.push(nonce as string);
  }
  expect(nonces[0]).not.toBe(nonces[1]);
});

it.each([
  ["setup", 400, "resolved"], ["setup", 409, "resolved"], ["setup", 503, "resolved"],
  ["setup", 409, "pending"], ["setup", 503, "rejected"],
  ["login", 409, "resolved"], ["login", 409, "pending"], ["login", 409, "rejected"],
] as const)("releases %s HTTP %s receipts when body cleanup is %s", async (action, status, cleanupMode) => {
  const password = "synthetic-receipt-password", csrf = randomBase64Url();
  const verifier = action === "login" ? await passwordVerifier(password) : undefined;
  let release!: () => void, cancelledBeforeRecord: number | undefined;
  const cleanup = new Promise<void>(resolve => { release = resolve; });
  onTestFinished(() => release());
  const cancel = vi.fn(() => cleanupMode === "pending" ? cleanup
    : cleanupMode === "rejected" ? Promise.reject(new Error("synthetic cleanup failure")) : undefined);
  const records: Record<string, unknown>[] = [], paths: string[] = [];
  const fetch = vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname; paths.push(path);
    if (path === "/auth/status") return Response.json({ initialized: action === "login" });
    if (path === "/auth/settings") return Response.json({ password_verifier: verifier, session_version: 1 });
    if (path === "/auth/throttle/check") return Response.json({ allowed: true, retry_after_ms: 0 });
    if (path === "/auth/throttle/record") {
      cancelledBeforeRecord = cancel.mock.calls.length;
      records.push(await request.json() as Record<string, unknown>);
      return new Response(null, { status: 204 });
    }
    if (path === (action === "setup" ? "/auth/setup" : "/auth/sessions")) return new Response(new ReadableStream({ cancel }), { status });
    throw new Error("Unexpected synthetic Registry route");
  });
  const localEnv = { ...env, REGISTRY: { idFromName: () => "registry", get: () => ({ fetch }) } } as unknown as typeof env;
  const origin = "https://receipt-regression.example", cookie = `__Host-runmesh_${action}_csrf`;
  const operation = worker.fetch(new Request(`${origin}/${action}`, {
    method: "POST", headers: { origin, cookie: `${cookie}=${csrf}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf_token: csrf, password, confirm_password: password }),
  }), localEnv, {} as ExecutionContext);
  try {
    // The cleanup gate stays pending until finally; completing the HTTP
    // operation proves that its decision does not await that separate work.
    const response = await operation;
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.status).toBe(action === "login" ? 403 : status === 409 ? 409 : 503);
    expect(response.headers.get("set-cookie")).toBe(status === 409 ? `${cookie}=; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=0` : null);
    expect(await response.text()).toContain(action === "login" ? "Authentication changed. Sign in again."
      : status === 409 ? "This instance is already initialized." : "Setup could not be completed. Try again.");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: action, success: action === "login" });
    if (action === "setup") expect(cancelledBeforeRecord).toBe(1);
    expect(paths).toEqual(action === "setup"
      ? ["/auth/status", "/auth/throttle/check", "/auth/setup", "/auth/throttle/record"]
      : ["/auth/status", "/auth/settings", "/auth/throttle/check", "/auth/throttle/record", "/auth/sessions"]);
  } finally { release(); await operation; }
});
