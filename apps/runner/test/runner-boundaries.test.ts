import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { JobLogReader } from "../src/jobs/logs.js";
import { nativeJobFiles } from "../src/jobs/storage.js";
import { nativeJobProcesses } from "../src/jobs/process.js";
import { normalizeJobRecord, occupiesProcessSlot, type JobRecord } from "../src/jobs/records.js";
import { terminalRecoveredJob } from "../src/jobs/recovery.js";
import type { JobLogFilePort, JobLogScope } from "../src/jobs/ports.js";
import { ContextRepository } from "../src/context/repository.js";
import { nativeContextFiles } from "../src/context/files.js";
import type { ContextFilePort } from "../src/context/ports.js";

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })));
});
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "ar07-boundary-")));
  roots.push(root); return root;
}
function record(): JobRecord {
  return { job_id: "job-00000000-0000-4000-8000-000000000001", workspace_id: "w", cwd: ".", command: ["synthetic"], shell: false,
    status: "running", pid: null, process_start_fingerprint: null, recovery_liveness: null, created_at_ms: 1, started_at_ms: 2,
    updated_at_ms: 2, completed_at_ms: null, exit_code: null, signal: null, recovery_note: null, output_truncated: false,
    created_by_client_id: "c", cancellation_delivered_at_ms: null };
}

it("AR07 reader and Context repository construction perform no collaborator access", () => {
  const forbidden = new Proxy({}, { get() { throw new Error("construction must not perform I/O"); } });
  expect(() => new JobLogReader(forbidden as JobLogFilePort, forbidden as JobLogScope)).not.toThrow();
  expect(() => new ContextRepository("synthetic-state", "synthetic-contexts", forbidden as ContextFilePort)).not.toThrow();
});

it("AR07 native Job storage atomically replaces JSON and preserves owner-only metadata", async () => {
  const root = await fixture(), jobs = join(root, "jobs"), path = join(jobs, "meta.json");
  await nativeJobFiles.ensureJobStorageDirectories(root, jobs);
  await nativeJobFiles.atomicJson(path, { revision: 1 });
  expect(await nativeJobFiles.readJson(path)).toEqual({ revision: 1 });
  await nativeJobFiles.atomicJson(path, { revision: 2 });
  expect(await fs.readFile(path, "utf8")).toBe('{"revision":2}\n');
  expect(await fs.readdir(jobs)).toEqual(["meta.json"]);
  if (process.platform !== "win32") expect((await fs.stat(path)).mode & 0o077).toBe(0);
});

it("AR07 failed native Job rename preserves the old record and removes its temporary file", async () => {
  const root = await fixture(), path = join(root, "meta.json");
  await nativeJobFiles.atomicJson(path, { state: "prior" });
  const before = await fs.readFile(path);
  vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error("synthetic storage failure"), { code: "ENOSPC" }));
  await expect(nativeJobFiles.atomicJson(path, { state: "new" })).rejects.toMatchObject({ code: "ENOSPC" });
  expect(await fs.readFile(path)).toEqual(before);
  expect(await fs.readdir(root)).toEqual(["meta.json"]);
});

it("AR07 the native Job reader rejects oversized metadata rather than allocating its full contents", async () => {
  const root = await fixture(), path = join(root, "meta.json"), handle = await fs.open(path, "wx", 0o600);
  try { await handle.truncate(8 * 1024 * 1024 + 1); } finally { await handle.close(); }
  await expect(nativeJobFiles.readJson(path)).rejects.toMatchObject({ code: "EFBIG" });
});

it("AR07 the log reader needs only a log descriptor and path observation, not Job storage", async () => {
  const root = await fixture(), path = join(root, "stdout.log");
  await fs.writeFile(path, "", { mode: 0o600 });
  let opens = 0;
  const reader = new JobLogReader({ lstat: nativeJobFiles.lstat, openJobLog: async (requested, mode) => {
    expect(requested).toBe(path); expect(mode).toBe("read"); opens++; return nativeJobFiles.openJobLog(requested, mode);
  } }, { cursorOwner: "synthetic", jobsDir: root, runnerId: "r", generation: () => 1, assertGeneration: () => {}, logPath: () => path });
  expect(await reader.read(record(), {})).toMatchObject({ data: "", page_state: "end", next_cursor: null, returned_bytes: 0 });
  expect(opens).toBe(1);
  expect(await fs.readdir(root)).toEqual(["stdout.log"]);
});

