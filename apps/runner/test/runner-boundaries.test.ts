import * as fs from "node:fs/promises";
import * as syncFs from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { JobLogReader } from "../src/jobs/logs.js";
import { nativeJobFiles } from "../src/jobs/storage.js";
import { nativeJobProcesses, isTerminationTargetValid, linuxProcessStartFingerprintSync } from "../src/jobs/process.js";
import { normalizeJobRecord, occupiesProcessSlot, type JobRecord } from "../src/jobs/records.js";
import { terminalRecoveredJob } from "../src/jobs/recovery.js";
import type { JobLogFilePort, JobLogScope } from "../src/jobs/ports.js";
import { ContextRepository } from "../src/context/repository.js";
import { nativeContextFiles } from "../src/context/files.js";
import type { ContextFilePort } from "../src/context/ports.js";

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), open: vi.fn(actual.open), readFile: vi.fn(actual.readFile) };
});
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
const nativePlatform = process.platform;
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", { value: nativePlatform });
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

it("AR07 the native Job reader rejects a file replaced between inspection and open", async () => {
  const root = await fixture(), path = join(root, "meta.json");
  await fs.writeFile(path, JSON.stringify({ revision: 1 }));
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
    await fs.rename(path, join(root, "prior.json"));
    await fs.writeFile(path, JSON.stringify({ revision: 2 }));
    return actual.open(...args);
  });
  await expect(nativeJobFiles.readJson(path)).rejects.toThrow("job metadata changed");
});

it("AR07 the native Job reader rejects equal-size writes that would splice distinct records", async () => {
  const root = await fixture(), path = join(root, "meta.json");
  const prior = { first: "old", padding: "x".repeat(100_000), last: "old" };
  const next = { ...prior, first: "new", last: "new" };
  await fs.writeFile(path, JSON.stringify(prior));
  // Use a distinct timestamp to make the filesystem observation deterministic
  // even on hosts whose timestamp granularity exceeds this test's duration.
  await fs.utimes(path, new Date(1000), new Date(1000));
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let replaced = false;
  vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
    const handle = await actual.open(...args), read = handle.read.bind(handle);
    handle.read = (async (buffer: Buffer, offset: number, length: number, position: number | null) => {
      const result = await read(buffer, offset, length, position);
      if (!replaced && result.bytesRead > 0) {
        replaced = true;
        await fs.writeFile(path, JSON.stringify(next));
        await fs.utimes(path, new Date(2000), new Date(2000));
      }
      return result;
    }) as typeof handle.read;
    return handle;
  });
  const readAttempt = nativeJobFiles.readJson<typeof prior>(path).then(({ first, last }) => ({ first, last }));
  await expect(readAttempt).rejects.toThrow("job metadata changed");
  expect(replaced).toBe(true);
  expect(JSON.parse(await fs.readFile(path, "utf8"))).toEqual(next);
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

function processStat(state: string, starttime = "123456"): string {
  // Linux permits spaces and parentheses inside comm. The parser must bind
  // state and starttime after its final closing parenthesis.
  return `424242 (synthetic (child) name) ${[state, ...Array<string>(18).fill("0"), starttime, "0"].join(" ")}\n`;
}

it.each(["Z", "X", "x"])("AR07 Linux %s process records are exited even while their PID exists", async state => {
  Object.defineProperty(process, "platform", { value: "linux" });
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  vi.mocked(fs.readFile).mockResolvedValueOnce(processStat(state));
  expect(await nativeJobProcesses.inspectProcess(424242, "123456")).toEqual({ alive: false, fingerprintMatches: true });
  // An unreaped leader still reserves its original PID and starttime. That
  // identity remains usable by an already-started process-group cancellation.
  vi.mocked(syncFs.readFileSync).mockReturnValueOnce(processStat(state));
  expect(isTerminationTargetValid(424242, "123456")).toBe(true);
  vi.mocked(syncFs.readFileSync).mockReturnValueOnce(processStat(state, "654321"));
  expect(isTerminationTargetValid(424242, "123456")).toBe(false);
  expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
});

