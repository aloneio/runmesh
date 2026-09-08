import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.js";
import { passwordVerifier, randomBase64Url } from "../src/security.js";

it("returns a working nonce-aware throttle page", async () => {
  const id = env.REGISTRY.idFromName(`throttle-csp-${crypto.randomUUID()}`); const stub = env.REGISTRY.get(id);
  const verifier = await passwordVerifier("synthetic-csp-password");
  await runInDurableObject(stub, (instance) => { instance.setupAdmin(verifier, Date.now()); });
  const localEnv = { ...env, RUNMESH_TEST_MODE: "1", REGISTRY: { idFromName: () => id, get: () => stub } } as unknown as typeof env;
  let response: Response | undefined;
  for (let i = 0; i < 6; i += 1) {
    const csrf = randomBase64Url();
    response = await worker.fetch(new Request("https://csp.example/login", { method: "POST", headers: { origin: "https://csp.example", cookie: `__Host-runmesh_login_csrf=${csrf}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ password: "wrong-password", csrf_token: csrf }) }), localEnv, {} as ExecutionContext);
  }
  expect(response?.status).toBe(403);
  expect(response?.headers.has("retry-after")).toBe(true);
  const nonce = /script-src 'nonce-([^']+)'/.exec(response!.headers.get("content-security-policy") ?? "")?.[1];
  expect(nonce).toBeDefined();
  expect(await response!.text()).toContain(`nonce="${nonce}"`);
});
