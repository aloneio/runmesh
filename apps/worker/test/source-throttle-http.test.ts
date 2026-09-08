import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { passwordVerifier, randomBase64Url } from "../src/security.js";

it("keeps another source available through the real HTTP login path", async () => {
  const id = env.REGISTRY.idFromName(`http-source-${crypto.randomUUID()}`); const stub = env.REGISTRY.get(id);
  const password = "synthetic-source-isolation-password"; const verifier = await passwordVerifier(password);
  await runInDurableObject(stub, (instance) => { expect(instance.setupAdmin(verifier, Date.now())).toBe(true); });
  const localEnv = { ...env, REGISTRY: { idFromName: () => id, get: () => stub }, RUNMESH_TEST_MODE: "1" } as unknown as typeof env;
  const send = async (address: string, suppliedPassword: string) => {
    const csrf = randomBase64Url();
    return worker.fetch(new Request("https://source-regression.example/login", {
      method: "POST", headers: { origin: "https://source-regression.example", "cf-connecting-ip": address, cookie: `__Host-runmesh_login_csrf=${csrf}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: suppliedPassword, csrf_token: csrf }),
    }), localEnv, {} as ExecutionContext);
  };
  for (let index = 0; index < 5; index += 1) expect((await send("192.0.2.10", "incorrect-password")).status).toBe(403);
  const blocked = await send("192.0.2.10", password);
  expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  expect((await send("192.0.2.11", password)).status).toBe(303);
});

it("retains source isolation when optional SQL writes fail", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`fallback-source-${crypto.randomUUID()}`));
  await runInDurableObject(stub, (instance, state) => {
    const original = state.storage.sql.exec.bind(state.storage.sql);
    const mock = vi.spyOn(state.storage.sql, "exec").mockImplementation((query, ...bindings) => {
      if (query.includes("auth_source_throttle")) throw new Error("SQLITE_FULL: synthetic test quota failure");
      return original(query, ...bindings);
    });
    try {
      const now = Date.now();
      for (let index = 0; index < 5; index += 1) expect(instance.checkSourceAuthThrottle("login", "a".repeat(64), now).allowed).toBe(true);
      expect(instance.checkSourceAuthThrottle("login", "a".repeat(64), now).allowed).toBe(false);
      expect(instance.checkSourceAuthThrottle("login", "b".repeat(64), now).allowed).toBe(true);
    } finally { mock.mockRestore(); }
  });
});
