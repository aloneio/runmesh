import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { internalHeaders, runnerTokenVerifier } from "../src/security.js";

const secret = "test-internal-control-secret-not-for-production";
const token = "synthetic-runner-token-for-outage-tests";

it.each(["heartbeat-update", "heartbeat-read", "session", "auth", "nonce"])("returns retryable 503 instead of a false credential rejection on %s storage failure", async (boundary) => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`outage-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (instance, state) => {
    const now = Date.now(), runner = "outage-runner", session = "outage-session";
    const verifier = await runnerTokenVerifier(token, "test-runner-token-pepper-not-for-production");
    expect(instance.registerRunner(runner, verifier, now, undefined, "dedicated_user")).toBe(true);
    const fence = instance.getRunnerExecutionState(runner)!;
    state.storage.sql.exec("UPDATE runners SET state = 'online', session_id = ?, last_heartbeat_ms = ? WHERE runner_id = ?", session, now, runner);
    const identity = { epoch: fence.runner.connection_epoch, credential_version: fence.runner.credential_version, lifecycle_id: fence.lifecycle_id, session_id: session, now_ms: boundary === "heartbeat-update" ? now + 1 : now, require_online: true };
    const action = boundary.startsWith("heartbeat") ? "heartbeat" : boundary === "session" ? "session" : "auth";
    const path = `/runners/${runner}/${action}`;
    const body = JSON.stringify(action === "auth" ? { token } : identity);
    const request = async () => new Request(`https://registry.internal${path}`, { method: "POST", headers: await internalHeaders(secret, "POST", path, body), body });
    const original = state.storage.sql.exec.bind(state.storage.sql);
    const fault = vi.spyOn(state.storage.sql, "exec").mockImplementation((sql: string, ...args: any[]) => {
      const matches = boundary === "heartbeat-update" ? sql.startsWith("UPDATE runners SET state = 'online'")
        : boundary === "heartbeat-read" || boundary === "session" ? sql.startsWith("SELECT connection_epoch")
        : boundary === "nonce" ? sql.startsWith("INSERT INTO internal_request_nonces") : sql.startsWith("SELECT token_verifier");
      if (matches) throw new Error("PRIVATE_STORAGE_SENTINEL: quota exceeded");
      return original(sql, ...args);
    });
    try {
      const response = await instance.fetch(await request());
      expect(response.status).toBe(503); expect(response.headers.get("retry-after")).toBe("30");
      const text = await response.text(); expect(text).toContain("control_plane_unavailable"); expect(text).not.toContain("PRIVATE_STORAGE_SENTINEL");
    } finally { fault.mockRestore(); }
    // Recovery uses the same stored credential/session, with no re-enrollment.
    const recovered = await instance.fetch(await request()); expect(recovered.status).toBe(action === "auth" ? 200 : 204);
  });
});

it("continues rejecting true stale sessions and invalid credentials after the availability fix", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`outage-fences-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (instance, state) => {
    const now = Date.now(), runner = "fenced-runner";
    instance.registerRunner(runner, await runnerTokenVerifier(token, "test-runner-token-pepper-not-for-production"), now, undefined, "dedicated_user");
    const fence = instance.getRunnerExecutionState(runner)!;
    state.storage.sql.exec("UPDATE runners SET state = 'online', session_id = 'current-session', last_heartbeat_ms = ? WHERE runner_id = ?", now, runner);
    for (const action of ["heartbeat", "session"]) {
      const path = `/runners/${runner}/${action}`;
      const body = JSON.stringify({ epoch: fence.runner.connection_epoch, credential_version: fence.runner.credential_version, lifecycle_id: fence.lifecycle_id, session_id: "stale-session", now_ms: now + 1 });
      const response = await instance.fetch(new Request(`https://registry.internal${path}`, { method: "POST", headers: await internalHeaders(secret, "POST", path, body), body }));
      expect(response.status).toBe(409);
    }
    const path = `/runners/${runner}/auth`, body = JSON.stringify({ token: "definitely-invalid-credential" });
    expect((await instance.fetch(new Request(`https://registry.internal${path}`, { method: "POST", headers: await internalHeaders(secret, "POST", path, body), body }))).status).toBe(401);
  });
});

it("distinguishes nonce replay from storage failure without scanning all nonce rows", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`outage-nonces-${crypto.randomUUID()}`));
  await runInDurableObject(stub, (instance, state) => {
    const now = Date.now(), nonce = "a".repeat(64);
    const sql = vi.spyOn(state.storage.sql, "exec");
    try {
      expect(instance.consumeInternalNonce(nonce, now + 60000, now)).toBe(true);
      expect(instance.consumeInternalNonce(nonce, now + 60000, now)).toBe(false);
      expect(sql.mock.calls.every(([query]) => !query.startsWith("DELETE"))).toBe(true);
      expect(instance.consumeInternalNonce(nonce, now + 120000, now + 60001)).toBe(true);
    } finally { sql.mockRestore(); }
  });
});
