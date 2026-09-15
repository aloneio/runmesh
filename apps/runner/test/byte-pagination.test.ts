import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm, realpath, stat, utimes, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { PathPolicy } from "../src/path-policy.js";
import { FilesystemService } from "../src/filesystem.js";
import { JobManager } from "../src/jobs.js";
import { RunnerRuntime } from "../src/runtime.js";
import { readPageBytes } from "../src/page-read.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "byte-pagination-")); roots.push(root);
  await mkdir(join(root, "workspace"));
  const workspace = { workspaceId: "w", rootPath: await realpath(join(root, "workspace")), readonly: false, shell: true };
  const policy = new PathPolicy([workspace]);
  return { root, workspace, policy, files: new FilesystemService(policy), stateDir: join(root, "state") };
}
async function completedJob() {
  const f = await fixture();
  const manager = new JobManager({ policy: f.policy, stateDir: f.stateDir });
  await manager.initialize();
  const job = await manager.start({ workspace_id: "w", command: process.execPath, args: ["-e", ""] });
  await vi.waitFor(() => expect(manager.get(job.job_id).status).toBe("succeeded"), { timeout: 10000 });
  await manager.flushPersistence();
  return { ...f, manager, job, log: join(f.stateDir, "jobs", job.job_id, "stdout.log") };
}

it("R07 incomplete file tails terminate pagination without pretending all bytes were delivered", async () => {
  const f = await fixture(); await writeFile(join(f.workspace.rootPath, "partial.txt"), Buffer.from([0x6f, 0x6b, 0xe4, 0xb8]));
  const first = await f.files.read({ workspace_id: "w", path: "partial.txt", limit: 1024 });
  expect(first).toMatchObject({ data: "ok", next_cursor: "2" });
  const last = await f.files.read({ workspace_id: "w", path: "partial.txt", cursor: first.next_cursor, limit: 1024 });
  expect(last).toMatchObject({ data: "", next_cursor: null, truncated: true, page_state: "incomplete", resume_offset: 2, pending_bytes: 2, truncated_reason: "incomplete_utf8" });
  expect(first).toMatchObject({ returned_bytes: 2, total_bytes: 4 });
});

it("R07 file reads refuse a changed observation rather than returning mixed-version content", async () => {
  const f = await fixture(), path = join(f.workspace.rootPath, "changing.txt");
  await writeFile(path, "before"); const before = await stat(path);
  const original = f.policy.verifySnapshot.bind(f.policy);
  vi.spyOn(f.policy, "verifySnapshot").mockImplementationOnce(async (resolved, snapshot) => {
    await original(resolved, snapshot); await writeFile(path, "after!");
    await utimes(path, before.atime, new Date(before.mtimeMs + 2000));
  });
  await expect(f.files.read({ workspace_id: "w", path: "changing.txt" })).rejects.toMatchObject({ code: "file_changed" });
});

it.each(["missing", "non_regular"])("R07 %s completed logs cannot be returned as a successful empty page", async kind => {
  const f = await completedJob(); await rm(f.log);
  if (kind === "non_regular") await mkdir(f.log);
  await expect(f.manager.logs(f.job.job_id)).rejects.toMatchObject({ code: "log_unavailable", details: { reason: kind === "missing" ? "missing" : "unsafe_path" } });
});

it("R07 an actually empty log is distinct from an unavailable log", async () => {
  const f = await completedJob();
  expect(await f.manager.logs(f.job.job_id)).toMatchObject({ data: "", size: 0, total_bytes: 0, returned_bytes: 0, next_cursor: null, page_state: "end", pending_bytes: 0, resume_offset: 0 });
});

it("R07 an incomplete log code point can be resumed after a later append without dropping bytes", async () => {
  const f = await completedJob(); await writeFile(f.log, Buffer.from([0x6f, 0x6b, 0xe4, 0xb8]));
  const first = await f.manager.logs(f.job.job_id, { limit: 1024 });
  const partial = await f.manager.logs(f.job.job_id, { cursor: first.next_cursor, limit: 1024 });
  expect(partial).toMatchObject({ data: "", page_state: "incomplete", next_cursor: null, resume_offset: 2, pending_bytes: 2 });
  await appendFile(f.log, Buffer.from([0xad]));
  expect(await f.manager.logs(f.job.job_id, { offset: partial.resume_offset, limit: 4 })).toMatchObject({ data: "中", next_cursor: null, resume_offset: 5, returned_bytes: 3 });
});

