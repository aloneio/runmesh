import { ChildProcess } from "node:child_process";
import { mkdtemp, realpath, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { JobManager, type JobEvent, type JobRecord } from "../src/jobs.js";
import { PathPolicy } from "../src/path-policy.js";
import { nativeJobProcesses } from "../src/jobs/process.js";
import { nativeJobFiles } from "../src/jobs/storage.js";

type Observation = { alive: boolean; fingerprintMatches: boolean | null };
const alive: Observation = { alive: true, fingerprintMatches: true };
const reused: Observation = { alive: true, fingerprintMatches: false };
function gate<T>() {
  let release!: (value: T) => void;
  let reject!: (error: Error) => void;
  return { promise: new Promise<T>((resolve, rejectPromise) => { release = resolve; reject = rejectPromise; }), release: (value: T) => release(value), reject: (error: Error) => reject(error) };
}

// A synthetic ChildProcess and Linux process observations drive the public
// manager API. These fixtures never spawn an OS child or signal any PID.
async function fixture(phase: "before-signal" | "after-undelivered-signal" | "concurrent" = "before-signal") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runmesh-identity-persistence-")));
  const stateDir = join(root, "state"), child = new ChildProcess();
  child.pid = 424242;
  const stdout = new PassThrough();
  Object.assign(child, { stdout });
  const state = {
    observation: alive,
    inspect: async (): Promise<Observation> => state.observation,
    terminate: async (): Promise<boolean> => false,
    beforeTerminal: async (): Promise<void> => undefined,
    beforeLogRead: async (): Promise<void> => undefined,
    failTerminal: true,
    writes: 0, signals: 0, spawned: 0, events: [] as JobEvent[],
  };
  const processes = {
    ...nativeJobProcesses,
    spawn: (() => { state.spawned++; return child; }) as typeof nativeJobProcesses.spawn,
    fingerprintSync: () => "100",
    inspectProcess: async () => state.inspect(),
    terminateProcess: async () => {
      state.signals++;
      if (phase === "after-undelivered-signal") state.observation = reused;
      return state.terminate();
    },
  };
  const policy = new PathPolicy([{ workspaceId: "w", rootPath: root, readonly: false, shell: false }]);
  const manager = new JobManager({ stateDir, maxConcurrentJobs: 1, maxQueuedJobs: 0, maxLogBytesPerJob: 1024, policy,
    onEvent: event => {
      state.events.push(event);
      if (phase === "before-signal" && event.type === "status" && event.job.status === "cancelling") state.observation = reused;
    },
  }, { processes, files: {
    ...nativeJobFiles,
    openJobLog: async (path, mode) => {
      if (mode === "read") await state.beforeLogRead();
      return nativeJobFiles.openJobLog(path, mode);
    },
    atomicJson: async (path, value) => {
      if (typeof value === "object" && value !== null && "status" in value && value.status === "interrupted") {
        state.writes++; await state.beforeTerminal();
        if (state.failTerminal) throw Object.assign(new Error("synthetic identity terminal disk full"), { code: "ENOSPC" });
      }
      await nativeJobFiles.atomicJson(path, value);
    },
  } });
  await manager.initialize();
  const input = { workspace_id: "w", command: [process.execPath, "-e", ""], request_id: "identity-loss" };
  const job = await manager.start(input);
  return { manager, job, state, child, stdout,
    persisted: async () => JSON.parse(await readFile(join(stateDir, "jobs", job.job_id, "meta.json"), "utf8")) as JobRecord,
    retry: async (trigger: string) => trigger === "cancel" ? manager.cancel(job.job_id)
      : trigger === "get" ? manager.getReconciled(job.job_id)
      : trigger === "list" ? (await manager.listReconciled()).find(record => record.job_id === job.job_id)!
      : trigger === "launch" ? manager.start(input)
      : (await manager.snapshotForSync()).find(record => record.job_id === job.job_id)!,
    restart: async () => {
      await manager.flushPersistence();
      const restarted = new JobManager({ stateDir, policy }, { processes });
      await restarted.initialize();
      return restarted.get(job.job_id);
    },
    close: async () => {
      state.failTerminal = false;
      state.beforeTerminal = async () => undefined;
      state.beforeLogRead = async () => undefined;
      await manager.getReconciled(job.job_id);
      await manager.flushPersistence();
      stdout.destroy();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

for (const phase of ["before-signal", "after-undelivered-signal"] as const) {
  it.skipIf(process.platform !== "linux").each(["cancel", "get", "list", "sync", "launch"])(`retains ${phase} identity loss until terminal persistence succeeds through %s`, async trigger => {
    const f = await fixture(phase);
    try {
      await expect(f.manager.cancel(f.job.job_id)).rejects.toMatchObject({ code: "ENOSPC" });
      expect(f.manager.get(f.job.job_id).status).toBe("cancelling");
      expect((await f.persisted()).status).toBe("cancelling");
      expect(f.manager.queueStatus().running).toBe(1);
      expect(f.manager.hasPendingHistoryRecovery()).toBe(true);
      expect(f.state.events.filter(event => event.type === "completed")).toHaveLength(0);
      f.state.observation = alive;
      await expect(f.retry(trigger)).rejects.toMatchObject({ code: "ENOSPC" });
      expect(f.state.writes).toBe(2);
      f.state.failTerminal = false;
      const result = await f.retry(trigger);
      expect(result).toMatchObject({ status: "interrupted", cancellation_delivered_at_ms: null,
        recovery_liveness: { alive: true, fingerprint_matches: false } });
      expect(await f.persisted()).toEqual(result);
      expect(f.manager.queueStatus().running).toBe(0);
      expect(f.manager.hasPendingHistoryRecovery()).toBe(false);
      expect(f.state.spawned).toBe(1);
      expect(f.state.signals).toBe(phase === "before-signal" ? 0 : 1);
      expect(f.state.events.filter(event => event.type === "completed")).toHaveLength(1);
      expect((await f.restart()).status).toBe("interrupted");
    } finally { await f.close(); }
  });
}

it.skipIf(process.platform !== "linux").each([false, true])("joins local close and ignores late output while identity-loss persistence is pending, fail=%s", async fail => {
  const f = await fixture();
  const write = gate<void>(), writing = gate<void>();
  let pending: Promise<PromiseSettledResult<JobRecord>[]> | undefined;
  try {
    f.state.failTerminal = fail;
    f.state.beforeTerminal = async () => { writing.release(); await write.promise; };
    const cancellation = f.manager.cancel(f.job.job_id);
    await writing.promise;
    const read = f.manager.getReconciled(f.job.job_id);
    pending = Promise.allSettled([cancellation, read]);
    f.stdout.emit("data", Buffer.alloc(2048));
    f.child.exitCode = 0; f.child.emit("close", 0, null);
    expect(f.manager.get(f.job.job_id).status).toBe("cancelling");
    write.release();
    expect((await pending).map(result => result.status)).toEqual(fail ? ["rejected", "rejected"] : ["fulfilled", "fulfilled"]);
    f.state.failTerminal = false;
    const result = await f.manager.getReconciled(f.job.job_id);
    expect(result).toMatchObject({ status: "interrupted", output_truncated: false });
    expect(await f.persisted()).toEqual(result);
    expect(f.state.signals).toBe(0);
    expect(f.state.events.filter(event => event.type === "completed")).toHaveLength(1);
  } finally { write.release(); await pending; await f.close(); }
});

it.skipIf(process.platform !== "linux").each([0, 7])("keeps witnessed identity loss when an earlier local close is still flushing, exit=%s", async code => {
  const f = await fixture();
  const probe = gate<Observation>(), probing = gate<void>(), logs = gate<void>(), flushing = gate<void>();
  let pending: Promise<PromiseSettledResult<JobRecord>[]> | undefined;
  try {
    let inspections = 0;
    f.state.inspect = async () => {
      if (++inspections === 2) { probing.release(); return probe.promise; }
      return alive;
    };
    f.state.beforeLogRead = async () => { flushing.release(); await logs.promise; };
    f.state.failTerminal = false;
    const cancellation = f.manager.cancel(f.job.job_id);
    pending = Promise.allSettled([cancellation]);
    await probing.promise;
    f.child.exitCode = code; f.child.emit("close", code, null);
    await flushing.promise;
    probe.release(reused);
    await new Promise(resolve => setImmediate(resolve));
    logs.release();
    expect((await pending).map(result => result.status)).toEqual(["fulfilled"]);
    expect(await cancellation).toMatchObject({ status: "interrupted", cancellation_delivered_at_ms: null });
    expect((await f.persisted()).status).toBe("interrupted");
    expect(f.state.events.filter(event => event.type === "completed")).toHaveLength(1);
    expect(f.state.signals).toBe(0);
  } finally { probe.release(reused); logs.release(); await pending; await f.close(); }
});

it.skipIf(process.platform !== "linux").each(["delivered", "declined", "rejected"] as const)("joins identity-loss completion after an in-flight local termination is %s", async outcome => {
  const f = await fixture("concurrent");
  const termination = gate<boolean>(), signalling = gate<void>(), write = gate<void>(), writing = gate<void>();
  let pending: Promise<PromiseSettledResult<JobRecord>[]> | undefined;
  try {
    f.state.terminate = async () => { signalling.release(); return termination.promise; };
    f.state.failTerminal = false;
    f.state.beforeTerminal = async () => { writing.release(); await write.promise; };
    const first = f.manager.cancel(f.job.job_id);
    await signalling.promise;
    let inspections = 0;
    f.state.inspect = async () => ++inspections === 1 ? alive : reused;
    const second = f.manager.cancel(f.job.job_id);
    pending = Promise.allSettled([first, second]);
    await writing.promise;
    if (outcome === "rejected") termination.reject(new Error("synthetic termination failure"));
    else termination.release(outcome === "delivered");
    await new Promise(resolve => setImmediate(resolve));
    write.release();
    expect((await pending).map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    const result = f.manager.get(f.job.job_id);
    expect(await first).toEqual(result);
    expect(await second).toEqual(result);
    expect(result).toMatchObject({ status: "interrupted", cancellation_delivered_at_ms: null });
    expect(await f.persisted()).toEqual(result);
    expect(f.manager.hasPendingHistoryRecovery()).toBe(false);
    expect(f.manager.queueStatus().running).toBe(0);
    expect(f.state.events.filter(event => event.type === "completed")).toHaveLength(1);
    expect(f.state.signals).toBe(1);
  } finally { termination.release(false); write.release(); await pending; await f.close(); }
});
