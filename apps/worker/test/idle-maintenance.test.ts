import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { REGISTRY_HISTORY_CLEANUP_INTERVAL_MS } from "../src/registry.js";
import { internalHeaders, INTERNAL_SIGNATURE_SKEW_MS } from "../src/security.js";

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

it("signed mutations schedule nonce cleanup without online runners and then stop waking", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName("idle-nonce-" + crypto.randomUUID()));
  await runInDurableObject(stub, async (instance, state) => {
    const now = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const alarm = vi.spyOn(state.storage, "setAlarm");
    try {
      for (let n = 0; n < 20; n++) {
        const path = "/auth/setup", body = JSON.stringify({ password_verifier: "synthetic-admin" });
        const headers = await internalHeaders("test-internal-control-secret-not-for-production", "POST", path, body);
        expect((await instance.fetch(new Request("https://registry.internal" + path, { method: "POST", body, headers }))).status).toBe(n === 0 ? 204 : 409);
      }
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM internal_request_nonces").one().n).toBe(20);
      expect(await state.storage.getAlarm()).toBe(now + INTERNAL_SIGNATURE_SKEW_MS);
      expect(alarm).toHaveBeenCalledTimes(1);
      clock.mockReturnValue(now + INTERNAL_SIGNATURE_SKEW_MS);
      await instance.alarm();
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM internal_request_nonces").one().n).toBe(0);
      expect(await state.storage.getAlarm()).toBeNull();
    } finally { alarm.mockRestore(); clock.mockRestore(); }
  });
});

it("idle session retention schedules its actual expiry and deletes the final alarm", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName("idle-session-" + crypto.randomUUID()));
  await runInDurableObject(stub, async (instance, state) => {
    const now = Date.now(), expires = now + 2 * REGISTRY_HISTORY_CLEANUP_INTERVAL_MS;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      instance.setupAdmin("synthetic-admin", now);
      instance.createAdminSession("a".repeat(64), "b".repeat(64), expires, now, 1);
      await instance.alarm();
      expect(await state.storage.getAlarm()).toBe(expires);
      expect(state.storage.sql.exec("SELECT 1 FROM admin_sessions").toArray()).toHaveLength(1);
      clock.mockReturnValue(expires);
      await instance.alarm();
      expect(state.storage.sql.exec("SELECT 1 FROM admin_sessions").toArray()).toHaveLength(0);
      expect(await state.storage.getAlarm()).toBeNull();
    } finally { clock.mockRestore(); }
  });
});

it("pending expiry honors the durable cleanup interval instead of a one-second alarm loop", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName("idle-batched-" + crypto.randomUUID()));
  await runInDurableObject(stub, async (instance, state) => {
    const now = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      expect(instance.consumeInternalNonce("a".repeat(64), now + 2_000, now)).toBe(true);
      await instance.alarm();
      expect(await state.storage.getAlarm()).toBe(now + REGISTRY_HISTORY_CLEANUP_INTERVAL_MS);
      clock.mockReturnValue(now + 5_000);
      await instance.alarm();
      expect(await state.storage.getAlarm()).toBe(now + REGISTRY_HISTORY_CLEANUP_INTERVAL_MS);
      expect(state.storage.sql.exec("SELECT 1 FROM internal_request_nonces").toArray()).toHaveLength(1);
      clock.mockReturnValue(now + REGISTRY_HISTORY_CLEANUP_INTERVAL_MS);
      await instance.alarm();
      expect(state.storage.sql.exec("SELECT 1 FROM internal_request_nonces").toArray()).toHaveLength(0);
      expect(await state.storage.getAlarm()).toBeNull();
    } finally { clock.mockRestore(); }
  });
});
