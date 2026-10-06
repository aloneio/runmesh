import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { PROTOCOL_CURRENT_VERSION } from "@aloneio/runmesh-protocol";
import { DEFAULT_JOB_HISTORY } from "../src/job-history-settings.js";

it.each(["job.status", "job.completed"] as const)("disabled history ignores legacy %s events while rejecting replaced sessions", async type => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`job-history-off-${crypto.randomUUID()}`));
  await runInDurableObject(stub, (instance, state) => {
    const now = Date.now(), runner = "history-off-runner", session = "history-off-session";
    instance.registerRunner(runner, "synthetic", now, undefined, "dedicated_user");
    const fence = instance.getRunnerExecutionState(runner)!;
    state.storage.sql.exec("UPDATE runners SET state = 'online', session_id = ?, last_heartbeat_ms = ? WHERE runner_id = ?", session, now, runner);
    const active = { runner_id: runner, job_id: "archived-job", workspace_id: "work", status: "running", created_at_ms: now, updated_at_ms: now };
    expect(instance.syncRunner(runner, fence.runner.connection_epoch, fence.runner.credential_version, [], [active], 0, now, true, fence.lifecycle_id, session)).toBe(true);
    expect(instance.setJobHistorySettings(runner, { ...DEFAULT_JOB_HISTORY, mode: "off" })).toBe(true);
    const event = (jobId: string) => ({
      type, protocol_version: PROTOCOL_CURRENT_VERSION, request_id: jobId,
      job: { ...active, job_id: jobId, status: "succeeded", updated_at_ms: now + 1 },
      ...(type === "job.completed" ? { completed_at_ms: now + 1, outcome: "succeeded", exit_code: 0 } : {}),
    });
    const spy = vi.spyOn(state.storage.sql, "exec");
    try {
      for (const jobId of ["new-job", "archived-job"]) {
        expect(instance.recordJobEvent(runner, fence.runner.connection_epoch, fence.runner.credential_version, event(jobId), now + 1, true, fence.lifecycle_id, session)).toBe(true);
      }
      expect(instance.recordJobEvent(runner, fence.runner.connection_epoch, fence.runner.credential_version, event("stale-job"), now + 1, true, fence.lifecycle_id, "replaced-session")).toBe(false);
      expect(spy.mock.calls.every(([sql]) => sql.trim().startsWith("SELECT"))).toBe(true);
    } finally { spy.mockRestore(); }
    expect(instance.getJob(runner, "new-job")).toBeUndefined();
    expect(instance.getJob(runner, "archived-job")).toMatchObject(active);
    expect(instance.setJobHistorySettings(runner, DEFAULT_JOB_HISTORY)).toBe(true);
    expect(instance.recordJobEvent(runner, fence.runner.connection_epoch, fence.runner.credential_version, event("archived-job"), now + 1, true, fence.lifecycle_id, session)).toBe(true);
    expect(instance.getJob(runner, "archived-job")).toMatchObject({ status: "succeeded" });
  });
});

it("client deletion prevents first-time history capture while preserving archived and Runner-owned Jobs", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`deleted-client-history-${crypto.randomUUID()}`));
  await runInDurableObject(stub, (instance, state) => {
    const now = Date.now(), runner = "deleted-client-runner", session = "deleted-client-session";
    instance.registerRunner(runner, "synthetic", now, undefined, "dedicated_user");
    instance.createMcpClient({ client_id: "deleted-client", label: "Deleted client", secret_verifier: "a".repeat(64), secret_prefix: "test", scopes: ["coding:read"] }, now);
    const fence = instance.getRunnerExecutionState(runner)!;
    state.storage.sql.exec("UPDATE runners SET state = 'online', session_id = ?, last_heartbeat_ms = ? WHERE runner_id = ?", session, now, runner);
    const job = { runner_id: runner, job_id: "archived-job", workspace_id: "work", status: "running", created_at_ms: now, updated_at_ms: now };
    const sync = (jobs: Array<typeof job & { created_by_client_id?: string }>, sequence: number) => instance.syncRunner(runner, fence.runner.connection_epoch, fence.runner.credential_version, [], jobs, sequence, now + sequence, true, fence.lifecycle_id, session);
    expect(sync([{ ...job, created_by_client_id: "deleted-client" }], 0)).toBe(true);
    expect(instance.setJobRecording("deleted-client", false, now + 1)).toBeDefined();
    expect(instance.deleteMcpClient("deleted-client")).toBe(true);
    expect(sync([
      { ...job, status: "succeeded", updated_at_ms: now + 2, created_by_client_id: "deleted-client" },
      { ...job, job_id: "unrecorded-job", created_by_client_id: "deleted-client" },
      { ...job, job_id: "runner-job" },
    ], 1)).toBe(true);
    expect(instance.getJob(runner, "archived-job")).toMatchObject({ status: "succeeded" });
    expect(instance.getJob(runner, "unrecorded-job")).toBeUndefined();
    expect(instance.getJob(runner, "runner-job")).toMatchObject({ status: "running" });
  });
});

