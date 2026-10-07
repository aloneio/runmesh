import { lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { JobManager } from "../src/jobs.js";
import { PathPolicy } from "../src/path-policy.js";
import { nativeJobFiles } from "../src/jobs/storage.js";
import { createJobProcessProbe } from "./helpers/job-process-probe.js";
import { jobRecord } from "./helpers/job-record.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});
const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runmesh-initialization-"));
  const workspace = join(root, "workspace"), stateDir = join(root, "state");
  await mkdir(workspace);
  const policy = new PathPolicy([{ workspaceId: "w", rootPath: await realpath(workspace), readonly: false, shell: false }]);
  return { policy, stateDir, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}

async function retainedFixture() {
  const f = await fixture(), job = jobRecord({ workspace_id: "w", status: "succeeded", pid: null, completed_at_ms: 3, exit_code: 0 });
  const directory = join(f.stateDir, "jobs", job.job_id), output = join(directory, "stdout.log");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "meta.json"), JSON.stringify(job));
  const manager = new JobManager({ policy: f.policy, stateDir: f.stateDir, maxLogBytesPerJob: 8, maxTotalLogBytes: 8 });
  return { ...f, job, directory, output, manager };
}

it.each(["EACCES", "EIO", "ELOOP"])("preserves a retained metadata %s error instead of forgetting its log budget", async code => {
  const f = await retainedFixture(), metadata = join(f.directory, "meta.json");
  const failure = Object.assign(new Error(`retained metadata read failed: ${code}`), { code });
  let unavailable = true;
  try {
    await writeFile(f.output, "0123456789abcdef");
    vi.mocked(lstat).mockImplementation((async (...args: Parameters<typeof actual.lstat>) => {
      if (String(args[0]) === metadata && unavailable) throw failure;
      return actual.lstat(...args);
    }) as typeof actual.lstat);
    await expect(f.manager.initialize()).rejects.toBe(failure);
    expect(await readFile(f.output, "utf8")).toBe("0123456789abcdef");
    unavailable = false;
    await f.manager.initialize();
    expect(f.manager.list()).toEqual([]);
    await expect(actual.lstat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { vi.mocked(lstat).mockImplementation(actual.lstat); await f.manager.flushPersistence(); await f.cleanup(); }
});

it("retries unreadable active metadata before reporting available process slots", async () => {
  const f = await fixture(), job = jobRecord({ workspace_id: "w" });
  const directory = join(f.stateDir, "jobs", job.job_id), metadata = join(directory, "meta.json");
  const failure = Object.assign(new Error("active metadata temporarily unavailable"), { code: "EIO" });
  const probe = createJobProcessProbe();
  const manager = new JobManager({ policy: f.policy, stateDir: f.stateDir, maxConcurrentJobs: 1 }, {
    processes: { ...probe.processes, inspectProcess: async () => ({ alive: true, fingerprintMatches: true }) },
  });
  let unavailable = true;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(metadata, JSON.stringify(job));
    vi.mocked(lstat).mockImplementation((async (...args: Parameters<typeof actual.lstat>) => {
      if (String(args[0]) === metadata && unavailable) throw failure;
      return actual.lstat(...args);
    }) as typeof actual.lstat);
    await expect(manager.initialize()).rejects.toBe(failure);
    unavailable = false;
    await manager.initialize();
    expect(manager.get(job.job_id)).toMatchObject({ status: "unknown", recovery_liveness: { alive: true, fingerprint_matches: true } });
    expect(manager.queueStatus()).toMatchObject({ running: 1, available_slots: 0 });
    expect(probe.children).toEqual([]);
  } finally { vi.mocked(lstat).mockImplementation(actual.lstat); await manager.flushPersistence(); await f.cleanup(); }
});

it.each(["malformed", "oversized", "non_regular"])("recovers valid records beside %s metadata", async kind => {
  const f = await retainedFixture(), metadata = join(f.directory, "meta.json");
  const validJob = { ...f.job, job_id: "job-00000000-0000-0000-0000-000000000002" };
  const validDirectory = join(f.stateDir, "jobs", validJob.job_id);
  try {
    await mkdir(validDirectory, { mode: 0o700 });
    await writeFile(join(validDirectory, "meta.json"), JSON.stringify(validJob));
    if (kind === "malformed") await writeFile(metadata, "{truncated");
    else if (kind === "oversized") {
      const handle = await actual.open(metadata, "r+");
      try { await handle.truncate(9 * 1024 * 1024); } finally { await handle.close(); }
    } else { await rm(metadata); await mkdir(metadata); }
    await f.manager.initialize();
    expect(f.manager.list()).toMatchObject([{ job_id: validJob.job_id, status: "succeeded", exit_code: 0 }]);
    expect(f.manager.list()).toHaveLength(1);
  } finally { await f.manager.flushPersistence(); await f.cleanup(); }
});

it("ignores a job directory whose metadata was never published", async () => {
  const f = await fixture(), directory = join(f.stateDir, "jobs", jobRecord().job_id);
  const manager = new JobManager({ policy: f.policy, stateDir: f.stateDir });
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await manager.initialize();
    expect(manager.list()).toEqual([]);
    expect(manager.queueStatus()).toMatchObject({ running: 0, available_slots: 1 });
  } finally { await manager.flushPersistence(); await f.cleanup(); }
});

