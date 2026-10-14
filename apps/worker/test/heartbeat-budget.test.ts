import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { RunnerHeartbeatPersistence } from "../src/platform/runner-heartbeat.js";
import { heartbeatRetryActive, isTemporaryHeartbeatFailure, nextHeartbeatRetry } from "../src/domain/heartbeat-retry.js";

it("coalesces six legacy Runners into a 120-second real SQLite persistence budget", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName("healthy-heartbeat-budget-" + crypto.randomUUID()));
  await runInDurableObject(stub, async (instance, state) => {
    const now = Date.now();
    const policy = { active: heartbeatRetryActive, next: nextHeartbeatRetry, temporaryFailure: isTemporaryHeartbeatFailure };
    const runners = Array.from({ length: 6 }, (_, index) => {
      const id = `budget-${index}`, session = `session-${index}`;
      instance.registerRunner(id, "a".repeat(64), now, undefined, "dedicated_user");
      const identity = instance.getRunnerExecutionState(id)!;
      state.storage.sql.exec("UPDATE runners SET state='online', session_id=?, last_heartbeat_ms=? WHERE runner_id=?", session, now - 120000, id);
      let attachment: unknown = {};
      const socket = { deserializeAttachment: () => structuredClone(attachment),
        serializeAttachment: (value: unknown) => { attachment = structuredClone(value); } } as unknown as WebSocket;
      return { id, session, identity, socket, persistence: new RunnerHeartbeatPersistence(policy) };
    });
    let requests = 0, rowsRead = 0, rowsWritten = 0;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now), original = state.storage.sql.exec.bind(state.storage.sql);
    const sql = vi.spyOn(state.storage.sql, "exec").mockImplementation((query: string, ...args: any[]) => {
      const cursor = original(query, ...args); rowsRead += cursor.rowsRead; rowsWritten += cursor.rowsWritten; return cursor;
    });
    try {
      for (let elapsed = 0; elapsed < 86400000; elapsed += 30000) {
        clock.mockReturnValue(now + elapsed);
        for (const runner of runners) await runner.persistence.record(runner.socket, async () => {
          requests++;
          const accepted = instance.recordHeartbeat(runner.id, runner.identity.runner.connection_epoch,
            runner.identity.runner.credential_version, Date.now(), runner.identity.lifecycle_id, runner.session);
          return new Response(null, { status: accepted ? 204 : 409 });
        }, () => { throw new Error("Unexpected heartbeat identity rejection"); });
      }
      expect(requests).toBe(6 * 720);
      expect(rowsWritten).toBeGreaterThan(0); expect(rowsWritten).toBeLessThanOrEqual(requests * 4);
      expect(rowsRead).toBeLessThanOrEqual(requests * 4);
      expect(sql.mock.calls.some(([query]) => /INSERT INTO (jobs|mcp_calls|internal_request_nonces)/.test(query))).toBe(false);
      console.log(JSON.stringify({ scenario: "six_runner_healthy_sql_24h", input_frames: 17280,
        persistence_requests: requests, rows_read: rowsRead, rows_written: rowsWritten,
        note: "simulated time with real local SQLite counters, not Cloudflare account billing" }));
    } finally { clock.mockRestore(); sql.mockRestore(); }
  });
}, 30000);
