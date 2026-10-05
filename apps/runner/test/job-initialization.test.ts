import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { JobManager } from "../src/jobs.js";
import { PathPolicy } from "../src/path-policy.js";
import { nativeJobFiles } from "../src/jobs/storage.js";
import { createJobProcessProbe } from "./helpers/job-process-probe.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runmesh-initialization-"));
  const workspace = join(root, "workspace"), stateDir = join(root, "state");
  await mkdir(workspace);
  const policy = new PathPolicy([{ workspaceId: "w", rootPath: await realpath(workspace), readonly: false, shell: false }]);
  return { policy, stateDir, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}

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