it("R07 file page budgets count decoded UTF-8 while preserving the serialized response limit", async () => {
  const f = await fixture(); await writeFile(join(f.workspace.rootPath, "escaped.txt"), "\0😀中\r\n".repeat(10000));
  const page = await f.files.read({ workspace_id: "w", path: "escaped.txt", limit: 262144 });
  expect(page.returned_bytes).toBe(Buffer.byteLength(String(page.data), "utf8"));
  expect(page).toMatchObject({ page_state: "more", truncated: true, truncated_reason: "response_bytes", snapshot_id: null });
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(48 * 1024);
  expect(Number(page.next_cursor)).toBeGreaterThan(Number(page.offset));
});

it("R07 a completed execution retains its real Job result when log retrieval fails", async () => {
  const f = await fixture();
  const runtime = new RunnerRuntime({ config: { server: "ws://127.0.0.1", runnerId: "fixture", token: "fixture-not-a-credential", workspaces: [f.workspace] }, stateDir: f.stateDir });
  await runtime.jobs.initialize();
  vi.spyOn(runtime.jobs, "logs").mockRejectedValue(new Error("EACCES /private/secret.log"));
  const result = await runtime.dispatch("exec.run", { workspace_id: "w", command: process.execPath, args: ["-e", "process.exit(7)"], wait_ms: 4000 }) as any;
  expect(result).toMatchObject({ completed: true, job: { status: "failed", exit_code: 7 }, stdout: { available: false, error: { code: "log_unavailable" } }, stderr: { available: false } });
  expect(JSON.stringify(result)).not.toContain("secret.log");
  await runtime.jobs.flushPersistence();
});

it("R07 page readers tolerate short OS reads and bound internal read attempts", async () => {
  const read = vi.fn(async (buffer: Buffer, offset: number) => { buffer[offset] = 65; return { bytesRead: 1, buffer }; });
  const handle = { read } as unknown as FileHandle;
  expect((await readPageBytes(handle, 5, 4, "file_changed")).toString()).toBe("AAAA");
  expect(read.mock.calls.map(call => call[1])).toEqual([0, 1, 2, 3]);
  read.mockClear();
  await expect(readPageBytes(handle, 0, 100, "file_changed")).rejects.toMatchObject({ code: "read_budget_exhausted" });
  expect(read).toHaveBeenCalledTimes(32);
  read.mockImplementationOnce(async buffer => ({ bytesRead: 0, buffer }));
  await expect(readPageBytes(handle, 0, 4, "log_changed")).rejects.toMatchObject({ code: "log_changed" });
});

it("R07 escaped logs reserve serialized space for Worker metadata and keep an advancing cursor", async () => {
  const f = await completedJob(); await writeFile(f.log, "\0中😀\r\n".repeat(12000));
  const result = await f.manager.logs(f.job.job_id, { limit: 65536 });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(48 * 1024);
  expect(result).toMatchObject({ page_state: "more", truncated_reason: "response_bytes" });
  expect(result.returned_bytes).toBe(Buffer.byteLength(String(result.data)));
  expect(Number(result.next_cursor)).toBeGreaterThan(Number(result.offset));
});

it("R07 repeated file reads leave files unchanged apart from OS atime", async () => {
  const f = await fixture(), path = join(f.workspace.rootPath, "read-only.txt");
  await writeFile(path, "中😀\r\n"); const before = await stat(path); const original = await readFile(path);
  for (let i = 0; i < 25; i++) expect(await f.files.read({ workspace_id: "w", path: "read-only.txt", limit: 4 })).toMatchObject({ data: "中", returned_bytes: 3, total_bytes: 9 });
  expect(await readFile(path)).toEqual(original); const after = await stat(path);
  expect([after.size, after.mtimeMs, after.ctimeMs]).toEqual([before.size, before.mtimeMs, before.ctimeMs]);
  await expect(stat(f.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
});
