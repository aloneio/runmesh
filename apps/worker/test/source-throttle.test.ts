import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";

it("isolates source lockouts and clears only the successful source", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`source-throttle-${crypto.randomUUID()}`));
  await runInDurableObject(stub, (instance, state) => {
    const now = Date.now(); const a = "a".repeat(64); const b = "b".repeat(64);
    for (let index = 0; index < 5; index += 1) expect(instance.checkSourceAuthThrottle("login", a, now + index).allowed).toBe(true);
    expect(instance.checkSourceAuthThrottle("login", a, now + 5).allowed).toBe(false);
    expect(instance.checkSourceAuthThrottle("login", b, now + 6).allowed).toBe(true);
    instance.recordSourceAuthAttempt("login", b, true, now + 7);
    expect(instance.checkSourceAuthThrottle("login", a, now + 8).allowed).toBe(false);
    instance.recordSourceAuthAttempt("login", a, true, now + 9);
    expect(instance.checkSourceAuthThrottle("login", a, now + 10).allowed).toBe(true);
    const keys = state.storage.sql.exec<{ id: string }>("SELECT id FROM auth_source_throttle").toArray().map((row) => row.id);
    expect(keys).toContain("login:global");
    expect(keys.every((key) => /^login:(?:global|[a-f0-9]{64})$/.test(key))).toBe(true);
  });
});

it("keeps a bounded shared KDF budget which successful sources cannot reset", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`global-kdf-${crypto.randomUUID()}`));
  await runInDurableObject(stub, (instance, state) => {
    const now = Date.now();
    for (let index = 0; index < 120; index += 1) {
      const source = index.toString(16).padStart(64, "0");
      expect(instance.checkSourceAuthThrottle("login", source, now).allowed).toBe(true);
      instance.recordSourceAuthAttempt("login", source, true, now);
    }
    expect(instance.checkSourceAuthThrottle("login", "f".repeat(64), now + 1)).toEqual({ allowed: false, retry_after_ms: 59_999 });
    expect(instance.checkSourceAuthThrottle("login", "f".repeat(64), now + 60_001).allowed).toBe(true);
    expect(state.storage.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM auth_source_throttle").toArray()[0]?.total).toBeLessThanOrEqual(3);
  });
});

it("bounds source-key storage, rejects raw addresses, and reclaims expired buckets", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`bounded-source-${crypto.randomUUID()}`));
  await runInDurableObject(stub, (instance, state) => {
    const now = Date.now();
    expect(instance.checkSourceAuthThrottle("login", "192.0.2.1", now).allowed).toBe(false);
    for (let index = 0; index < 2048; index += 1) state.storage.sql.exec("INSERT INTO auth_source_throttle (id, failed_attempts, blocked_until_ms, updated_at_ms) VALUES (?, 1, 0, ?)", `login:${index.toString(16).padStart(64, "0")}`, now);
    expect(instance.checkSourceAuthThrottle("login", "f".repeat(64), now + 1).allowed).toBe(true);
    expect(state.storage.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM auth_source_throttle").one().total).toBeLessThanOrEqual(2048);
    expect(instance.checkSourceAuthThrottle("login", "f".repeat(64), now + 3_600_001).allowed).toBe(true);
    expect(state.storage.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM auth_source_throttle").toArray()[0]?.total).toBe(2);
  });
});

it("blocked source checks do not issue cleanup or mutation SQL", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`blocked-readonly-${crypto.randomUUID()}`));
  await runInDurableObject(stub, (instance, state) => {
    const now = Date.now(); const source = "c".repeat(64);
    for (let i = 0; i < 5; i += 1) instance.checkSourceAuthThrottle("login", source, now + i);
    const exec = vi.spyOn(state.storage.sql, "exec");
    expect(instance.checkSourceAuthThrottle("login", source, now + 6).allowed).toBe(false);
    expect(exec.mock.calls.every(([query]) => query.trim().startsWith("SELECT"))).toBe(true);
    exec.mockRestore();
  });
});
