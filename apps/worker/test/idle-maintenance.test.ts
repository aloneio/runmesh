import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { REGISTRY_HISTORY_CLEANUP_INTERVAL_MS } from "../src/registry.js";

it("does not rescan unrelated history on each liveness alarm, with the cleanup deadline stored durably", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`idle-maintenance-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (instance, state) => {
    const now = Date.now();
    instance.registerRunner("idle-runner", "synthetic", now, undefined, "dedicated_user");
    state.storage.sql.exec("UPDATE runners SET state = 'online', last_heartbeat_ms = ? WHERE runner_id = 'idle-runner'", now);
    instance.setupAdmin("synthetic-admin", now);
    expect(instance.createAdminSession("a".repeat(64), "b".repeat(64), now + 2000, now, 1)).toBe(true);
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const sql = vi.spyOn(state.storage.sql, "exec");
    const historyScans = () => sql.mock.calls.filter(([query]) => /^SELECT 1 FROM (feature_health|admin_sessions|internal_request_nonces|runner_enrollments) /.test(query));
    try {
      await instance.alarm(); expect(historyScans()).toHaveLength(4);
      expect(await state.storage.get("maintenance.history-cleanup-deadline.v1")).toBe(now + REGISTRY_HISTORY_CLEANUP_INTERVAL_MS);
      sql.mockClear(); clock.mockReturnValue(now + 5000);
      await instance.alarm(); expect(historyScans()).toHaveLength(0);
      expect(sql.mock.calls.some(([query]) => query.includes("FROM runners"))).toBe(true);
      // Delayed physical cleanup does not extend the authorization lifetime.
      expect(state.storage.sql.exec("SELECT 1 FROM admin_sessions").toArray()).toHaveLength(1);
      expect(instance.verifyAdminSession("a".repeat(64), now + 5000)).toBeUndefined();
      clock.mockReturnValue(now + REGISTRY_HISTORY_CLEANUP_INTERVAL_MS + 1); sql.mockClear();
      await instance.alarm(); expect(historyScans()).toHaveLength(4);
      expect(state.storage.sql.exec("SELECT 1 FROM admin_sessions").toArray()).toHaveLength(0);
    } finally { sql.mockRestore(); clock.mockRestore(); }
  });
});

it("schedules a cooldown instead of rapidly retrying an overloaded maintenance turn", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`idle-failure-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (instance, state) => {
    const now = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const original = state.storage.sql.exec.bind(state.storage.sql);
    const sql = vi.spyOn(state.storage.sql, "exec").mockImplementation((query: string, ...args: any[]) => {
      if (query.startsWith("SELECT 1 FROM runners")) throw new Error("synthetic storage overload");
      return original(query, ...args);
    });
    try {
      await expect(instance.alarm()).resolves.toBeUndefined();
      expect(await state.storage.getAlarm()).toBe(now + REGISTRY_HISTORY_CLEANUP_INTERVAL_MS);
      expect(instance.featureHealthSnapshot(now).some((feature) => feature.feature === "maintenance_alarm")).toBe(true);
    } finally { sql.mockRestore(); clock.mockRestore(); }
  });
});

it("does not keep a recurring alarm for an idle Registry without online runners or audit records", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`idle-empty-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (instance, state) => {
    await instance.alarm(); expect(await state.storage.getAlarm()).toBeNull();
  });
});
