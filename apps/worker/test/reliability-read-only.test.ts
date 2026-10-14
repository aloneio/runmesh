import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { RUNNER_PRESENCE_TIMEOUT_MS } from "../src/contracts/runner-selection.js";

it("reads stale presence during a write outage without modifying session authority", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName("read-only-presence-" + crypto.randomUUID()));
  await runInDurableObject(stub, (instance, state) => {
    const now = Date.now(), id = "read-only-runner";
    instance.registerRunner(id, "a".repeat(64), now, undefined, "dedicated_user");
    const identity = instance.getRunnerExecutionState(id)!;
    state.storage.sql.exec("UPDATE runners SET state='online', session_id='retained-session', last_heartbeat_ms=? WHERE runner_id=?", now - RUNNER_PRESENCE_TIMEOUT_MS - 1, id);
    const original = state.storage.sql.exec.bind(state.storage.sql);
    const sql = vi.spyOn(state.storage.sql, "exec").mockImplementation((query: string, ...args: any[]) => {
      if (!query.startsWith("SELECT ")) throw new Error("synthetic write quota exhausted");
      return original(query, ...args);
    });
    try {
      for (let index = 0; index < 10; index++) {
        expect(instance.getRunner(id)?.state).toBe("stale");
        expect(instance.getRunnerExecutionState(id)).toMatchObject({ runner: { state: "stale" }, session_id: "retained-session" });
      }
      expect(sql.mock.calls).toHaveLength(20);
      expect(sql.mock.calls.every(([query]) => query.startsWith("SELECT "))).toBe(true);
    } finally { sql.mockRestore(); }
    const stored = state.storage.sql.exec<{ state: string; session_id: string }>("SELECT state, session_id FROM runners WHERE runner_id=?", id).one();
    expect(stored).toMatchObject({ state: "online", session_id: "retained-session" });
    expect(instance.revokeRunner(id, id, now)).toBe(true);
    expect(instance.recordHeartbeat(id, identity.runner.connection_epoch, identity.runner.credential_version,
      now + 1, identity.lifecycle_id, "retained-session")).toBe(false);
    expect(instance.getRunner(id)?.state).toBe("offline");
  });
});
