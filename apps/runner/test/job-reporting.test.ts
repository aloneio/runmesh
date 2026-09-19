import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { JobManager } from "../src/jobs.js";
import { normalizeJobRecord } from "../src/jobs/records.js";
import { PathPolicy } from "../src/path-policy.js";

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "runmesh-reporting-"));
  const root = join(base, "work"); await mkdir(root);
  const policy = new PathPolicy([{ workspaceId: "w", rootPath: await realpath(root), readonly: false, shell: false }]);
  const jobs = new JobManager({ policy, stateDir: join(base, "state"), maxConcurrentJobs: 2 });
  await jobs.initialize();
  const input = (id: string, record?: boolean) => ({ workspace_id: "w", command: [process.execPath, "-e", "process.stdout.write('local-only')"],
    created_by_client_id: id, request_id: id, ...(record === undefined ? {} : { record_history: record }) });
  async function finished(id: string) {
    for (let i = 0; i < 400; i++) {
      if (["succeeded", "failed", "cancelled", "interrupted"].includes(jobs.get(id).status)) { await jobs.flushPersistence(); return; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error("Synthetic job did not finish");
  }
  return { base, policy, jobs, input, finished, async close() {
    for (const job of jobs.list()) { await jobs.cancel(job.job_id); await finished(job.job_id); }
    await rm(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  } };
}

it("no-record jobs remain locally executable/readable but are omitted before the cloud snapshot limit", async () => {
  const f = await fixture();
  try {
    const recorded = await f.jobs.start(f.input("recorded", true)); await f.finished(recorded.job_id);
    const hidden = await f.jobs.start(f.input("hidden", false)); await f.finished(hidden.job_id);
    expect((await f.jobs.snapshotForSync(1)).map(j => j.job_id)).toEqual([recorded.job_id]);
    expect(f.jobs.get(hidden.job_id)).toMatchObject({ status: "succeeded", record_history: false });
    expect(await f.jobs.logs(hidden.job_id, { stream: "stdout" })).toMatchObject({ data: "local-only" });
    expect(f.jobs.get(hidden.job_id)).toHaveProperty("record_history", false);
  } finally { await f.close(); }
});

it("no-record survives local persistence and a fresh manager, without replaying the job", async () => {
  const f = await fixture();
  try {
    const job = await f.jobs.start(f.input("private", false)); await f.finished(job.job_id);
    const restored = new JobManager({ policy: f.policy, stateDir: join(f.base, "state") }); await restored.initialize();
    expect(restored.get(job.job_id)).toMatchObject({ record_history: false, status: "succeeded" });
    expect(await restored.snapshotForSync()).toEqual([]);
    expect(await restored.logs(job.job_id)).toMatchObject({ data: "local-only" });
  } finally { await f.close(); }
});

it("retrying a launch cannot opt an originally unrecorded job into history", async () => {
  const f = await fixture();
  try {
    const job = await f.jobs.start(f.input("same", false)); await f.finished(job.job_id);
    const retried = await f.jobs.start(f.input("same", true));
    expect(retried.job_id).toBe(job.job_id); expect(await f.jobs.snapshotForSync()).toEqual([]);
  } finally { await f.close(); }
});

it("legacy records retain compatibility, while malformed explicit recording markers never enable upload", async () => {
  const f = await fixture();
  try {
    const job = await f.jobs.start(f.input("legacy")); await f.finished(job.job_id);
    expect((await f.jobs.snapshotForSync()).map(j => j.job_id)).toContain(job.job_id);
    for (const marker of [null, "true", 1, {}, []]) {
      expect(normalizeJobRecord({ ...job, record_history: marker })).toMatchObject({ record_history: false });
    }
  } finally { await f.close(); }
});
