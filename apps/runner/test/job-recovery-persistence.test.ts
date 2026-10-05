import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { JobManager, type JobRecord, type JobEvent } from "../src/jobs.js";
import { PathPolicy } from "../src/path-policy.js";
import { nativeJobFiles } from "../src/jobs/storage.js";
import { nativeJobProcesses } from "../src/jobs/process.js";
import { jobRecord } from "./helpers/job-record.js";

const alive = { alive: true, fingerprintMatches: true };
const dead = { alive: false, fingerprintMatches: null };
function gate<T>() {
  let release!: (value: T) => void;
  return { promise: new Promise<T>(resolve => { release = resolve; }), release: (value: T) => release(value) };
}

// Public supervisor operations, real metadata files, and synthetic process
// observations exercise recovery without spawning or signalling an OS process.
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runmesh-recovery-persistence-")));
  const stateDir = join(root, "state"), job = jobRecord(), jobDir = join(stateDir, "jobs", job.job_id);
  await mkdir(jobDir, { recursive: true, mode: 0o700 });
  const path = join(jobDir, "meta.json");
  await writeFile(path, JSON.stringify(job));
  const policy = new PathPolicy([{ workspaceId: "workspace-1", rootPath: root, readonly: false, shell: false }]);
  const state = {
    inspect: async (): Promise<{ alive: boolean; fingerprintMatches: boolean | null }> => alive,
    terminate: async () => true,
    beforeWrite: async (_record: JobRecord): Promise<void> => undefined,
    fail: (_record: JobRecord) => false,
    writes: [] as JobRecord[], signals: 0, events: [] as JobEvent[],
  };
  const processes = { ...nativeJobProcesses,
    spawn: (() => { throw new Error("recovery must not spawn"); }) as typeof nativeJobProcesses.spawn,
    inspectProcess: () => state.inspect(),
    terminateProcess: async () => { state.signals++; return state.terminate(); },
  };
  const manager = new JobManager({ stateDir, policy, onEvent: event => state.events.push(event) }, { processes, files: {
    ...nativeJobFiles, atomicJson: async (target, value) => {
      if (target === path) {
        const record = value as JobRecord;
        state.writes.push(record); await state.beforeWrite(record);
        if (state.fail(record)) throw Object.assign(new Error("synthetic disk full"), { code: "ENOSPC" });
      }
      return nativeJobFiles.atomicJson(target, value);
    },
  } });
  await manager.initialize();
  expect(manager.get(job.job_id).status).toBe("unknown");
  state.writes.length = 0;
  return { manager, job, state,
    persisted: async () => JSON.parse(await readFile(path, "utf8")) as JobRecord,
    retry: async (trigger: string) => trigger === "cancel" ? manager.cancel(job.job_id)
      : trigger === "get" ? manager.getReconciled(job.job_id)
      : trigger === "list" ? (await manager.listReconciled()).find(record => record.job_id === job.job_id)!
      : (await manager.snapshotForSync()).find(record => record.job_id === job.job_id)!,
    restart: async () => {
      await manager.flushPersistence();
      const restarted = new JobManager({ stateDir, policy }, { processes: { ...processes, inspectProcess: async () => dead } });
      await restarted.initialize();
      return restarted.get(job.job_id);
    },
    close: async () => {
      await manager.flushPersistence();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

for (const scenario of ["observed-exit", "exit-before-signal"] as const) {
  it.each(["cancel", "get", "list", "sync"])(`retries ${scenario} terminal persistence through %s`, async trigger => {
    const f = await fixture();
    try {
      let inspections = 0;
      f.state.inspect = async () => scenario === "observed-exit" || ++inspections >= 3 ? dead : alive;
      f.state.fail = record => record.status === "interrupted";
      await expect(scenario === "observed-exit" ? f.manager.getReconciled(f.job.job_id) : f.manager.cancel(f.job.job_id))
        .rejects.toMatchObject({ code: "ENOSPC" });
      const previousStatus = scenario === "observed-exit" ? "unknown" : "cancelling";
      expect(f.manager.get(f.job.job_id).status).toBe(previousStatus);
      expect((await f.persisted()).status).toBe(previousStatus);
      expect(f.manager.hasPendingHistoryRecovery()).toBe(true);
      expect(f.manager.queueStatus().running).toBe(1);
      expect(f.state.events.filter(event => event.type === "completed")).toHaveLength(0);
      // The candidate survives another failed attempt and a later ambiguous
      // PID observation: witnessed exit evidence must not be discarded.
      f.state.inspect = async () => alive;
      await expect(f.retry(trigger)).rejects.toMatchObject({ code: "ENOSPC" });
      f.state.fail = () => false;
      const result = await f.retry(trigger);
      expect(result.status).toBe("interrupted");
      expect(await f.persisted()).toEqual(result);
      expect(f.manager.hasPendingHistoryRecovery()).toBe(false);
      expect(f.manager.queueStatus().running).toBe(0);
      expect(f.state.signals).toBe(0);
      expect(f.state.events.filter(event => event.type === "completed")).toHaveLength(1);
      expect((await f.restart()).status).toBe("interrupted");
    } finally { await f.close(); }
  });
}

for (const exited of [false, true]) {
  it.each(["cancel", "get", "list", "sync"])(`repairs a failed cancellation marker through %s, exited=${exited}`, async trigger => {
    const f = await fixture();
    try {
      f.state.fail = record => record.cancellation_delivered_at_ms !== null;
      await expect(f.manager.cancel(f.job.job_id)).rejects.toMatchObject({ code: "ENOSPC" });
      const deliveredAt = f.manager.get(f.job.job_id).cancellation_delivered_at_ms;
      expect(deliveredAt).toEqual(expect.any(Number));
      expect((await f.persisted()).cancellation_delivered_at_ms).toBeNull();
      f.state.inspect = async () => exited ? dead : alive;
      await expect(f.retry(trigger)).rejects.toMatchObject({ code: "ENOSPC" });
      expect(f.manager.hasPendingHistoryRecovery()).toBe(true);
      expect(f.state.signals).toBe(1);
      f.state.fail = () => false;
      const result = await f.retry(trigger);
      expect(result).toMatchObject({ status: exited ? "cancelled" : "cancelling", cancellation_delivered_at_ms: deliveredAt });
      expect(await f.persisted()).toEqual(result);
      expect(f.state.events.filter(event => event.type === "completed")).toHaveLength(exited ? 1 : 0);
      await f.manager.cancel(f.job.job_id);
      expect(f.state.signals).toBe(1);
      expect(await f.restart()).toMatchObject({ status: "cancelled", cancellation_delivered_at_ms: deliveredAt });
    } finally { await f.close(); }
  });
}

it.each([false, true])("joins a recovered terminal write when cancellation's identity probe settles, fail=%s", async fail => {
  const f = await fixture();
  const probe = gate<typeof alive>(), probed = gate<void>(), write = gate<void>(), writing = gate<void>();
  let pending: Promise<PromiseSettledResult<JobRecord>[]> | undefined;
  try {
    let inspections = 0;
    f.state.inspect = async () => {
      if (++inspections === 1) return alive;
      if (inspections === 2) { probed.release(); return probe.promise; }
      return dead;
    };
    f.state.beforeWrite = async record => { if (record.status === "interrupted") { writing.release(); await write.promise; } };
    f.state.fail = record => fail && record.status === "interrupted";
    const cancellation = f.manager.cancel(f.job.job_id);
    await probed.promise;
    const read = f.manager.getReconciled(f.job.job_id);
    pending = Promise.allSettled([cancellation, read]);
    await writing.promise;
    probe.release(alive);
    expect(f.manager.get(f.job.job_id).status).toBe("unknown");
    write.release();
    const results = await pending;
    expect(results.map(result => result.status)).toEqual(fail ? ["rejected", "rejected"] : ["fulfilled", "fulfilled"]);
    expect(f.state.signals).toBe(0);
    f.state.fail = () => false;
    expect((await f.manager.cancel(f.job.job_id)).status).toBe("interrupted");
    expect((await f.persisted()).status).toBe("interrupted");
    expect(f.state.events.filter(event => event.type === "completed")).toHaveLength(1);
  } finally { probe.release(alive); write.release(); await pending; await f.close(); }
});

it.each([false, true])("waits for in-flight recovered termination before classifying exit, delivered=%s", async delivered => {
  const f = await fixture();
  const termination = gate<boolean>(), signalling = gate<void>(), observedExit = gate<void>();
  let pending: Promise<PromiseSettledResult<JobRecord>[]> | undefined;
  try {
    f.state.terminate = async () => { signalling.release(); return termination.promise; };
    const cancellation = f.manager.cancel(f.job.job_id);
    await signalling.promise;
    f.state.inspect = async () => { observedExit.release(); return dead; };
    const read = f.manager.getReconciled(f.job.job_id);
    pending = Promise.allSettled([cancellation, read]);
    await observedExit.promise;
    expect(f.state.events.filter(event => event.type === "completed")).toHaveLength(0);
    termination.release(delivered);
    expect((await pending).map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await read).toMatchObject({ status: delivered ? "cancelled" : "interrupted" });
    expect(await f.persisted()).toMatchObject({ status: delivered ? "cancelled" : "interrupted" });
    expect(f.state.signals).toBe(1);
    expect(f.state.events.filter(event => event.type === "completed")).toHaveLength(1);
    expect((await f.restart()).status).toBe(delivered ? "cancelled" : "interrupted");
  } finally { termination.release(delivered); await pending; await f.close(); }
});

it("shares recovered cancellation evidence after concurrent marker writes fail", async () => {
  const f = await fixture();
  const termination = gate<boolean>(), signalling = gate<void>();
  let pending: Promise<PromiseSettledResult<JobRecord>[]> | undefined;
  try {
    f.state.terminate = async () => { signalling.release(); return termination.promise; };
    f.state.fail = record => record.cancellation_delivered_at_ms !== null;
    pending = Promise.allSettled([f.manager.cancel(f.job.job_id), f.manager.cancel(f.job.job_id)]);
    await signalling.promise;
    termination.release(true);
    expect((await pending).map(result => result.status)).toEqual(["rejected", "rejected"]);
    expect(f.state.signals).toBe(1);
    f.state.fail = () => false;
    await Promise.all([f.manager.cancel(f.job.job_id), f.manager.getReconciled(f.job.job_id), f.manager.snapshotForSync()]);
    expect((await f.persisted()).cancellation_delivered_at_ms).toEqual(expect.any(Number));
    f.state.inspect = async () => dead;
    expect((await f.manager.getReconciled(f.job.job_id)).status).toBe("cancelled");
    expect(f.state.signals).toBe(1);
    expect(f.state.events.filter(event => event.type === "completed")).toHaveLength(1);
  } finally { termination.release(true); await pending; await f.close(); }
});

it("retains cancellation when a marker write and concurrent exit persistence both fail", async () => {
  const f = await fixture();
  const marker = gate<void>(), writingMarker = gate<void>(), observedExit = gate<void>();
  let pending: Promise<PromiseSettledResult<JobRecord>[]> | undefined;
  try {
    f.state.beforeWrite = async record => {
      if (record.status === "cancelling" && record.cancellation_delivered_at_ms !== null) {
        writingMarker.release(); await marker.promise;
      }
    };
    f.state.fail = record => record.cancellation_delivered_at_ms !== null;
    const cancellation = f.manager.cancel(f.job.job_id);
    await writingMarker.promise;
    f.state.inspect = async () => { observedExit.release(); return dead; };
    const read = f.manager.getReconciled(f.job.job_id);
    pending = Promise.allSettled([cancellation, read]);
    await observedExit.promise;
    marker.release();
    expect((await pending).map(result => result.status)).toEqual(["rejected", "rejected"]);
    expect(f.manager.get(f.job.job_id).status).toBe("cancelling");
    expect(f.manager.hasPendingHistoryRecovery()).toBe(true);
    expect(f.state.events.filter(event => event.type === "completed")).toHaveLength(0);
    f.state.fail = () => false;
    expect((await f.manager.cancel(f.job.job_id)).status).toBe("cancelled");
    expect((await f.persisted()).status).toBe("cancelled");
    expect(f.state.signals).toBe(1);
    expect(f.state.events.filter(event => event.type === "completed")).toHaveLength(1);
  } finally { marker.release(); await pending; await f.close(); }
});

it("recovers the stored outcome if the Runner restarts before a failed marker is repaired", async () => {
  const f = await fixture();
  try {
    f.state.fail = record => record.cancellation_delivered_at_ms !== null;
    await expect(f.manager.cancel(f.job.job_id)).rejects.toMatchObject({ code: "ENOSPC" });
    expect(await f.persisted()).toMatchObject({ status: "cancelling", cancellation_delivered_at_ms: null });
    expect(await f.restart()).toMatchObject({ status: "interrupted", cancellation_delivered_at_ms: null });
    expect(f.state.signals).toBe(1);
  } finally { await f.close(); }
});

it("retains confirmed delivery when a concurrent cancellation loses process identity", async () => {
  const f = await fixture();
  const termination = gate<boolean>(), signalling = gate<void>();
  let pending: Promise<PromiseSettledResult<JobRecord>[]> | undefined;
  try {
    f.state.terminate = async () => { signalling.release(); return termination.promise; };
    const first = f.manager.cancel(f.job.job_id);
    pending = Promise.allSettled([first]);
    await signalling.promise;
    let inspections = 0;
    f.state.inspect = async () => ++inspections < 3 ? alive : { alive: true, fingerprintMatches: null };
    await expect(f.manager.cancel(f.job.job_id)).rejects.toThrow("process identity");
    expect(f.manager.get(f.job.job_id).status).toBe("unknown");
    termination.release(true);
    expect((await pending).map(result => result.status)).toEqual(["fulfilled"]);
    expect(await first).toMatchObject({ status: "cancelling", cancellation_delivered_at_ms: expect.any(Number) });
    f.state.inspect = async () => dead;
    expect((await f.manager.getReconciled(f.job.job_id)).status).toBe("cancelled");
    expect((await f.persisted()).status).toBe("cancelled");
    expect(f.state.signals).toBe(1);
  } finally { termination.release(true); await pending; await f.close(); }
});
