import { ChildProcess } from "node:child_process";
import { Writable } from "node:stream";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { JobManager } from "../src/jobs.js";
import { PathPolicy } from "../src/path-policy.js";
import { nativeJobProcesses } from "../src/jobs/process.js";

// Exercise the public JobManager API with real Node streams and a process
// adapter. No OS child is started and no private JobManager fields are read.
async function withInput(stdin: Writable, check: (manager: JobManager, id: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runmesh-input-test-")));
  const state = join(root, "state"); await mkdir(state, { mode: 0o700 });
  const child = new ChildProcess(); child.stdin = stdin;
  const manager = new JobManager({ stateDir: state, policy: new PathPolicy([{ workspaceId: "w", rootPath: root, readonly: false, shell: false }]) }, {
    processes: { ...nativeJobProcesses, spawn: (() => child) as typeof nativeJobProcesses.spawn, fingerprintSync: () => null },
  });
  let id: string | undefined;
  try {
    await manager.initialize();
    const job = await manager.start({ workspace_id: "w", command: process.execPath, args: ["-e", ""] }); id = job.job_id;
    expect(job.status).toBe("running");
    await check(manager, id);
  } finally {
    stdin.destroy(); child.exitCode = 0; child.emit("close", 0, null);
    if (id !== undefined) await vi.waitFor(() => expect(manager.get(id!).status).toBe("succeeded"));
    stdin.removeAllListeners();
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}
async function outcome(pending: Promise<unknown>): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending.then(() => "accepted", () => "rejected"), new Promise<string>(resolve => { timer = setTimeout(() => resolve("pending"), 250); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
function listeners(stream: Writable): number[] { return ["error", "close", "drain", "finish"].map(event => stream.listenerCount(event)); }

it("job input releases per-call listeners after repeated backpressure", async () => {
  const stdin = new Writable({ highWaterMark: 1, write(_chunk, _encoding, done) { setImmediate(done); } });
  await withInput(stdin, async (manager, id) => {
    const before = listeners(stdin);
    for (let i = 0; i < 16; i++) await expect(manager.input(id, "x")).resolves.toEqual({ accepted: 1, eof: false });
    expect(listeners(stdin)).toEqual(before);
  });
});

it("job input rejects a silent stream close instead of waiting forever for drain", async () => {
  const stdin = new Writable({ highWaterMark: 1, write() {} });
  await withInput(stdin, async (manager, id) => {
    const pending = manager.input(id, "x");
    setImmediate(() => stdin.destroy());
    expect(await outcome(pending)).toBe("rejected");
    expect(listeners(stdin)).toEqual([0, 0, 0, 0]);
  });
});

it("job input does not acknowledge a buffered write that later fails", async () => {
  const failure = new Error("synthetic stdin write failure");
  const stdin = new Writable({ write(_chunk, _encoding, done) { setImmediate(() => done(failure)); } });
  const errors: Error[] = []; stdin.on("error", error => errors.push(error));
  await withInput(stdin, async (manager, id) => {
    expect(await outcome(manager.input(id, "x"))).toBe("rejected");
    await vi.waitFor(() => expect(errors).toEqual([failure]));
    expect(listeners(stdin)).toEqual([1, 0, 0, 0]);
  });
});

it("job input does not acknowledge an EOF callback error as success", async () => {
  const failure = new Error("synthetic stdin finalization failure");
  const stdin = new Writable({ write(_chunk, _encoding, done) { done(); }, final(done) { setImmediate(() => done(failure)); } });
  const errors: Error[] = []; stdin.on("error", error => errors.push(error));
  await withInput(stdin, async (manager, id) => {
    expect(await outcome(manager.input(id, undefined, true))).toBe("rejected");
    await vi.waitFor(() => expect(errors).toEqual([failure]));
    expect(listeners(stdin)).toEqual([1, 0, 0, 0]);
  });
});

it("job input cleans up an EOF-only success without replaying data", async () => {
  const chunks: string[] = [];
  const stdin = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk.toString()); done(); } });
  await withInput(stdin, async (manager, id) => {
    await expect(manager.input(id, undefined, true)).resolves.toEqual({ accepted: 0, eof: true });
    expect(chunks).toEqual([]); expect(listeners(stdin)).toEqual([0, 0, 0, 0]);
  });
});

it("job input preserves UTF-8 byte counts and sends data before EOF", async () => {
  const chunks: string[] = [];
  const stdin = new Writable({ highWaterMark: 1, write(chunk, _encoding, done) { chunks.push(chunk.toString()); setImmediate(done); }, final(done) { chunks.push("EOF"); done(); } });
  await withInput(stdin, async (manager, id) => {
    await expect(manager.input(id, "你好", true)).resolves.toEqual({ accepted: 6, eof: true });
    expect(chunks).toEqual(["你好", "EOF"]); expect(listeners(stdin)).toEqual([0, 0, 0, 0]);
  });
});

it("job input retains error protection until asynchronous stream destruction completes", async () => {
  const failure = new Error("synthetic delayed stream failure");
  const stdin = new Writable({
    write(_chunk, _encoding, done) { setImmediate(() => done(failure)); },
    destroy(error, done) { setTimeout(() => done(error), 10); },
  });
  await withInput(stdin, async (manager, id) => {
    await expect(manager.input(id, "x")).rejects.toBe(failure);
    expect(manager.get(id).status).toBe("running");
    await vi.waitFor(() => expect(stdin.closed).toBe(true));
    expect(listeners(stdin)).toEqual([0, 0, 0, 0]);
  });
});

it("job input cleans up all observers when a backpressured write fails", async () => {
  const failure = new Error("synthetic backpressure failure");
  const stdin = new Writable({ highWaterMark: 1, write(_chunk, _encoding, done) { setImmediate(() => done(failure)); } });
  await withInput(stdin, async (manager, id) => {
    await expect(manager.input(id, "x")).rejects.toBe(failure);
    await vi.waitFor(() => expect(stdin.closed).toBe(true));
    expect(listeners(stdin)).toEqual([0, 0, 0, 0]);
  });
});