it.each(["EACCES", "EIO", "ELOOP"])("preserves a log accounting %s error and retries initialization with the real retained bytes", async code => {
  const f = await retainedFixture(), failure = Object.assign(new Error(`retained log measurement failed: ${code}`), { code });
  let unavailable = true;
  try {
    await writeFile(f.output, "0123456789abcdef");
    vi.mocked(lstat).mockImplementation((async (...args: Parameters<typeof actual.lstat>) => {
      if (String(args[0]) === f.output && unavailable) throw failure;
      return actual.lstat(...args);
    }) as typeof actual.lstat);
    await expect(f.manager.initialize()).rejects.toBe(failure);
    expect(await readFile(f.output, "utf8")).toBe("0123456789abcdef");
    unavailable = false;
    await f.manager.initialize();
    expect(f.manager.list()).toEqual([]);
    await expect(actual.lstat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { vi.mocked(lstat).mockImplementation(actual.lstat); await f.manager.flushPersistence(); await f.cleanup(); }
});

it("recovers a terminal job with no output files as zero retained log bytes", async () => {
  const f = await retainedFixture();
  try {
    await f.manager.initialize();
    expect(f.manager.list()).toMatchObject([{ job_id: f.job.job_id, status: "succeeded" }]);
    await expect(lstat(f.output)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await f.manager.flushPersistence(); await f.cleanup(); }
});

it("retains live process ownership when initialization is requested after a transport restart", async () => {
  const f = await fixture(), probe = createJobProcessProbe();
  const manager = new JobManager({ policy: f.policy, stateDir: f.stateDir }, { processes: probe.processes });
  try {
    await manager.initialize();
    const job = await manager.start({ workspace_id: "w", command: process.execPath,
      args: ["-e", "process.stdin.on('data', data => process.stdout.write(data));"], shell: false });
    await manager.initialize();
    expect(manager.get(job.job_id)).toMatchObject({ status: "running", recovery_liveness: null });
    await expect(manager.input(job.job_id, "after restart\n", true)).resolves.toEqual({ accepted: 14, eof: true });
    await vi.waitFor(() => expect(manager.get(job.job_id)).toMatchObject({ status: "succeeded", exit_code: 0 }), { timeout: 5_000 });
    expect(await manager.logs(job.job_id)).toMatchObject({ data: "after restart\n" });
  } finally {
    await Promise.all(probe.children.map(child => new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      child.once("close", () => resolve()); child.kill();
    })));
    await manager.flushPersistence();
    await f.cleanup();
  }
});

it("shares pending initialization and retries a failed storage setup", async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ensure = vi.fn<typeof nativeJobFiles.ensureJobStorageDirectories>()
    .mockRejectedValueOnce(new Error("storage temporarily unavailable"))
    .mockImplementation(async (...args) => { await gate; await nativeJobFiles.ensureJobStorageDirectories(...args); });
  const write = vi.fn(nativeJobFiles.atomicJson);
  const manager = new JobManager({ policy: f.policy, stateDir: f.stateDir }, { files: { ...nativeJobFiles,
    ensureJobStorageDirectories: ensure, atomicJson: write } });
  const pending: Promise<void>[] = [];
  try {
    await expect(manager.initialize()).rejects.toThrow("storage temporarily unavailable");
    const first = manager.initialize(), second = manager.initialize();
    pending.push(first, second);
    expect(ensure).toHaveBeenCalledTimes(2);
    release();
    await Promise.all([first, second]);
    await manager.initialize();
    expect(write).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(join(f.stateDir, "runner.json"), "utf8"))).toMatchObject({ workspaces: ["w"] });
  } finally { release(); await Promise.allSettled(pending); await manager.flushPersistence(); await f.cleanup(); }
});
