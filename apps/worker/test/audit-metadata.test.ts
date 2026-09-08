import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { ensureMetadataOnlyAudit, MCP_AUDIT_RETENTION_MS, projectMcpAuditMetadata } from "../src/audit-metadata.js";

it("persists only metadata for reads, logs, diffs, searches, patches and job input", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`audit-metadata-${crypto.randomUUID()}`));
  await runInDurableObject(stub, (instance, state) => {
    const now = Date.now(); const runnerId = "metadata-runner"; const sessionId = "metadata-session";
    expect(instance.registerRunner(runnerId, "synthetic-verifier", now, undefined, "dedicated_user")).toBe(true);
    const current = instance.getRunnerExecutionState(runnerId)!;
    state.storage.sql.exec("UPDATE runners SET state = 'online', session_id = ? WHERE runner_id = ?", sessionId, runnerId);
    for (const method of ["fs.read", "job.logs", "git.diff", "fs.search", "fs.apply_patch", "job.input"]) {
      const marker = `BODY_SENTINEL_${method}`;
      const call = { call_id: `call-${crypto.randomUUID()}`, client_id: "client-metadata", method, workspace_id: "workspace-1", status: "ok", started_at_ms: now, completed_at_ms: now, duration_ms: 0,
        params: { patch: marker, path: marker, data: marker, query: marker },
        result: { content: [{ text: marker }], structuredContent: { data: marker, diff: marker, results: [{ text: marker }] } },
        unexpected: marker };
      expect(instance.recordMcpCall(runnerId, current.runner.connection_epoch, current.runner.credential_version, call, now, true, current.lifecycle_id!, sessionId)).toBe(true);
      const raw = state.storage.sql.exec<{ call_json: string }>("SELECT call_json FROM mcp_calls WHERE call_id = ?", call.call_id).one().call_json;
      expect(raw).not.toContain(marker);
      expect(JSON.parse(raw)).not.toHaveProperty("params");
      expect(JSON.parse(raw)).not.toHaveProperty("result");
      expect(JSON.parse(raw)).toMatchObject({ method, workspace_id: "workspace-1" });
    }
    expect(instance.listMcpCalls(runnerId)).toHaveLength(6);
  });
});

it("purges legacy audit bodies once without deleting administrator or Runner state", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`audit-upgrade-${crypto.randomUUID()}`));
  await runInDurableObject(stub, (instance, state) => {
    const now = Date.now();
    instance.setupAdmin("synthetic-preserved-verifier", now);
    instance.registerRunner("preserved-runner", "synthetic", now, undefined, "dedicated_user");
    state.storage.sql.exec("INSERT INTO mcp_calls (runner_id, call_id, call_json, completed_at_ms) VALUES (?, ?, ?, ?)", "preserved-runner", "legacy", JSON.stringify({ params: { data: "LEGACY_BODY_SENTINEL" }, result: "LEGACY_BODY_SENTINEL" }), now);
    expect(JSON.stringify(instance.listMcpCalls("preserved-runner"))).not.toContain("LEGACY_BODY_SENTINEL");
    state.storage.sql.exec("DELETE FROM runmesh_data_migrations WHERE id = ?", "mcp-metadata-only-v1");
    state.storage.transactionSync(() => ensureMetadataOnlyAudit(state.storage.sql));
    expect(state.storage.sql.exec("SELECT 1 FROM mcp_calls").toArray()).toHaveLength(0);
    expect(instance.adminPasswordVerifier()).toBe("synthetic-preserved-verifier");
    expect(instance.getRunner("preserved-runner")).toBeDefined();
    const exec = vi.spyOn(state.storage.sql, "exec");
    ensureMetadataOnlyAudit(state.storage.sql);
    expect(exec.mock.calls.every(([query]) => query.trim().startsWith("SELECT"))).toBe(true);
    exec.mockRestore();
    state.storage.sql.exec("INSERT INTO mcp_calls (runner_id, call_id, call_json, completed_at_ms) VALUES (?, ?, ?, ?)", "preserved-runner", "expired", "{}", now - MCP_AUDIT_RETENTION_MS - 1);
    expect(instance.listMcpCalls("preserved-runner")).toHaveLength(0);
  });
});

it("rejects nested payloads even when placed under an allowlisted metadata key", () => {
  expect(projectMcpAuditMetadata({ method: "fs.read", params: { data: "BODY" }, job_id: { text: "BODY" }, status: "ok" })).toEqual({ method: "fs.read", status: "ok" });
});