it("does not regress terminal jobs when a delayed snapshot follows a completion event", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`job-order-${crypto.randomUUID()}`));
  await runInDurableObject(stub, (instance, state) => {
    const now = Date.now(), runner = "order-runner", session = "order-session";
    expect(instance.registerRunner(runner, "synthetic", now, undefined, "dedicated_user")).toBe(true);
    const fence = instance.getRunnerExecutionState(runner)!;
    state.storage.sql.exec("UPDATE runners SET state = 'online', session_id = ?, last_heartbeat_ms = ? WHERE runner_id = ?", session, now, runner);
    const active = { runner_id: runner, job_id: "order-job", workspace_id: "work", status: "running", created_at_ms: now, updated_at_ms: now };
    const done = { ...active, status: "succeeded", updated_at_ms: now + 1 };
    const sync = (jobs: typeof active[], sequence: number) => instance.syncRunner(runner, fence.runner.connection_epoch, fence.runner.credential_version, [], jobs, sequence, now + sequence + 10, true, fence.lifecycle_id, session);
    expect(sync([active], 0)).toBe(true);
    expect(instance.recordJobEvent(runner, fence.runner.connection_epoch, fence.runner.credential_version, {
      type: "job.completed", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: "order-job", job: done, completed_at_ms: now + 1, outcome: "succeeded", exit_code: 0,
    }, now + 2, true, fence.lifecycle_id, session)).toBe(true);
    expect(sync([active], 1)).toBe(true);
    expect(instance.getJob(runner, "order-job")).toMatchObject(done);
    // A stale active payload remains invalid even with an equal or newer timestamp.
    expect(sync([{ ...active, updated_at_ms: now + 1 }], 2)).toBe(true);
    expect(sync([{ ...active, updated_at_ms: now + 99 }], 3)).toBe(true);
    expect(instance.getJob(runner, "order-job")).toMatchObject(done);
    expect(instance.listJobs(runner, { status: "running" })).toHaveLength(0);
    expect(instance.dashboardSnapshot().runners[0]?.active_job_count).toBe(0);
    expect(sync([], 4)).toBe(true); // A bounded sync is not an authoritative deletion.
    expect(instance.getJob(runner, "order-job")).toMatchObject(done);
    instance.markDisconnected(runner, fence.runner.connection_epoch, fence.runner.credential_version, "offline", now + 100, fence.lifecycle_id, session);
    expect(instance.listJobs(runner)).toHaveLength(1);
  });
});

it("orders queued, running, cancelling and terminal transitions even within one millisecond", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`job-rank-${crypto.randomUUID()}`));
  await runInDurableObject(stub, (instance, state) => {
    const now = Date.now(), runner = "rank-runner", session = "rank-session";
    instance.registerRunner(runner, "synthetic", now, undefined, "dedicated_user");
    const fence = instance.getRunnerExecutionState(runner)!;
    state.storage.sql.exec("UPDATE runners SET state = 'online', session_id = ?, last_heartbeat_ms = ? WHERE runner_id = ?", session, now, runner);
    let sequence = 0;
    const sync = (status: string) => instance.syncRunner(runner, fence.runner.connection_epoch, fence.runner.credential_version, [], [{ runner_id: runner, job_id: "rank-job", workspace_id: "work", status, created_at_ms: now, updated_at_ms: now }], sequence++, now, true, fence.lifecycle_id, session);
    for (const status of ["queued", "running", "cancelling"]) { expect(sync(status)).toBe(true); expect(instance.getJob(runner, "rank-job")).toMatchObject({ status }); }
    for (const status of ["queued", "running"]) { expect(sync(status)).toBe(true); expect(instance.getJob(runner, "rank-job")).toMatchObject({ status: "cancelling" }); }
    expect(sync("cancelled")).toBe(true);
    for (const status of ["running", "failed", "succeeded", "interrupted"]) { expect(sync(status)).toBe(true); expect(instance.getJob(runner, "rank-job")).toMatchObject({ status: "cancelled" }); }
  });
});

