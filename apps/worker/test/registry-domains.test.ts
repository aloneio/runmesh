import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { sha256Hex } from "@aloneio/runmesh-protocol";
import baseline from "./registry-domain-baseline.json";

// Recorded against ca511cf before extraction. All inputs are synthetic.
const RECORD_BASELINE = false;
it("AR06 preserves cross-domain SQL, transaction order, costs and receipts", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`domains-${crypto.randomUUID()}`));
  await runInDurableObject(stub, (r, state) => {
    const now = 1789459200000;
    let uuid = 0;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const random = vi.spyOn(crypto, "randomUUID").mockImplementation(() => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`);
    const original = state.storage.sql.exec.bind(state.storage.sql), transaction = state.storage.transactionSync.bind(state.storage);
    let calls: unknown[] = [], cursors: Array<{ rowsRead: number; rowsWritten: number }> = [];
    const sql = vi.spyOn(state.storage.sql, "exec").mockImplementation((query: string, ...args: any[]) => {
      calls.push(["sql", sha256Hex(JSON.stringify([query, args]))]);
      const cursor = original(query, ...args); cursors.push(cursor); return cursor;
    });
    const tx = vi.spyOn(state.storage, "transactionSync").mockImplementation((callback: () => unknown) => {
      calls.push(["begin"]);
      try { const result = transaction(callback); expect(result).not.toBeInstanceOf(Promise); calls.push(["commit"]); return result; }
      catch (error) { calls.push(["rollback"]); throw error; }
    });
    const reports: Record<string, unknown> = {};
    const capture = <T>(name: string, action: () => T): T => {
      calls = []; cursors = [];
      const value = action(); expect(value).not.toBeInstanceOf(Promise);
      reports[name] = { calls: calls.length, trace: sha256Hex(JSON.stringify(calls)),
        reads: cursors.reduce((n, c) => n + c.rowsRead, 0), writes: cursors.reduce((n, c) => n + c.rowsWritten, 0),
        result: JSON.parse(JSON.stringify(value ?? null)) };
      return value;
    };
    try {
      capture("admin_missing", () => r.adminStatus());
      capture("admin_setup", () => r.setupAdmin("synthetic-verifier", now));
      capture("admin_duplicate", () => r.setupAdmin("different", now));
      capture("admin_session", () => r.createAdminSession("s".repeat(64), "c".repeat(64), now + 10000, now, 1));
      capture("admin_session_read", () => r.verifyAdminSession("s".repeat(64), now));
      capture("admin_password_change", () => r.changeAdminPassword("new-synthetic-verifier", now + 1));
      capture("admin_session_revoked", () => r.verifyAdminSession("s".repeat(64), now + 2));
      capture("nonce_admit", () => r.consumeInternalNonce("a".repeat(64), now + 1000, now));
      capture("nonce_replay", () => r.consumeInternalNonce("a".repeat(64), now + 1000, now));
      capture("client_create", () => r.createMcpClient({ client_id: "c", label: "Synthetic client", secret_verifier: "b".repeat(64), secret_prefix: "test", scopes: ["coding:read", "coding:write", "coding:exec"] }, now));
      capture("client_authenticate", () => r.verifyMcpClient("b".repeat(64), now));
      capture("client_revalidate", () => r.revalidateMcpClient("c", 1));
      capture("client_bad_generation", () => r.revalidateMcpClient("c", 2));
      capture("runner_register", () => r.registerRunner("r", "d".repeat(64), now, "registration", "dedicated_user"));
      capture("runner_register_retry", () => r.registerRunner("r", "d".repeat(64), now, "registration", "dedicated_user"));
      const all = { read: true, edit: true, shell: true, job_control: true };
      capture("runner_permissions", () => r.setRunnerPermissions("r", all, now, "permissions"));
      capture("workspace_create", () => r.createManagedWorkspace("r", { workspace_id: "w", display_name: "Workspace", root_path: "/synthetic/workspace", enabled: true, permissions: all }, now, "workspace-create"));
      const desired = capture("policy_desired", () => r.getDesiredPolicySnapshot("r"))!;
      const before = r.getRunnerExecutionState("r")!;
      const epoch = capture("session_begin", () => r.beginConnection("r", { runner_version: "0.1.3", platform: "linux", architecture: "x64", hostname: "synthetic" } as any, { min_protocol_version: 2, max_protocol_version: 2 }, "session", before.runner.credential_version, now))!;
      capture("policy_ack", () => r.acknowledgePolicy("r", epoch, before.runner.credential_version, {
        desired_revision: desired.revision, desired_checksum: desired.checksum, applied_revision: desired.revision, applied_checksum: desired.checksum,
        runner_reported_policy_revision: desired.revision, runner_reported_policy_checksum: desired.checksum,
        status: "applied", workspace_status: [{ workspace_id: "w", status: "valid" }],
      }, now, before.lifecycle_id, "session"));
      capture("selection", () => r.selectMcpClientRunner("c", "r", false, now));
      capture("effective_permissions", () => r.effectivePermissions("c", "r", "w"));
      const authorization = { client_id: "c", secret_version: 1, runner_id: "r", method: "fs.read", workspace_id: "w", policy_revision: desired.revision, policy_checksum: desired.checksum };
      expect(capture("final_authorization", () => r.authorizeMcpRpc(authorization))).toEqual({ ok: true });
      capture("heartbeat", () => r.recordHeartbeat("r", epoch, before.runner.credential_version, now + 1, before.lifecycle_id, "session"));
      capture("heartbeat_replay", () => r.recordHeartbeat("r", epoch, before.runner.credential_version, now + 1, before.lifecycle_id, "session"));
      const job = { runner_id: "r", job_id: "j", workspace_id: "w", status: "running", created_by_client_id: "c", created_at_ms: now, updated_at_ms: now };
      capture("snapshot", () => r.syncRunner("r", epoch, before.runner.credential_version, [], [job], 0, now + 2, true, before.lifecycle_id, "session"));
      capture("snapshot_replay", () => r.syncRunner("r", epoch, before.runner.credential_version, [], [job], 0, now + 2, true, before.lifecycle_id, "session"));
      capture("jobs_read", () => r.listJobs("r", { workspace_id: "w", limit: 10 }));
      capture("job_detail", () => r.getJob("r", "j"));
      capture("recording_off", () => r.setJobRecording("c", false, now + 3));
      capture("unrecorded_snapshot", () => r.syncRunner("r", epoch, before.runner.credential_version, [], [{ ...job, job_id: "unrecorded", created_at_ms: now + 4 }], 1, now + 4, true, before.lifecycle_id, "session"));
      capture("unrecorded_missing", () => r.getJob("r", "unrecorded"));
      capture("dashboard", () => r.dashboardSnapshot());
      capture("permissions_deny", () => r.setClientRunnerOverride("c", "r", { read: true, edit: false, shell: false, job_control: false }, now + 5));
      capture("exec_denied", () => r.authorizeMcpRpc({ ...authorization, method: "exec.start" }));
      capture("client_rotate", () => r.rotateMcpClient("c", "e".repeat(64), "new", now + 6));
      capture("rotated_denied", () => r.authorizeMcpRpc(authorization));
      capture("runner_revoke", () => r.revokeRunner("r", "r", now + 7, "revoke"));
      capture("stale_session", () => r.sessionIsCurrent("r", epoch, before.runner.credential_version, true, before.lifecycle_id, "session"));
      capture("stale_snapshot", () => r.syncRunner("r", epoch, before.runner.credential_version, [], [job], 2, now + 8, true, before.lifecycle_id, "session"));
      if (RECORD_BASELINE) console.log("AR06_CHARACTERIZATION=" + JSON.stringify(reports));
      else expect(reports).toEqual(baseline);
    } finally { sql.mockRestore(); tx.mockRestore(); random.mockRestore(); clock.mockRestore(); }
  });
});

it("AR06 lifecycle and policy writes roll back together on policy-storage failure", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`domain-rollback-${crypto.randomUUID()}`));
  await runInDurableObject(stub, (r, state) => {
    const original = state.storage.sql.exec.bind(state.storage.sql);
    const sql = vi.spyOn(state.storage.sql, "exec").mockImplementation((query: string, ...args: any[]) => {
      if (query.startsWith("INSERT INTO runner_policy_versions")) throw new Error("synthetic policy storage failure");
      return original(query, ...args);
    });
    try { expect(() => r.registerRunner("rollback", "f".repeat(64), Date.now(), "rollback-mutation", "dedicated_user")).toThrow("synthetic policy storage failure"); }
    finally { sql.mockRestore(); }
    expect(r.getRunner("rollback")).toBeUndefined();
    expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM runner_mutations WHERE runner_id='rollback'").one().n).toBe(0);
    expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM runner_policy_versions WHERE runner_id='rollback'").one().n).toBe(0);
  });
});
