import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { ensureAuthSourceThrottleSchema } from "../src/auth-throttle.js";
import { passwordVerifier } from "../src/security.js";

it("adds source buckets to an existing v2 store without resetting identity or doing repeated DDL", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`source-upgrade-${crypto.randomUUID()}`));
  const verifier = await passwordVerifier("synthetic-existing-administrator-password");
  await runInDurableObject(stub, (instance, state) => {
    const now = Date.now();
    expect(instance.setupAdmin(verifier, now)).toBe(true);
    expect(instance.createAdminSession("a".repeat(64), "b".repeat(64), now + 60_000, now, 1)).toBe(true);
    // Model the pre-hardening v2 schema, which lacks only this additive table.
    state.storage.sql.exec("DROP TABLE auth_source_throttle");
    const calls = vi.spyOn(state.storage.sql, "exec");
    try {
      state.storage.transactionSync(() => ensureAuthSourceThrottleSchema(state.storage.sql));
      expect(instance.adminPasswordVerifier()).toBe(verifier);
      expect(instance.verifyAdminSession("a".repeat(64), now + 1)).toBeDefined();
      expect(instance.checkSourceAuthThrottle("login", "c".repeat(64), now + 2).allowed).toBe(true);
      expect(state.storage.sql.exec("SELECT 1 FROM auth_source_throttle WHERE id = 'login:global'").toArray()).toHaveLength(1);
      calls.mockClear();
      state.storage.transactionSync(() => ensureAuthSourceThrottleSchema(state.storage.sql));
      expect(calls.mock.calls.every(([query]) => !/CREATE|ALTER|INSERT|UPDATE|DELETE/i.test(query))).toBe(true);
    } finally { calls.mockRestore(); }
  });
});
