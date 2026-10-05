import { mkdtemp, realpath, mkdir, writeFile, appendFile, readFile, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobManager } from "../src/jobs.js";
import { PathPolicy } from "../src/path-policy.js";
import { nativeJobFiles } from "../src/jobs/storage.js";
import type { JobFilePort } from "../src/jobs/ports.js";
import { MAX_LOG_RESPONSE_BYTES, wireResponseBytes } from "../src/jobs/logs.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))); });

async function fixture(files: JobFilePort = nativeJobFiles, budget = 1024, maxRetainedJobs = 100) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runmesh-log-failure-"))); roots.push(root);
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const stateDir = join(root, "state");
  const policy = new PathPolicy([{ workspaceId: "w", rootPath: workspace, readonly: false, shell: true }]);
  const manager = new JobManager({ policy, stateDir, maxRetainedJobs, maxLogBytesPerJob: budget, maxTotalLogBytes: budget }, { files });
  await manager.initialize();
  return { root, manager, stateDir, policy };
}

async function completed(manager: JobManager, source = "") {
  const job = await manager.start({ workspace_id: "w", command: process.execPath, args: ["-e", source] });
  await vi.waitFor(() => expect(manager.get(job.job_id).status).toBe("succeeded"), { timeout: 10000 });
  await manager.flushPersistence();
  return job;
}

