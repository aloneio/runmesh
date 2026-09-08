import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.js";
import { loadLoginSettings } from "../src/auth-settings.js";
import { passwordVerifier, randomBase64Url } from "../src/security.js";

for (const failure of ["http-503", "malformed-json", "invalid-verifier", "transport-error"] as const) {
  it(`returns 503 for ${failure} without locking out the recovered administrator`, async () => {
    const id = env.REGISTRY.idFromName(`login-outage-${crypto.randomUUID()}`); const stub = env.REGISTRY.get(id);
    const password = "synthetic-outage-password"; const verifier = await passwordVerifier(password);
    await runInDurableObject(stub, (instance) => { instance.setupAdmin(verifier, Date.now()); });
    let outage = true;
    const localEnv = { ...env, RUNMESH_TEST_MODE: "1", REGISTRY: { idFromName: () => id, get: () => ({ fetch: (request: Request) => {
      if (outage && new URL(request.url).pathname === "/auth/settings") {
        if (failure === "transport-error") return Promise.reject(new Error("synthetic transport failure"));
        return Promise.resolve(failure === "http-503" ? new Response("unavailable", { status: 503 }) : failure === "malformed-json" ? new Response("{") : Response.json({ password_verifier: "invalid", session_version: 1 }));
      }
      return stub.fetch(request);
    } }) } } as unknown as typeof env;
    const request = () => {
      const csrf = randomBase64Url();
      return new Request("https://outage.example/login", { method: "POST", headers: { origin: "https://outage.example", cookie: `__Host-runmesh_login_csrf=${csrf}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ password, csrf_token: csrf }) });
    };
    for (let attempt = 0; attempt < 6; attempt += 1) expect((await worker.fetch(request(), localEnv, {} as ExecutionContext)).status).toBe(503);
    await runInDurableObject(stub, (_instance, state) => { expect(state.storage.sql.exec("SELECT 1 FROM auth_source_throttle").toArray()).toHaveLength(0); });
    outage = false;
    const response = await worker.fetch(request(), localEnv, {} as ExecutionContext);
    expect(response.status).toBe(303); expect(response.headers.has("retry-after")).toBe(false);
  });
}
it("bounds a stalled settings request and aborts its signal", async () => {
  let signal: AbortSignal | undefined;
  expect(await loadLoginSettings((value) => { signal = value; return new Promise<Response>(() => {}); }, 10)).toBeUndefined();
  expect(signal?.aborted).toBe(true);
});
