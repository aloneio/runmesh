import { ChildProcess } from "node:child_process";
import { mkdtemp, realpath, readFile, rm, cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { JobManager, type JobEvent, type JobRecord } from "../src/jobs.js";
import { PathPolicy } from "../src/path-policy.js";
import { nativeJobFiles } from "../src/jobs/storage.js";
import { nativeJobProcesses } from "../src/jobs/process.js";

// Exercise the public supervisor methods with controlled filesystem faults.
// Synthetic children keep these durability tests independent of OS signals.
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runmesh-queued-cancellation-")));
  const stateDir = join(root, "state");
  const policy = new PathPolicy([{ workspaceId: "w", rootPath: root, readonly: false, shell: false }]);
  const children: ChildProcess[] = [], events: JobEvent[] = [];
  let failWrites = false, failSpawn = false, writes = 0;
  let beforeWrite = async (_job: JobRecord): Promise<void> => undefined;
  const processes = { ...nativeJobProcesses, spawn: vi.fn(() => {
    if (failSpawn) throw Object.assign(new Error("synthetic spawn failure"), { code: "EACCES" });
    const child = new ChildProcess(); child.pid = 424242 + children.length; children.push(child); return child;
  }) as typeof nativeJobProcesses.spawn, fingerprintSync: () => "100", inspectProcess: async () => ({ alive: false, fingerprintMatches: null }) };
  const manager = new JobManager({ stateDir, policy, maxConcurrentJobs: 1, maxQueuedJobs: 4,
    authorizeQueuedJob: async () => true, onEvent: event => events.push(event),
  }, { processes, files: { ...nativeJobFiles, async atomicJson(path, value) {
    const job = value as JobRecord;
    if (job.status === "cancelled" || job.status === "failed") {
      writes++; await beforeWrite(job);
      if (failWrites) throw Object.assign(new Error("synthetic disk full"), { code: "ENOSPC" });
    }
    await nativeJobFiles.atomicJson(path, value);
  } } });
  await manager.initialize();
  const launch = (request_id: string) => manager.start({ workspace_id: "w", command: [process.execPath, "-e", ""], request_id });
  const complete = (child: ChildProcess): void => { child.exitCode = 0; child.emit("close", 0, null); };
  return { root, stateDir, policy, manager, launch, processes, children, events, complete,
    get writes() { return writes; },
    fail(value: boolean) { failWrites = value; },
    failSpawn(value: boolean) { failSpawn = value; },
    beforeWrite(action: typeof beforeWrite) { beforeWrite = action; },
    persisted: async (id: string) => JSON.parse(await readFile(join(stateDir, "jobs", id, "meta.json"), "utf8")) as JobRecord,
    async close() {
      failWrites = false; beforeWrite = async () => undefined;
      for (const child of children) if (child.exitCode === null) complete(child);
      await manager.reconcileRecoveredJobs();
      await vi.waitFor(() => expect(manager.queueStatus().running).toBe(0));
      await manager.flushPersistence();
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
    },
  };
}

it.each(["cancel", "get", "list", "sync", "deduplicated-launch"])("retries a queued cancellation through %s after storage recovers", async trigger => {
  const f = await fixture();
  try {
    const running = await f.launch("holding"), queued = await f.launch("waiting");
    f.fail(true);
    await expect(f.manager.cancel(queued.job_id)).rejects.toMatchObject({ code: "ENOSPC" });
    expect(f.manager.get(queued.job_id).status).toBe("queued");
    expect((await f.persisted(queued.job_id)).status).toBe("queued");
    expect(f.manager.hasPendingHistoryRecovery()).toBe(true);
    expect(f.manager.queueStatus()).toMatchObject({ running: 1, waiting: 0 });
    expect(f.events.filter(event => event.type === "completed" && event.job.job_id === queued.job_id)).toHaveLength(0);
    // Finishing the first child must not dispatch the cancelled queue entry.
    f.complete(f.children[0]!);
    await vi.waitFor(() => expect(f.manager.get(running.job_id).status).toBe("succeeded"));
    expect(f.processes.spawn).toHaveBeenCalledTimes(1);
    f.fail(false);
    const result = trigger === "cancel" ? await f.manager.cancel(queued.job_id)
      : trigger === "get" ? await f.manager.getReconciled(queued.job_id)
      : trigger === "list" ? (await f.manager.listReconciled()).find(job => job.job_id === queued.job_id)
      : trigger === "sync" ? (await f.manager.snapshotForSync()).find(job => job.job_id === queued.job_id)
      : await f.launch("waiting");
    expect(result).toMatchObject({ job_id: queued.job_id, status: "cancelled", pid: null });
    expect((await f.persisted(queued.job_id)).status).toBe("cancelled");
    expect(f.manager.hasPendingHistoryRecovery()).toBe(false);
    await f.manager.cancel(queued.job_id);
    expect(f.writes).toBe(2);
    expect(f.events.filter(event => event.type === "completed" && event.job.job_id === queued.job_id)).toHaveLength(1);
    expect(f.manager.queueStatus()).toMatchObject({ running: 0, waiting: 0 });
  } finally { await f.close(); }
});

it("shares one durable cancellation between concurrent callers", async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { entered = resolve; });
  try {
    await f.launch("holding"); const queued = await f.launch("waiting");
    f.beforeWrite(async () => { entered(); await blocked; });
    const first = f.manager.cancel(queued.job_id); await observed;
    const second = f.manager.cancel(queued.job_id), read = f.manager.getReconciled(queued.job_id);
    expect(f.manager.get(queued.job_id).status).toBe("queued");
    release();
    expect((await Promise.all([first, second, read])).map(job => job.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(f.writes).toBe(1);
    expect(f.events.filter(event => event.type === "completed" && event.job.job_id === queued.job_id)).toHaveLength(1);
  } finally { release(); await f.close(); }
});