describe.sequential("public Job log fault boundaries", () => {
  it.each(["live", "append"])("aligns %s UTF-8 offsets and tails across short OS reads", async consistency => {
    const f = await fixture({ ...nativeJobFiles, openJobLog: async (path, mode) => {
      const handle = await nativeJobFiles.openJobLog(path, mode);
      if (mode === "read") {
        const read = handle.read.bind(handle);
        handle.read = (async (buffer: Buffer, offset: number, length: number, position: number | null) => read(buffer, offset, Math.min(1, length), position)) as FileHandle["read"];
      }
      return handle;
    } });
    const job = await completed(f.manager);
    await writeFile(join(f.stateDir, "jobs", job.job_id, "stdout.log"), "abc中def");
    expect(await f.manager.logs(job.job_id, { consistency, offset: 4, limit: 9 })).toMatchObject({ offset: 6, data: "def" });
    expect(await f.manager.logs(job.job_id, { consistency, tail: true, limit: 2 })).toMatchObject({ offset: 7, data: "ef" });
  });

  it.each(["live", "append"])("preserves the end of %s tails when the limit intersects a UTF-8 character", async consistency => {
    const f = await fixture();
    const job = await completed(f.manager);
    const path = join(f.stateDir, "jobs", job.job_id, "stdout.log");
    for (const character of ["中", "😀"]) {
      const source = Buffer.from(`abc${character}def`);
      await writeFile(path, source);
      for (const limit of [1, 4, 5, 6]) {
        const page = await f.manager.logs(job.job_id, { consistency, tail: true, limit });
        expect(page).toMatchObject({ size: source.length, resume_offset: source.length, page_state: "end", next_cursor: null, truncated: false, truncated_reason: null, pending_bytes: 0 });
        expect(page.data).toBe(source.subarray(page.offset as number).toString("utf8"));
        expect(page.data).not.toContain("\uFFFD");
        expect(page.returned_bytes).toBeGreaterThanOrEqual(limit);
        expect(page.returned_bytes).toBeLessThanOrEqual(limit + 3);
      }
    }
    const source = Buffer.from("abc中" + "x".repeat(4093) + "F");
    await writeFile(path, source);
    const page = await f.manager.logs(job.job_id, { consistency, tail: true, limit: 4096 });
    expect(page).toMatchObject({ offset: 3, returned_bytes: 4097, data: source.subarray(3).toString("utf8"), resume_offset: source.length, page_state: "end" });
  });

  it.each(["live", "append"])("fits an escaped %s tail from its beginning while ordinary pages keep their prefix", async consistency => {
    const f = await fixture();
    const job = await completed(f.manager);
    for (const content of ["\0".repeat(19992), ("\0".repeat(10) + "中😀").repeat(1200)]) {
      const source = Buffer.from("BEGIN" + content + "END");
      await writeFile(join(f.stateDir, "jobs", job.job_id, "stdout.log"), source);
      const page = await f.manager.logs(job.job_id, { consistency, tail: true, limit: 16384 });
      expect(page).toMatchObject({ size: source.length, resume_offset: source.length, page_state: "end", next_cursor: null, truncated: false, truncated_reason: null, pending_bytes: 0 });
      expect(page.offset).toBeGreaterThan(source.length - 16384);
      expect(page.data).toBe(source.subarray(page.offset as number).toString("utf8"));
      expect(page.data).not.toContain("\uFFFD");
      expect((page.data as string).endsWith("END")).toBe(true);
      expect(wireResponseBytes(page)).toBeLessThanOrEqual(MAX_LOG_RESPONSE_BYTES);
      const forward = await f.manager.logs(job.job_id, { consistency, offset: 0, limit: 16384 });
      expect(forward).toMatchObject({ offset: 0, page_state: "more", truncated: true, truncated_reason: "response_bytes" });
      expect(forward.data).toBe(source.subarray(0, forward.resume_offset as number).toString("utf8"));
      expect((forward.data as string).startsWith("BEGIN")).toBe(true);
      expect(wireResponseBytes(forward)).toBeLessThanOrEqual(MAX_LOG_RESPONSE_BYTES);
    }
  });

  it("resumes an append-consistent UTF-8 tail at EOF after more output arrives", async () => {
    const f = await fixture();
    const job = await completed(f.manager);
    const path = join(f.stateDir, "jobs", job.job_id, "stdout.log");
    await writeFile(path, "abc中def");
    const tail = await f.manager.logs(job.job_id, { consistency: "append", tail: true, limit: 4 });
    expect(tail).toMatchObject({ data: "中def", resume_offset: 9, page_state: "end" });
    await appendFile(path, "新");
    expect(await f.manager.logs(job.job_id, { consistency: "append", cursor: tail.resume_cursor })).toMatchObject({ offset: 9, data: "新", resume_offset: 12, page_state: "end" });
  });

  it.each(["live", "append"])("preserves the resume position for an incomplete UTF-8 character at %s tail EOF", async consistency => {
    const f = await fixture();
    const job = await completed(f.manager);
    const path = join(f.stateDir, "jobs", job.job_id, "stdout.log");
    const character = Buffer.from("中");
    await writeFile(path, Buffer.concat([Buffer.from("abc"), character.subarray(0, 2)]));
    const progress = await f.manager.logs(job.job_id, { consistency, tail: true, limit: 3 });
    expect(progress).toMatchObject({ offset: 2, data: "c", resume_offset: 3, page_state: "more" });
    const pending = await f.manager.logs(job.job_id, { consistency, tail: true, limit: 1 });
    expect(pending).toMatchObject({ offset: 3, data: "", resume_offset: 3, page_state: "incomplete", pending_bytes: 2, next_cursor: null, truncated_reason: "incomplete_utf8" });
    await appendFile(path, character.subarray(2));
    expect(await f.manager.logs(job.job_id, { consistency, cursor: consistency === "append" ? pending.resume_cursor : String(pending.resume_offset) })).toMatchObject({ offset: 3, data: "中", resume_offset: 6, page_state: "end" });
  });

  it.each(["partial", "full"])("shares the total budget across Jobs after failed %s appends", async kind => {
    let appends = 0;
    const f = await fixture({ ...nativeJobFiles, appendJobLog: async (path, bytes) => {
      await nativeJobFiles.appendJobLog(path, kind === "partial" ? bytes.subarray(0, Math.ceil(bytes.length / 2)) : bytes);
      appends++;
      throw Object.assign(new Error("log write failed after progress"), { code: "EIO" });
    } }, 16);
    let bytes = 0;
    for (let i = 0; i < 3; i++) {
      const job = await completed(f.manager, "process.stdout.write('abcdefghijklmnop');");
      expect(f.manager.get(job.job_id).output_truncated).toBe(true);
      bytes += (await readFile(join(f.stateDir, "jobs", job.job_id, "stdout.log"))).length;
    }
    expect(appends).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(16);
  });

  it("retains one Job's reservation when append succeeds but closing reports an error", async () => {
    let appends = 0;
    const f = await fixture({ ...nativeJobFiles, appendJobLog: async (path, bytes) => {
      await nativeJobFiles.appendJobLog(path, bytes);
      appends++;
      throw Object.assign(new Error("log close failed"), { code: "EIO" });
    } }, 16);
    const job = await f.manager.start({ workspace_id: "w", command: process.execPath,
      args: ["-e", "process.stdin.on('data', data => { for (const _ of data) process.stdout.write('abcdefghijklmnop'); }); process.stdin.on('end', () => process.stdout.end(() => process.exit(0)));"] });
    try {
      await f.manager.input(job.job_id, "x", false);
      await vi.waitFor(() => expect(appends).toBe(1), { timeout: 10000 });
      await f.manager.flushPersistence();
      expect((await readFile(join(f.stateDir, "jobs", job.job_id, "stdout.log"))).length).toBe(16);
      await f.manager.input(job.job_id, "x", true);
      await vi.waitFor(() => expect(f.manager.get(job.job_id).status).toBe("succeeded"), { timeout: 10000 });
      await f.manager.flushPersistence();
      expect(appends).toBeGreaterThan(0);
      expect(f.manager.get(job.job_id).output_truncated).toBe(true);
      expect((await readFile(join(f.stateDir, "jobs", job.job_id, "stdout.log"))).length).toBeLessThanOrEqual(16);
    } finally {
      if (["running", "cancelling", "queued"].includes(f.manager.get(job.job_id).status)) await f.manager.cancel(job.job_id).catch(() => undefined);
      await f.manager.flushPersistence();
    }
  });

  it("releases an uncertain append reservation when its retained Job is removed", async () => {
    let failed = false;
    const f = await fixture({ ...nativeJobFiles, appendJobLog: async (path, bytes) => {
      await nativeJobFiles.appendJobLog(path, bytes);
      if (!failed) { failed = true; throw Object.assign(new Error("log close failed"), { code: "EIO" }); }
    } }, 16, 1);
    const first = await completed(f.manager, "process.stdout.write('abcdefghijklmnop');");
    expect(f.manager.get(first.job_id).output_truncated).toBe(true);
    const second = await completed(f.manager, "process.stdout.write('abcdefghijklmnop');");
    await expect(readFile(join(f.stateDir, "jobs", first.job_id, "stdout.log"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.manager.get(second.job_id).output_truncated).toBe(false);
    expect(await f.manager.logs(second.job_id)).toMatchObject({ data: "abcdefghijklmnop", source_truncated: false });
  });

  it("uses measured retained bytes after restart instead of counting uncertain reservations twice", async () => {
    const f = await fixture({ ...nativeJobFiles, appendJobLog: async (path, bytes) => {
      await nativeJobFiles.appendJobLog(path, bytes.subarray(0, bytes.length / 2));
      throw Object.assign(new Error("log append failed after progress"), { code: "EIO" });
    } }, 16);
    const first = await completed(f.manager, "process.stdout.write('abcdefghijklmnop');");
    const restarted = new JobManager({ policy: f.policy, stateDir: f.stateDir, maxLogBytesPerJob: 16, maxTotalLogBytes: 16 });
    await restarted.initialize();
    const second = await completed(restarted, "process.stdout.write('qrstuvwx');");
    expect(restarted.get(first.job_id).output_truncated).toBe(true);
    expect(restarted.get(second.job_id).output_truncated).toBe(false);
    expect(await restarted.logs(first.job_id)).toMatchObject({ data: "abcdefgh", source_truncated: true });
    expect(await restarted.logs(second.job_id)).toMatchObject({ data: "qrstuvwx", source_truncated: false });
  });
});