it.each([
  ["cancelling", "running"],
  ["unknown", "cancelling"],
] as const)("accepts only newer %s to %s recovery observations", async (before, after) => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`job-recovery-order-${crypto.randomUUID()}`));
  await runInDurableObject(stub, (instance, state) => {
    const now = Date.now(), runner = "recovery-runner", session = "recovery-session";
    instance.registerRunner(runner, "synthetic", now, undefined, "dedicated_user");
    const fence = instance.getRunnerExecutionState(runner)!;
    state.storage.sql.exec("UPDATE runners SET state = 'online', session_id = ?, last_heartbeat_ms = ? WHERE runner_id = ?", session, now, runner);
    let sequence = 0;
    const sync = (status: string, updatedAt: number) => instance.syncRunner(runner, fence.runner.connection_epoch, fence.runner.credential_version, [], [
      { runner_id: runner, job_id: "recovery-job", workspace_id: "work", status, created_at_ms: now - 1, updated_at_ms: updatedAt },
    ], sequence++, now + 10, true, fence.lifecycle_id, session);
    expect(sync(before, now)).toBe(true);
    for (const updatedAt of [now - 1, now]) {
      expect(sync(after, updatedAt)).toBe(true);
      expect(instance.getJob(runner, "recovery-job")).toMatchObject({ status: before, updated_at_ms: now });
    }
    expect(sync(after, now + 1)).toBe(true);
    expect(instance.getJob(runner, "recovery-job")).toMatchObject({ status: after, updated_at_ms: now + 1 });
    expect(sync(before, now)).toBe(true);
    expect(sync("queued", now + 2)).toBe(true);
    expect(instance.getJob(runner, "recovery-job")).toMatchObject({ status: after, updated_at_ms: now + 1 });
    expect(sync("cancelled", now + 3)).toBe(true);
    expect(sync(after, now + 4)).toBe(true);
    expect(instance.getJob(runner, "recovery-job")).toMatchObject({ status: "cancelled", updated_at_ms: now + 3 });
  });
});

it("deduplicates unchanged job writes and keeps list/detail/dashboard reads read-only", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`job-reads-${crypto.randomUUID()}`));
  await runInDurableObject(stub, (instance, state) => {
    const now = Date.now(), runner = "reads-runner", session = "reads-session";
    instance.registerRunner(runner, "synthetic", now, undefined, "dedicated_user");
    const fence = instance.getRunnerExecutionState(runner)!;
    state.storage.sql.exec("UPDATE runners SET state = 'online', session_id = ?, last_heartbeat_ms = ? WHERE runner_id = ?", session, now, runner);
    const job = { runner_id: runner, job_id: "same-job", workspace_id: "work", status: "running", created_at_ms: now, updated_at_ms: now };
    const sync = (sequence: number) => instance.syncRunner(runner, fence.runner.connection_epoch, fence.runner.credential_version, [], [job], sequence, now, true, fence.lifecycle_id, session);
    expect(sync(0)).toBe(true);
    const original = state.storage.sql.exec.bind(state.storage.sql);
    const writes: number[] = [];
    const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((sql: string, ...args: any[]) => {
      const result = original(sql, ...args); if (sql.startsWith("INSERT INTO jobs")) writes.push(result.rowsWritten); return result;
    });
    try {
      expect(sync(1)).toBe(true); expect(writes).toEqual([0]);
      spy.mockClear();
      expect(instance.listJobs(runner)).toHaveLength(1);
      expect(instance.getJob(runner, "same-job")).toMatchObject(job);
      expect(instance.dashboardSnapshot().jobs).toHaveLength(1);
      expect(spy.mock.calls.every(([sql]) => sql.trim().startsWith("SELECT"))).toBe(true);
    } finally { spy.mockRestore(); }
  });
});