it("keeps a pending cancellation out of dispatch when dequeue authorization settles", async () => {
  const f = await fixture();
  let release!: (allowed: boolean) => void, entered!: () => void;
  const authorized = new Promise<boolean>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { entered = resolve; });
  try {
    f.manager.setQueueAuthorizer(async () => { entered(); return authorized; });
    await f.launch("holding"); const queued = await f.launch("waiting");
    f.complete(f.children[0]!); await observed;
    f.fail(true);
    await expect(f.manager.cancel(queued.job_id)).rejects.toMatchObject({ code: "ENOSPC" });
    release(true);
    await vi.waitFor(() => expect(f.writes).toBe(2));
    expect(f.processes.spawn).toHaveBeenCalledTimes(1);
    expect(f.manager.get(queued.job_id).status).toBe("queued");
    f.fail(false);
    expect((await f.manager.getReconciled(queued.job_id)).status).toBe("cancelled");
  } finally { release(false); await f.close(); }
});

it.each([false, true])("recovers the actual stored outcome after a queued cancellation, durable=%s", async durable => {
  const f = await fixture();
  try {
    await f.launch("holding"); const queued = await f.launch("waiting");
    f.fail(!durable);
    if (durable) await f.manager.cancel(queued.job_id);
    else await expect(f.manager.cancel(queued.job_id)).rejects.toMatchObject({ code: "ENOSPC" });
    const recoveredDir = join(f.root, "recovered");
    await mkdir(join(recoveredDir, "jobs"), { recursive: true, mode: 0o700 });
    await cp(join(f.stateDir, "jobs", queued.job_id), join(recoveredDir, "jobs", queued.job_id), { recursive: true });
    const recovered = new JobManager({ stateDir: recoveredDir, policy: f.policy }, { processes: { ...nativeJobProcesses, spawn: f.processes.spawn, inspectProcess: async () => ({ alive: false, fingerprintMatches: null }) } });
    await recovered.initialize();
    expect(recovered.get(queued.job_id)).toMatchObject({ status: durable ? "cancelled" : "interrupted", pid: null });
    expect(recovered.queueStatus()).toMatchObject({ running: 0, waiting: 0 });
    expect(f.processes.spawn).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});

it.each(["authorization", "policy"])("retries a queued %s failure after storage recovers without launching it", async failure => {
  const f = await fixture();
  try {
    if (failure === "authorization") f.manager.setQueueAuthorizer(async () => false);
    await f.launch("holding"); const queued = await f.launch("waiting");
    if (failure === "policy") f.policy.replace([]);
    f.fail(true); f.complete(f.children[0]!);
    await vi.waitFor(() => expect(f.writes).toBe(1));
    await expect(f.manager.getReconciled(queued.job_id)).rejects.toMatchObject({ code: "ENOSPC" });
    expect(f.manager.get(queued.job_id).status).toBe("queued");
    expect((await f.persisted(queued.job_id)).status).toBe("queued");
    expect(f.manager.hasPendingHistoryRecovery()).toBe(true);
    f.fail(false);
    expect((await f.manager.getReconciled(queued.job_id)).status).toBe("failed");
    expect((await f.persisted(queued.job_id)).status).toBe("failed");
    expect(f.processes.spawn).toHaveBeenCalledTimes(1);
    expect(f.events.filter(event => event.type === "completed" && event.job.job_id === queued.job_id)).toHaveLength(1);
    expect(f.manager.queueStatus()).toMatchObject({ running: 0, waiting: 0 });
  } finally { await f.close(); }
});

it("persists cancellation when it supersedes an in-flight queued failure", async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { entered = resolve; });
  try {
    f.manager.setQueueAuthorizer(async () => false);
    await f.launch("holding"); const queued = await f.launch("waiting");
    f.beforeWrite(async job => { if (job.status === "failed") { entered(); await blocked; } });
    f.complete(f.children[0]!); await observed;
    const cancellation = f.manager.cancel(queued.job_id);
    const read = f.manager.getReconciled(queued.job_id);
    release();
    expect((await Promise.all([cancellation, read])).map(job => job.status)).toEqual(["cancelled", "cancelled"]);
    expect((await f.persisted(queued.job_id)).status).toBe("cancelled");
    expect(f.writes).toBe(2);
    expect(f.events.filter(event => event.type === "completed" && event.job.job_id === queued.job_id).map(event => event.job.status)).toEqual(["cancelled"]);
    expect(f.processes.spawn).toHaveBeenCalledTimes(1);
  } finally { release(); await f.close(); }
});

it("retains an unstarted launch failure until its terminal record can be saved", async () => {
  const f = await fixture();
  try {
    f.failSpawn(true); f.fail(true);
    await expect(f.launch("failed-start")).rejects.toMatchObject({ code: "ENOSPC" });
    const job = f.manager.list()[0]!;
    expect(job).toMatchObject({ status: "queued", pid: null });
    expect((await f.persisted(job.job_id)).status).toBe("queued");
    expect(f.manager.hasPendingHistoryRecovery()).toBe(true);
    f.fail(false); f.failSpawn(false);
    expect(await f.launch("failed-start")).toMatchObject({ job_id: job.job_id, status: "failed", pid: null });
    expect((await f.persisted(job.job_id)).status).toBe("failed");
    expect(f.processes.spawn).toHaveBeenCalledTimes(1);
    expect(f.children).toHaveLength(0);
    expect(f.events.filter(event => event.type === "completed" && event.job.job_id === job.job_id)).toHaveLength(1);
  } finally { await f.close(); }
});