it.each(["ENOENT", "EACCES", "ELOOP"])("AR07 unavailable log %s is never projected as empty output", async code => {
  const reader = new JobLogReader({ openJobLog: async () => { throw Object.assign(new Error("synthetic private path"), { code }); },
    lstat: (() => { throw new Error("must not stat after open failure"); }) as typeof fs.lstat },
  { cursorOwner: "synthetic", jobsDir: "synthetic", runnerId: "r", generation: () => 1, assertGeneration: () => {}, logPath: () => "synthetic.log" });
  await expect(reader.read(record(), {})).rejects.toMatchObject({ code: "log_unavailable" });
});

it("AR07 process spawn remains synchronous and permits same-turn exit listeners", async () => {
  const child = nativeJobProcesses.spawn(process.execPath, ["-e", "process.exit(7)"], { stdio: "ignore", windowsHide: true });
  try {
    expect(child).not.toBeInstanceOf(Promise);
    const observed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve(code)); });
    expect(await observed).toBe(7);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
});

it("AR07 absent process identity cannot produce a cancellation delivery", async () => {
  const kill = vi.spyOn(process, "kill");
  expect(await nativeJobProcesses.inspectProcess(null, null)).toEqual({ alive: false, fingerprintMatches: null });
  expect(await nativeJobProcesses.terminateProcess(null)).toBe(false);
  expect(await nativeJobProcesses.terminateProcess(-1)).toBe(false);
  expect(kill).not.toHaveBeenCalled();
});

it("AR07 recovered unknown Jobs keep admission occupancy and never invent exit codes", () => {
  const old = { ...record(), status: "unknown" as const, request_id: undefined, request_fingerprint: undefined };
  const normalized = normalizeJobRecord(old, old.job_id)!;
  expect(occupiesProcessSlot(normalized)).toBe(true);
  expect(normalized.request_id).toBeNull();
  const now = vi.spyOn(Date, "now").mockReturnValue(100);
  const terminal = terminalRecoveredJob(normalized, "interrupted", { checked_at_ms: 100, alive: false, fingerprint_matches: null });
  expect(terminal).toMatchObject({ status: "interrupted", exit_code: null, signal: null, completed_at_ms: 100 });
  expect(now).toHaveBeenCalledTimes(2);
  expect(old.status).toBe("unknown");
});

it("AR07 Context pending checkpoints fence index reads without opening record bodies", async () => {
  const read = vi.fn(nativeContextFiles.readJsonBounded);
  const files = { ...nativeContextFiles, pathExists: async () => true, readJsonBounded: read };
  const repository = new ContextRepository("synthetic-state", "synthetic-contexts", files);
  await expect(repository.readIndex("w", true)).rejects.toMatchObject({ code: "context_index_stale" });
  expect(read).not.toHaveBeenCalled();
});

it("AR07 failed Context index publication is returned without another write or retry", async () => {
  const failure = new Error("synthetic index failure");
  const writes = vi.fn(async () => { throw failure; }), mkdir = vi.fn(async () => {});
  const repository = new ContextRepository("synthetic-state", "synthetic-contexts", {
    ...nativeContextFiles, ensurePrivateDirectory: mkdir, atomicReplace: writes,
  });
  await expect(repository.writeIndex({ schema_version: 1, workspace_id: "w", rebuilt_at_ms: null, records: [] })).rejects.toBe(failure);
  expect(mkdir).toHaveBeenCalledTimes(1); expect(writes).toHaveBeenCalledTimes(1);
});

it("AR07 Context pending ownership mismatch never deletes another operation's intent", async () => {
  const remove = vi.fn(nativeContextFiles.rm);
  const repository = new ContextRepository("synthetic-state", "synthetic-contexts", {
    ...nativeContextFiles, rm: remove, readJsonBounded: async () => ({ value: { schema_version: 1, workspace_id: "w", context_id: "different", revision: 2, fingerprint: "a".repeat(64) }, bytes: 100, sha256: "b".repeat(64) }),
  });
  await expect(repository.clearPending({ schema_version: 1, workspace_id: "w", context_id: "expected", revision: 2, fingerprint: "a".repeat(64) })).rejects.toMatchObject({ code: "context_index_stale" });
  expect(remove).not.toHaveBeenCalled();
});
