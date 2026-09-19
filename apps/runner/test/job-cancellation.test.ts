import { ChildProcess } from "node:child_process";
import { mkdtemp, realpath, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { JobManager, type JobEvent } from "../src/jobs.js";
import { PathPolicy } from "../src/path-policy.js";
import { nativeJobProcesses } from "../src/jobs/process.js";
import { nativeJobFiles } from "../src/jobs/storage.js";

type Observation = { alive: boolean; fingerprintMatches: boolean | null };

it.each(["lookup", "cancel", "list", "deduplicated-launch", "revoked-deduplicated-launch"])("retries a failed terminal write on %s without losing the witnessed process exit", async trigger => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runmesh-terminal-write-")));
  const state = join(root, "state"), child = new ChildProcess(), events: JobEvent[] = [];
  let failTerminal = true, writes = 0;
  const policy = new PathPolicy([{ workspaceId: "w", rootPath: root, readonly: false, shell: false }]);
  const manager = new JobManager({ stateDir: state, maxConcurrentJobs: 1, maxQueuedJobs: 0,
    policy, onEvent: event => events.push(event),
  }, {
    files: { ...nativeJobFiles, async atomicJson(path, value) {
      if (typeof value === "object" && value !== null && "status" in value && value.status === "failed") {
        writes++; if (failTerminal) throw Object.assign(new Error("synthetic terminal disk failure"), { code: "ENOSPC" });
      }
      await nativeJobFiles.atomicJson(path, value);
      if (!failTerminal && trigger === "revoked-deduplicated-launch") policy.replace([]);
    } },
    processes: { ...nativeJobProcesses, spawn: (() => child) as typeof nativeJobProcesses.spawn, fingerprintSync: () => null },
  });
  try {
    await manager.initialize();
    const input = { workspace_id: "w", command: [process.execPath, "-e", ""], request_id: "same-launch" };
    const job = await manager.start(input);
    child.exitCode = 7; child.emit("close", 7, null);
    await vi.waitFor(() => expect(writes).toBe(1));
    await new Promise(resolve => setImmediate(resolve));
    expect(manager.get(job.job_id).status).toBe("running");
    expect(events.filter(event => event.type === "completed")).toHaveLength(0);
    expect(manager.hasPendingHistoryRecovery()).toBe(true);
    await expect(manager.getReconciled(job.job_id)).rejects.toMatchObject({ code: "ENOSPC" });
    expect(writes).toBe(2);
    expect(events.filter(event => event.type === "status")).toHaveLength(1);
    failTerminal = false;
    if (trigger === "revoked-deduplicated-launch") await expect(manager.start(input)).rejects.toMatchObject({ code: "stale_policy" });
    const reconciled = trigger === "cancel" ? await manager.cancel(job.job_id)
      : trigger === "list" ? (await manager.listReconciled())[0]
      : trigger === "deduplicated-launch" ? await manager.start(input) : await manager.getReconciled(job.job_id);
    expect(reconciled).toMatchObject({ status: "failed", exit_code: 7 });
    expect(manager.queueStatus().running).toBe(0);
    expect(manager.hasPendingHistoryRecovery()).toBe(false);
    expect(JSON.parse(await readFile(join(state, "jobs", job.job_id, "meta.json"), "utf8"))).toMatchObject({ status: "failed", exit_code: 7 });
    expect(events.filter(event => event.type === "completed")).toHaveLength(1);
  } finally { await manager.flushPersistence(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

// Public adapter ports and synthetic ChildProcess objects only: these tests
// never launch an OS child, signal a PID, or replace private manager fields.
async function fixture(recovered: boolean) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runmesh-cancel-observation-")));
  const state = join(root, "state");
  const child = new ChildProcess(); child.pid = 424242;
  let observation: Observation = { alive: true, fingerprintMatches: true };
  let inspect = async (): Promise<Observation> => observation;
  let onStatus = (_event: JobEvent): void => undefined;
  let terminate = async (): Promise<boolean> => false;
  const events: JobEvent[] = [];
  const processes = {
    ...nativeJobProcesses,
    spawn: vi.fn(() => child) as typeof nativeJobProcesses.spawn,
    fingerprintSync: () => "100",
    inspectProcess: async () => inspect(),
    terminateProcess: vi.fn(async () => terminate()),
  };
  const options = {
    stateDir: state, maxConcurrentJobs: 1, maxQueuedJobs: 0,
    policy: new PathPolicy([{ workspaceId: "w", rootPath: root, readonly: false, shell: false }]),
  };
  const observe = (event: JobEvent): void => { events.push(event); onStatus(event); };
  const original = new JobManager({ ...options, ...(recovered ? {} : { onEvent: observe }) }, { processes });
  await original.initialize();
  const input = { workspace_id: "w", command: process.execPath, args: ["-e", ""] };
  const job = await original.start(input);
  const manager = recovered ? new JobManager({ ...options, onEvent: observe }, { processes }) : original;
  if (recovered) await manager.initialize();
  return {
    manager, job, input, events, processes,
    setObservation(value: Observation) { observation = value; },
    setInspector(value: () => Promise<Observation>) { inspect = value; },
    onCancelling(action: () => void) { onStatus = event => { if (event.type === "status" && event.job.status === "cancelling") action(); }; },
    setTerminator(value: () => Promise<boolean>) { terminate = value; },
    persisted: async () => JSON.parse(await readFile(join(state, "jobs", job.job_id, "meta.json"), "utf8")),
    async finishByCancellation() {
      onStatus = () => undefined;
      observation = { alive: true, fingerprintMatches: true };
      terminate = async () => {
        observation = { alive: false, fingerprintMatches: null };
        if (!recovered) { child.signalCode = "SIGTERM"; child.emit("close", null, "SIGTERM"); }
        return true;
      };
      await manager.cancel(job.job_id);
      expect(await manager.getReconciled(job.job_id)).toMatchObject({ status: "cancelled", cancellation_delivered_at_ms: expect.any(Number) });
      expect(manager.queueStatus().running).toBe(0);
    },
    async cleanup() {
      onStatus = () => undefined;
      if (child.exitCode === null && child.signalCode === null) { child.exitCode = 0; child.emit("close", 0, null); }
      await vi.waitFor(() => expect(["running", "cancelling"]).not.toContain(original.get(job.job_id).status));
      await original.flushPersistence(); await manager.flushPersistence();
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
    },
  };
}

for (const phase of ["before-signal", "after-undelivered-signal"] as const) {
  it.skipIf(process.platform !== "linux")(`local cancellation preserves supervision when identity becomes unavailable ${phase}`, async () => {
    const f = await fixture(false);
    try {
      const unavailable = () => f.setObservation({ alive: true, fingerprintMatches: null });
      if (phase === "before-signal") f.onCancelling(unavailable);
      else f.setTerminator(async () => { unavailable(); return false; });
      await expect(f.manager.cancel(f.job.job_id)).rejects.toThrow("identity could not be verified");
      expect(f.manager.get(f.job.job_id)).toMatchObject({ status: "running", completed_at_ms: null, cancellation_delivered_at_ms: null });
      expect(await f.persisted()).toMatchObject({ status: "running", completed_at_ms: null, cancellation_delivered_at_ms: null });
      expect(f.manager.queueStatus().running).toBe(1);
      expect(f.events.filter(event => event.type === "completed")).toEqual([]);
      expect(f.processes.terminateProcess).toHaveBeenCalledTimes(phase === "before-signal" ? 0 : 1);
      await expect(f.manager.start(f.input)).rejects.toThrow(/max concurrent/);
      expect(f.processes.spawn).toHaveBeenCalledTimes(1);
      // The original handle remains usable after identity observation recovers.
      await f.finishByCancellation();
    } finally { await f.cleanup(); }
  });
}

it("recovered cancellation retains an unverified live process and permits a later verified cancellation", async () => {
  const f = await fixture(true);
  try {
    f.onCancelling(() => f.setObservation({ alive: true, fingerprintMatches: null }));
    await expect(f.manager.cancel(f.job.job_id)).rejects.toThrow("identity is no longer verified");
    expect(f.manager.get(f.job.job_id)).toMatchObject({ status: "unknown", completed_at_ms: null, cancellation_delivered_at_ms: null, recovery_liveness: { alive: true, fingerprint_matches: null } });
    expect(await f.persisted()).toMatchObject({ status: "unknown", completed_at_ms: null, recovery_liveness: { alive: true, fingerprint_matches: null } });
    expect(f.manager.queueStatus().running).toBe(1);
    expect(f.events.filter(event => event.type === "completed")).toEqual([]);
    expect(f.processes.terminateProcess).not.toHaveBeenCalled();
    await expect(f.manager.start(f.input)).rejects.toThrow(/max concurrent/);
    expect(f.processes.spawn).toHaveBeenCalledTimes(1);
    await f.finishByCancellation();
  } finally { await f.cleanup(); }
});

for (const recovered of [false, true]) {
  it.skipIf(!recovered && process.platform !== "linux")(`${recovered ? "recovered" : "local"} cancellation distinguishes proven PID reuse from unavailable identity`, async () => {
    const f = await fixture(recovered);
    try {
      f.onCancelling(() => f.setObservation({ alive: true, fingerprintMatches: false }));
      expect(await f.manager.cancel(f.job.job_id)).toMatchObject({ status: "interrupted", cancellation_delivered_at_ms: null, recovery_liveness: { alive: true, fingerprint_matches: false } });
      expect(f.manager.queueStatus().running).toBe(0);
      expect(f.processes.terminateProcess).not.toHaveBeenCalled();
      expect(f.events.filter(event => event.type === "completed")).toHaveLength(1);
    } finally { await f.cleanup(); }
  });
}

it("recovered cancellation reconciles a confirmed process exit without claiming signal delivery", async () => {
  const f = await fixture(true);
  try {
    f.onCancelling(() => f.setObservation({ alive: false, fingerprintMatches: null }));
    expect(await f.manager.cancel(f.job.job_id)).toMatchObject({ status: "interrupted", cancellation_delivered_at_ms: null, recovery_liveness: { alive: false, fingerprint_matches: null } });
    expect(f.manager.queueStatus().running).toBe(0);
    expect(f.processes.terminateProcess).not.toHaveBeenCalled();
  } finally { await f.cleanup(); }
});

for (const phase of ["before-publication", "before-signal"] as const) {
  it(`recovered cancellation does not repeat a delivered signal after a concurrent ${phase} probe`, async () => {
    const f = await fixture(true);
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    let pending: Promise<ReturnType<JobManager["get"]>> | undefined;
    try {
      let inspections = 0;
      // cancel() reconciles once, then probes before publication and again
      // before signalling. Suspend only the first caller at the chosen seam.
      const pauseAt = phase === "before-publication" ? 2 : 3;
      f.setInspector(async () => {
        if (++inspections === pauseAt) await paused;
        return { alive: true, fingerprintMatches: true };
      });
      // Delivery may precede process exit. Keep the recovered process alive
      // so another request must honor the delivery marker, not terminal state.
      f.setTerminator(async () => true);
      pending = f.manager.cancel(f.job.job_id);
      await vi.waitFor(() => expect(inspections).toBe(pauseAt));
      const delivered = await f.manager.cancel(f.job.job_id);
      expect(delivered).toMatchObject({ status: "cancelling", cancellation_delivered_at_ms: expect.any(Number) });
      expect(f.processes.terminateProcess).toHaveBeenCalledTimes(1);
      release();
      expect(await pending).toBe(delivered);
      expect(f.processes.terminateProcess).toHaveBeenCalledTimes(1);
      expect(await f.persisted()).toMatchObject({ status: "cancelling", cancellation_delivered_at_ms: delivered.cancellation_delivered_at_ms });
      expect(f.manager.queueStatus().running).toBe(1);
      expect(f.events.filter(event => event.type === "completed")).toEqual([]);
    } finally {
      release();
      await pending?.catch(() => undefined);
      await f.cleanup();
    }
  });
}
