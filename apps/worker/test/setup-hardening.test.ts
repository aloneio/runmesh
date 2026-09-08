import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.js";
import { randomBase64Url } from "../src/security.js";

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
