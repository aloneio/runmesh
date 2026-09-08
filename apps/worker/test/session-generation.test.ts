import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.js";
import { passwordVerifier, randomBase64Url, sha256Hex } from "../src/security.js";

it.each(["/auth/settings", "/auth/sessions"])("rejects an in-flight old-password login when rotation overlaps %s", async (boundary) => {
  const id = env.REGISTRY.idFromName(`session-generation-${crypto.randomUUID()}`);
  const stub = env.REGISTRY.get(id);
  const oldPassword = "synthetic-old-regression-password";
  const newPassword = "synthetic-new-regression-password";
  const oldVerifier = await passwordVerifier(oldPassword);
  const nextVerifier = await passwordVerifier(newPassword);
  const priorHash = await sha256Hex(randomBase64Url());
  const csrfHash = await sha256Hex(randomBase64Url());
  await runInDurableObject(stub, (instance) => {
    expect(instance.setupAdmin(oldVerifier, Date.now())).toBe(true);
    expect(instance.createAdminSession(priorHash, csrfHash, Date.now() + 60_000, Date.now(), 1)).toBe(true);
  });
  let rotated = false;
  const rotate = async () => {
    rotated = true;
    await runInDurableObject(stub, (instance) => {
      expect(instance.changeAdminPassword(nextVerifier, Date.now())).toBe(true);
      expect(instance.verifyAdminSession(priorHash, Date.now())).toBeUndefined();
    });
  };
  const namespace = {
    idFromName: () => id,
    get: () => ({ fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (!rotated && boundary === "/auth/sessions" && path === boundary) await rotate();
      const response = await stub.fetch(request);
      if (!rotated && boundary === "/auth/settings" && path === boundary) await rotate();
      return response;
    } }),
  };
  const localEnv = { ...env, REGISTRY: namespace, RUNMESH_TEST_MODE: "1" } as unknown as typeof env;
  const request = (password: string) => {
    const csrf = randomBase64Url();
    return new Request("https://regression.example/login", {
      method: "POST",
      headers: { origin: "https://regression.example", cookie: `__Host-runmesh_login_csrf=${csrf}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password, csrf_token: csrf }),
    });
  };
  const raced = await worker.fetch(request(oldPassword), localEnv, {} as ExecutionContext);
  expect(rotated).toBe(true);
  expect(raced.status).toBe(403);
  expect(raced.headers.get("set-cookie") ?? "").not.toContain("__Host-runmesh_admin_session=");
  expect((await worker.fetch(request(oldPassword), localEnv, {} as ExecutionContext)).status).toBe(403);
  const normal = await worker.fetch(request(newPassword), localEnv, {} as ExecutionContext);
  expect(normal.status).toBe(303);
  const token = /__Host-runmesh_admin_session=([^;]+)/.exec(normal.headers.get("set-cookie") ?? "")?.[1];
  expect(token).toBeDefined();
  const sessionHash = await sha256Hex(token as string);
  expect(await runInDurableObject(stub, (instance) => instance.verifyAdminSession(sessionHash, Date.now()) !== undefined)).toBe(true);
});

it("rejects stale, missing, and malformed generations after consecutive rotations", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`session-cas-${crypto.randomUUID()}`));
  const verifier = await passwordVerifier("synthetic-rotation-regression-password");
  await runInDurableObject(stub, (instance) => {
    const now = Date.now();
    expect(instance.setupAdmin(verifier, now)).toBe(true);
    expect(instance.changeAdminPassword(verifier, now + 1)).toBe(true);
    expect(instance.changeAdminPassword(verifier, now + 2)).toBe(true);
    for (const generation of [0, 1, 2, NaN, 1.5]) {
      expect(instance.createAdminSession("a".repeat(64), "b".repeat(64), now + 60_000, now + 3, generation)).toBe(false);
    }
    expect(instance.createAdminSession("a".repeat(64), "b".repeat(64), now + 60_000, now + 3, 3)).toBe(true);
    expect(instance.verifyAdminSession("a".repeat(64), now + 3)).toBeDefined();
  });
});
