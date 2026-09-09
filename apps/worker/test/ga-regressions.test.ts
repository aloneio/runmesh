import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import worker, { runnerReleaseDescriptor } from "../src/index.js";
import { isConfiguredSecret } from "../src/security.js";
import { MCP_AUDIT_RETENTION_MS } from "../src/audit-metadata.js";

it("GA-012 rejects short, empty, whitespace and control-character deployment secrets", async () => {
  for (const value of [undefined, null, "", " ", "x", "x".repeat(31), " ".repeat(64), "x".repeat(64) + "\n", "x".repeat(513)]) expect(isConfiguredSecret(value)).toBe(false);
  expect(isConfiguredSecret("a".repeat(32))).toBe(true);
  for (const secret of ["x", " ".repeat(64)]) {
    const response = await worker.fetch(new Request("https://ga.invalid/login"), { ...env, INTERNAL_CONTROL_SECRET: secret }, {} as ExecutionContext);
    expect(response.status).toBe(503);
  }
});

it("GA-005 stable source has a stable descriptor but no implicitly enabled distribution", () => {
  expect(runnerReleaseDescriptor({})).toMatchObject({ channel: "stable", distributable: false });
  expect(runnerReleaseDescriptor({ RUNMESH_PUBLIC_ORIGIN: "https://ga.invalid", RUNMESH_SIGNED_RELEASE_AVAILABLE: "0.1.0" })).toMatchObject({ channel: "stable", distributable: true, package_version: "0.1.0" });
  expect(runnerReleaseDescriptor({ RUNMESH_PUBLIC_ORIGIN: "https://ga.invalid", RUNMESH_SIGNED_RELEASE_AVAILABLE: "0.1.0-dev.5" }).distributable).toBe(false);
});

it("GA-009 audit retention schedules expiry without any online runner and physically deletes expired rows", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`ga-retention-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (instance, state) => {
    const now = Date.now(); const expiry = now + 2000;
    state.storage.sql.exec("INSERT INTO mcp_calls (runner_id, call_id, call_json, completed_at_ms) VALUES (?, ?, ?, ?)", "offline-ga", "ga-call", "{}", expiry - MCP_AUDIT_RETENTION_MS);
    await instance.alarm();
    expect(await state.storage.getAlarm()).toBe(expiry);
    const clock = vi.spyOn(Date, "now").mockReturnValue(expiry + 1);
    try {
      await instance.alarm();
      expect(state.storage.sql.exec("SELECT 1 FROM mcp_calls").toArray()).toHaveLength(0);
      expect(await state.storage.getAlarm()).toBeNull();
    } finally { clock.mockRestore(); }
  });
});

it("GA-010 fallback success clears stale SQL lockout before recovered reservations, without resetting another source", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`ga-throttle-${crypto.randomUUID()}`));
  await runInDurableObject(stub, (instance, state) => {
    const now = Date.now(); const source = "a".repeat(64); const other = "b".repeat(64);
    for (let i = 0; i < 5; i++) instance.checkSourceAuthThrottle("login", source, now + i);
    instance.checkSourceAuthThrottle("login", other, now + 5);
    const original = state.storage.sql.exec.bind(state.storage.sql);
    let unavailable = true;
    const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((sql: string, ...args: any[]) => {
      if (unavailable && sql.includes("auth_source_throttle")) throw new Error("synthetic quota failure");
      return original(sql, ...args);
    });
    try {
      expect(instance.checkSourceAuthThrottle("login", source, now + 31000).allowed).toBe(true);
      instance.recordSourceAuthAttempt("login", source, true, now + 31001);
      unavailable = false;
      const retry = Number(original("SELECT disabled_until_ms FROM feature_health WHERE feature = ?", "auth_throttle").one().disabled_until_ms) + 1;
      expect(retry).toBeLessThan(now + 3600000);
      expect(instance.checkSourceAuthThrottle("login", source, retry).allowed).toBe(true);
      expect(original("SELECT failed_attempts FROM auth_source_throttle WHERE id = ?", `login:${source}`).one().failed_attempts).toBe(1);
      expect(instance.checkSourceAuthThrottle("login", source, retry + 1).allowed).toBe(true);
      expect(original("SELECT failed_attempts FROM auth_source_throttle WHERE id = ?", `login:${other}`).one().failed_attempts).toBe(1);
    } finally { spy.mockRestore(); }
  });
});
