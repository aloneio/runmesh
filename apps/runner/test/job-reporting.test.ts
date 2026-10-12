import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { JobManager } from "../src/jobs.js";
import { normalizeJobRecord } from "../src/jobs/records.js";
import { PathPolicy } from "../src/path-policy.js";
import { jobRecord } from "./helpers/job-record.js";
import { encodeWireFrame, decodeWireFrame } from "@aloneio/runmesh-protocol";
import { jobEventMessage } from "../src/connection/job-events.js";

async function fixture(completedRecords = 0) {
  const base = await mkdtemp(join(tmpdir(), "runmesh-reporting-"));
  const root = join(base, "work"); await mkdir(root);
  const policy = new PathPolicy([{ workspaceId: "w", rootPath: await realpath(root), readonly: false, shell: false }]);
  for (let index = 0; index < completedRecords; index++) {
    const job = jobRecord({ job_id: "job-00000000-0000-0000-0000-" + String(index).padStart(12, "0"), workspace_id: "w", status: "succeeded", pid: null,
      updated_at_ms: Date.now() + 60_000 + index, completed_at_ms: Date.now() + 60_000 + index, exit_code: 0 });
    const directory = join(base, "state", "jobs", job.job_id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "meta.json"), JSON.stringify(job));
  }
  const jobs = new JobManager({ policy, stateDir: join(base, "state"), maxConcurrentJobs: 2, maxRetainedJobs: Math.max(100, completedRecords + 10) });
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

it("recovers full native exit codes and projects legacy-compatible completion frames", async () => {
  const f = await fixture();
  const codes = [-(2 ** 31), -1, 0, 255, 256, 3010, 2 ** 31, 0xc0000005, 0xffffffff];
  try {
    for (const [index, code] of codes.entries()) {
      const job = jobRecord({ job_id: "job-00000000-0000-0000-0000-" + String(index).padStart(12, "0"), workspace_id: "w",
        status: code === 0 ? "succeeded" : "failed", pid: null, completed_at_ms: 4, exit_code: code });
      expect(normalizeJobRecord(job)?.exit_code).toBe(code);
      const directory = join(f.base, "state", "jobs", job.job_id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(join(directory, "meta.json"), JSON.stringify(job));
      const frame = jobEventMessage({ type: "completed", job }, "runner");
      expect(frame).toBeDefined();
      expect(decodeWireFrame(encodeWireFrame(frame!))).toMatchObject({ type: "job.completed", outcome: job.status,
        exit_code: code >= -1 && code <= 255 ? code : null });
    }
    const restored = new JobManager({ policy: f.policy, stateDir: join(f.base, "state") });
    await restored.initialize();
    expect(restored.list().map(job => job.exit_code).sort((a, b) => a! - b!)).toEqual([...codes].sort((a, b) => a - b));
    for (const code of [-(2 ** 31) - 1, 2 ** 32, 0.5, "3010"]) expect(normalizeJobRecord({ ...jobRecord(), exit_code: code })).toBeUndefined();
  } finally { await f.close(); }
});

it.skipIf(process.platform !== "win32")("retains Windows native child exit status through completion and restart", async () => {
  const f = await fixture();
  try {
    for (const [requested, expected] of [[3010, 3010], [-1073741819, 0xc0000005]]) {
      const job = await f.jobs.start({ ...f.input(`windows-exit-${expected}`), command: [process.execPath, "-e", `process.exit(${requested})`] });
      await f.finished(job.job_id);
      expect(f.jobs.get(job.job_id)).toMatchObject({ status: "failed", exit_code: expected });
      const restored = new JobManager({ policy: f.policy, stateDir: join(f.base, "state") });
      await restored.initialize();
      expect(restored.get(job.job_id)).toMatchObject({ status: "failed", exit_code: expected });
    }
  } finally { await f.close(); }
});

it("active history IDs include a long job outside the history page and omit private jobs", async () => {
  const f = await fixture(100), started: string[] = [];
  try {
    const command = [process.execPath, "-e", "process.stdin.resume()"];
    const active = await f.jobs.start({ ...f.input("long-running", true), command }); started.push(active.job_id);
    const hidden = await f.jobs.start({ ...f.input("private-running", false), command }); started.push(hidden.job_id);
    expect(f.jobs.list()).toHaveLength(100);
    expect(f.jobs.list().some(job => job.job_id === active.job_id)).toBe(false);
    expect(f.jobs.activeHistoryJobIds()).toEqual([active.job_id]);
    await f.jobs.cancel(active.job_id); await f.finished(active.job_id);
    expect(f.jobs.activeHistoryJobIds()).toEqual([]);
  } finally {
    for (const id of started) { await f.jobs.cancel(id); await f.finished(id); }
    await f.close();
  }
});

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