it.each(["R", "S", "D", "T", "t", "I"])("AR07 Linux %s process records retain their recovery slot", async state => {
  Object.defineProperty(process, "platform", { value: "linux" });
  vi.spyOn(process, "kill").mockReturnValue(true);
  vi.mocked(fs.readFile).mockResolvedValueOnce(processStat(state));
  expect(await nativeJobProcesses.inspectProcess(424242, "123456")).toEqual({ alive: true, fingerprintMatches: true });
  vi.mocked(syncFs.readFileSync).mockReturnValueOnce(processStat(state));
  expect(isTerminationTargetValid(424242, "123456")).toBe(true);
});

it("AR07 Linux recovery preserves PID-reuse evidence and unknown process observations", async () => {
  Object.defineProperty(process, "platform", { value: "linux" });
  vi.spyOn(process, "kill").mockReturnValue(true);
  vi.mocked(fs.readFile).mockResolvedValueOnce(processStat("S", "654321"));
  expect(await nativeJobProcesses.inspectProcess(424242, "123456")).toEqual({ alive: true, fingerprintMatches: false });
  vi.mocked(fs.readFile).mockRejectedValueOnce(Object.assign(new Error("unavailable proc"), { code: "EACCES" }));
  expect(await nativeJobProcesses.inspectProcess(424242, "123456")).toEqual({ alive: true, fingerprintMatches: null });
  vi.mocked(fs.readFile).mockResolvedValueOnce("malformed process stat");
  expect(await nativeJobProcesses.inspectProcess(424242, "123456")).toEqual({ alive: true, fingerprintMatches: null });
  vi.mocked(syncFs.readFileSync).mockReturnValueOnce(processStat("S", "654321"));
  expect(isTerminationTargetValid(424242, "123456")).toBe(false);
});

it.each([
  { fingerprint: "123456", escalates: true },
  { fingerprint: "654321", escalates: false },
])("AR07 recovered cancellation escalates=$escalates after the leader becomes a zombie with fingerprint $fingerprint", async ({ fingerprint, escalates }) => {
  Object.defineProperty(process, "platform", { value: "linux" });
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  vi.useFakeTimers();
  try {
    vi.mocked(syncFs.readFileSync).mockReturnValueOnce(processStat("S"));
    expect(await nativeJobProcesses.terminateProcess(424242, "123456")).toBe(true);
    expect(kill).toHaveBeenCalledWith(-424242, "SIGTERM");
    expect(kill).not.toHaveBeenCalledWith(-424242, "SIGKILL");
    vi.mocked(syncFs.readFileSync).mockReturnValueOnce(processStat("Z", fingerprint));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(kill.mock.calls.filter(([, signal]) => signal === "SIGKILL")).toEqual(escalates ? [[-424242, "SIGKILL"]] : []);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

it.skipIf(nativePlatform !== "linux")("AR07 native recovery recognizes an exited child before its parent reaps it", async () => {
  const root = await fixture(), release = join(root, "release-parent");
  // Block only this synthetic parent's event loop so libuv cannot waitpid the
  // exited child yet. Releasing the parent lets it reap the child normally;
  // the test creates no orphan and needs no external interpreter or compiler.
  const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');
    const child=spawn(process.execPath,['-e',''],{stdio:'ignore'});
    fs.writeSync(1,String(child.pid)+'\\n');
    const gate=new Int32Array(new SharedArrayBuffer(4)),deadline=Date.now()+10000;
    while(!fs.existsSync(process.argv[1])&&Date.now()<deadline)Atomics.wait(gate,0,0,10);`;
  const parent = spawn(process.execPath, ["-e", script, release], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise<number | null>((resolve, reject) => { parent.once("error", reject); parent.once("close", resolve); });
  let output = "";
  parent.stdout.on("data", (data: Buffer) => { output += data.toString(); });
  try {
    await vi.waitFor(() => expect(output).toMatch(/^\d+\n$/), { timeout: 5_000 });
    const pid = Number(output.trim());
    await vi.waitFor(async () => {
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
      expect(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]).toBe("Z");
    }, { timeout: 5_000 });
    expect(process.kill(pid, 0)).toBe(true);
    const fingerprint = linuxProcessStartFingerprintSync(pid);
    expect(fingerprint).toMatch(/^\d+$/);
    expect(await nativeJobProcesses.inspectProcess(pid, fingerprint)).toEqual({ alive: false, fingerprintMatches: true });
    expect(isTerminationTargetValid(pid, fingerprint)).toBe(true);
  } finally {
    await fs.writeFile(release, "release\n");
    expect(await closed).toBe(0);
  }
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
