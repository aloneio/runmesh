import { mkdir, readFile, rm, symlink, writeFile, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { LOCAL_RUNNER_OPERATION_TIMEOUT_MS } from "@aloneio/runmesh-protocol";
import { describe, expect, it, vi } from "vitest";
import { FilesystemService } from "../src/filesystem.js";
import { JobManager, type JobEvent, type JobRecord } from "../src/jobs.js";
import { PathPolicy } from "../src/path-policy.js";
import { validateCentralWorkspacePolicy } from "../src/policy-config.js";
import { discoverShellRuntime, RunnerRuntime } from "../src/runtime.js";
import type { RunnerConfig, WorkspaceConfig } from "../src/config.js";

async function fixture(): Promise<{ root: string; outside: string; state: string; workspace: WorkspaceConfig; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), "runner-runtime-"));
  const root = join(base, "workspace");
  const outside = join(base, "outside");
  const state = join(base, "state");
  await mkdir(root); await mkdir(outside); await mkdir(state);
  const workspace = { workspaceId: "workspace-1", rootPath: await realpath(root), readonly: false, shell: false };
  // Windows can keep a just-exited child process' cwd handle alive for a
  // short interval after its `close` event. Use Node's bounded native retry
  // rather than making every test sleep or weakening its assertions.
  const cleanup = (): Promise<void> => rm(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  return { root, outside, state, workspace, cleanup };
}
function policy(workspace: WorkspaceConfig): PathPolicy { return new PathPolicy([workspace]); }
async function waitFor<T>(get: () => T, predicate: (value: T) => boolean, timeout = 5_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = get(); if (predicate(value)) return value; await new Promise((resolve) => setTimeout(resolve, 25)); }
  throw new Error("timed out waiting for process");
}

describe("shell runtime discovery", () => {
  it("falls back to Windows PowerShell and preserves the command invocation contract", async () => {
    const probes: string[] = [];
    const runtime = await discoverShellRuntime({
      platform: "win32",
      probe: async (command) => {
        probes.push(command);
        return command === "powershell.exe" ? "5.1.22621\r\n" : undefined;
      },
    });
    expect(probes).toEqual(["pwsh.exe", "powershell.exe"]);
    expect(runtime).toMatchObject({ kind: "powershell", executable: "powershell.exe", version: "5.1.22621" });
    expect(runtime?.buildInvocation("Write-Output hello")).toEqual({
      file: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Write-Output hello"],
    });
  });

  it.skipIf(process.platform !== "win32")("executes a discovered PowerShell command through the direct spawn seam", async () => {
    const runtime = await discoverShellRuntime();
    expect(runtime).toBeDefined();
    const invocation = runtime!.buildInvocation("Write-Output runmesh-shell-probe");
    const result = await new Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>((resolve, reject) => {
      const child = spawn(invocation.file, [...invocation.args], { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => { child.kill(); reject(new Error("PowerShell probe timed out")); }, 5_000);
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    expect(result).toMatchObject({ code: 0, stdout: expect.stringContaining("runmesh-shell-probe") });
    expect(result.stderr).toBe("");
  }, 15_000);
});

describe("workspace path policy", () => {
  it("allows only workspace IDs and relative canonical paths for reads, lists, search, cwd, and patches", async () => {
    const test = await fixture();
    try {
      await writeFile(join(test.root, "note.txt"), "needle\nother\n");
      const service = new FilesystemService(policy(test.workspace));
      await expect(service.read({ workspace_id: "workspace-1", path: "../outside/nope" })).rejects.toThrow(/traversal/);
      await expect(service.read({ workspace_id: "workspace-1", path: "/etc/passwd" })).rejects.toThrow(/absolute/);
      await expect(service.read({ workspace_id: "workspace-1", path: "C:\\Windows\\System32" })).rejects.toThrow(/absolute/);
      await expect(service.read({ workspace_id: "workspace-1", path: "note\0txt" })).rejects.toThrow(/NUL/);
      await expect(service.read({ workspace_id: "spoofed-root", path: "note.txt" })).rejects.toThrow(/workspace/);
      await expect(policy(test.workspace).resolve("workspace-1", "../outside", "cwd")).rejects.toThrow(/traversal/);
      await expect(policy(test.workspace).resolve("workspace-1", "/tmp", "write")).rejects.toThrow(/absolute/);
      await expect(service.read({ workspace_id: "workspace-1", path: "note.txt" })).resolves.toMatchObject({ data: "needle\nother\n" });
      await expect(service.list({ workspace_id: "workspace-1", path: "." })).resolves.toMatchObject({ entries: [{ name: "note.txt", type: "file" }] });
      await expect(service.search({ workspace_id: "workspace-1", path: ".", query: "needle" })).resolves.toMatchObject({ results: [{ path: "note.txt", line: 1 }] });
    } finally { await test.cleanup(); }
  });

  it.skipIf(process.platform === "win32")("rejects symlink escape and write-through symlink targets on Linux/Unix", async () => {
    const test = await fixture();
    try {
      await writeFile(join(test.outside, "secret.txt"), "secret");
      await symlink(test.outside, join(test.root, "escape"));
      const securePolicy = policy(test.workspace);
      await expect(securePolicy.resolve("workspace-1", "escape/secret.txt", "read")).rejects.toThrow(/symlink/);
      await expect(securePolicy.resolve("workspace-1", "escape/new.txt", "write")).rejects.toThrow(/symlink/);
    } finally { await test.cleanup(); }
  });

  it.skipIf(process.platform === "win32")("reads only the requested range and bounds recursive search without following symlinks", async () => {
    const test = await fixture();
    try {
      await writeFile(join(test.root, "large.txt"), `${"a".repeat(400_000)}needle`);
      await writeFile(join(test.root, "small.txt"), "one\nneedle\n");
      await mkdir(join(test.root, "node_modules"));
      await writeFile(join(test.root, "node_modules", "ignored.txt"), "needle");
      await symlink(join(test.root, "small.txt"), join(test.root, "small-link.txt"));
      const service = new FilesystemService(policy(test.workspace));
      await expect(service.read({ workspace_id: "workspace-1", path: "large.txt", offset: 399_990, limit: 16 })).resolves.toMatchObject({ size: 400_006, offset: 399_990, data: "aaaaaaaaaaneedle" });
      const search = await service.search({ workspace_id: "workspace-1", path: ".", query: "needle" });
      expect(search).toMatchObject({ results: [{ path: "small.txt", line: 2 }] });
      expect(JSON.stringify(search)).not.toContain("ignored.txt");
      expect(JSON.stringify(search)).not.toContain("small-link.txt");
    } finally { await test.cleanup(); }
  });

  it("stat reports binary files without decoding them and search paginates bounded matches", async () => {
    const test = await fixture();
    try {
      await writeFile(join(test.root, "binary.bin"), Buffer.from([0, 255, 1]));
      await writeFile(join(test.root, "matches.txt"), "needle\nneedle\nneedle\n");
      const service = new FilesystemService(policy(test.workspace));
      await expect(service.stat({ workspace_id: "workspace-1", path: "binary.bin" })).resolves.toMatchObject({ type: "file", binary: true, encoding: "binary", size: 3 });
      const first = await service.search({ workspace_id: "workspace-1", query: "needle", max_results: 2 });
      expect(first).toMatchObject({ results: [{ line: 1 }, { line: 2 }], next_cursor: "2", truncated: true });
      await expect(service.search({ workspace_id: "workspace-1", query: "needle", max_results: 2, cursor: first.next_cursor })).resolves.toMatchObject({ results: [{ line: 3 }], next_cursor: null, truncated: false });
    } finally { await test.cleanup(); }
  });

  it("streams a bounded directory page without materializing every entry", async () => {
    const test = await fixture();
    try {
      await Promise.all(Array.from({ length: 300 }, (_, index) => writeFile(join(test.root, `entry-${String(index).padStart(3, "0")}.txt`), "x")));
      const service = new FilesystemService(policy(test.workspace));
      const first = await service.list({ workspace_id: test.workspace.workspaceId, path: ".", limit: 256 });
      expect(first).toMatchObject({ entries: expect.any(Array), next_cursor: "256", truncated: true });
      expect(first.entries).toHaveLength(256);
      const second = await service.list({ workspace_id: test.workspace.workspaceId, path: ".", cursor: first.next_cursor, limit: 256 });
      expect(second).toMatchObject({ next_cursor: null, truncated: false });
      expect(second.entries).toHaveLength(44);
    } finally { await test.cleanup(); }
  });

  it("rejects canonical central roots that overlap or nest", async () => {
    const test = await fixture();
    try {
      const nested = join(test.root, "nested");
      await mkdir(nested);
      const result = await validateCentralWorkspacePolicy([
        { workspace_id: "parent", root_path: test.root, enabled: true, permissions: { read: true, edit: false, shell: false, job_control: false } },
        { workspace_id: "child", root_path: nested, enabled: true, permissions: { read: true, edit: false, shell: false, job_control: false } },
      ]);
      expect(result.workspaces).toEqual([]);
      expect(result.status).toEqual([
        { workspace_id: "parent", status: "invalid_path" },
        { workspace_id: "child", status: "invalid_path" },
      ]);
    } finally { await test.cleanup(); }
  });

  it("enforces readonly workspace writes and shell policy", async () => {
    const test = await fixture();
    try {
      const readonly = { ...test.workspace, readonly: true };
      const config: RunnerConfig = { server: "ws://127.0.0.1", token: "0123456789abcdef", runnerId: "runner-1", workspaces: [readonly] };
      const runtime = new RunnerRuntime({ config, stateDir: test.state });
      await runtime.initialize();
      await expect(runtime.dispatch("fs.patch", { workspace_id: readonly.workspaceId, path: "new.txt", content: "x" })).rejects.toMatchObject({ code: "readonly_workspace" });
      await expect(runtime.dispatch("exec.start", { workspace_id: readonly.workspaceId, command: "echo", args: ["x"], shell: true })).rejects.toThrow(/shell execution/);
    } finally { await test.cleanup(); }
  });
});

describe("persistent local jobs", () => {
  it("atomically reserves concurrent job capacity across overlapping starts", async () => {
    const test = await fixture();
    try {
      const manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state, maxConcurrentJobs: 1 });
      await manager.initialize();
      const [first, second] = await Promise.allSettled([
        manager.start({ workspace_id: test.workspace.workspaceId, command: process.execPath, args: ["-e", "setTimeout(() => {}, 5000)"] }),
        manager.start({ workspace_id: test.workspace.workspaceId, command: process.execPath, args: ["-e", "setTimeout(() => {}, 5000)"] }),
      ]);
      const fulfilled = [first, second].filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<JobManager["start"]>>> => result.status === "fulfilled");
      const rejected = [first, second].filter((result): result is PromiseRejectedResult => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(String(rejected[0]?.reason)).toContain("max concurrent");
      await manager.cancel(fulfilled[0]?.value.job_id);
    } finally { await test.cleanup(); }
  });
  it("persists metadata, captures paginated logs, and preserves jobs independently of a client", async () => {
    const test = await fixture();
    try {
      const manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state, runnerId: "runner-1" });
      await manager.initialize();
      const job = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(100000))"] });
      const completed = await waitFor(() => manager.get(job.job_id), (value) => value.status === "succeeded");
      expect(completed.exit_code).toBe(0);
      const first = await manager.logs(job.job_id, { stream: "stdout", limit: 1024 });
      expect(first).toMatchObject({ truncated: true, offset: 0 });
      expect(typeof first.next_cursor).toBe("string");
      expect((first.data as string).length).toBeLessThanOrEqual(1024);
      const second = await manager.logs(job.job_id, { stream: "stdout", cursor: first.next_cursor, limit: 1024 });
      expect(second).toMatchObject({ offset: 1024 });
      const saved = JSON.parse(await readFile(join(test.state, "jobs", job.job_id, "meta.json"), "utf8")) as { status: string; command: string[] };
      expect(saved).toMatchObject({ status: "succeeded" });
      expect(saved.command).toEqual([process.execPath, "-e", "process.stdout.write('x'.repeat(100000))"]);
      await expect(readFile(join(test.state, "runner.json"), "utf8")).resolves.toContain("runner-1");
    } finally { await test.cleanup(); }
  });

  it("syncs completed durable job metadata after the process exits", async () => {
    const test = await fixture();
    try {
      const config: RunnerConfig = { server: "ws://127.0.0.1", token: "0123456789abcdef", runnerId: "runner-sync", workspaces: [test.workspace] };
      const runtime = new RunnerRuntime({ config, stateDir: test.state });
      await runtime.initialize();
      const started = await runtime.dispatch("exec.start", { workspace_id: test.workspace.workspaceId, command: process.execPath, args: ["-e", "process.stdout.write('persisted')"], created_by_client_id: "client-a" }) as JobRecord;
      await waitFor(() => runtime.jobs.get(started.job_id), (job) => job.status === "succeeded");
      await expect(runtime.syncJobs()).resolves.toEqual([expect.objectContaining({ job_id: started.job_id, workspace_id: test.workspace.workspaceId, status: "succeeded", runner_id: "runner-sync" })]);
      await expect(readFile(join(test.state, "jobs", started.job_id, "meta.json"), "utf8")).resolves.toContain('"status":"succeeded"');
    } finally { await test.cleanup(); }
  });
  it("persists failed process starts as terminal records and emits them", async () => {
    const test = await fixture();
    const events: JobEvent[] = [];
    try {
      const manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state, onEvent: (event) => events.push(event) });
      await manager.initialize();
      const job = await manager.start({ workspace_id: "workspace-1", command: "definitely-not-an-executable" });
      await waitFor(() => manager.get(job.job_id), (value) => value.status === "failed");
      expect(manager.get(job.job_id)).toMatchObject({ status: "failed", completed_at_ms: expect.any(Number) });
      await waitFor(() => events, (value) => value.some((event) => event.type === "completed" && event.job.job_id === job.job_id));
      expect(events.some((event) => event.type === "completed" && event.job.job_id === job.job_id)).toBe(true);
      await expect(readFile(join(test.state, "jobs", job.job_id, "meta.json"), "utf8")).resolves.toContain('"status":"failed"');
    } finally { await test.cleanup(); }
  });
  it("emits and persists a job completion after a command exits", async () => {
    const test = await fixture();
    const events: JobEvent[] = [];
    try {
      const manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state, onEvent: (event) => events.push(event) });
      await manager.initialize();
      const job = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "process.exit(0)"] });
      await waitFor(() => manager.get(job.job_id), (value) => value.status === "succeeded");
      await waitFor(() => events, (value) => value.some((event) => event.type === "completed" && event.job.job_id === job.job_id));
      expect(events.filter((event) => event.type === "completed" && event.job.job_id === job.job_id)).toHaveLength(1);
      await expect(readFile(join(test.state, "jobs", job.job_id, "meta.json"), "utf8")).resolves.toContain('"status":"succeeded"');
    } finally { await test.cleanup(); }
  });

  it("waits for fast-exit terminal metadata before returning from start", async () => {
    const test = await fixture();
    const events: JobEvent[] = [];
    let releaseRunningWrite!: () => void;
    const runningWriteGate = new Promise<void>((resolve) => { releaseRunningWrite = resolve; });
    let releaseTerminalWrite!: () => void;
    const terminalWriteGate = new Promise<void>((resolve) => { releaseTerminalWrite = resolve; });
    let terminalWriteStarted = false;
    let released = false;
    let startPromise: Promise<JobRecord> | undefined;
    try {
      const manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state, onEvent: (event) => events.push(event) });
      const internals = manager as unknown as { persist: (record: JobRecord) => Promise<void> };
      const originalPersist = internals.persist.bind(manager);
      let targetJobId: string | undefined;
      internals.persist = async (record) => {
        if (targetJobId === undefined && record.status === "queued") targetJobId = record.job_id;
        // Hold the start() running snapshot long enough for the child close
        // callback to prepare a terminal record and enter its own write.
        if (record.job_id === targetJobId && record.status === "running") await runningWriteGate;
        if (record.job_id === targetJobId && ["succeeded", "failed"].includes(record.status)) {
          terminalWriteStarted = true;
          await terminalWriteGate;
        }
        return originalPersist(record);
      };
      await manager.initialize();
      startPromise = manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "process.exit(0)"] });
      await waitFor(() => terminalWriteStarted, Boolean);
      const settled = await Promise.race([
        startPromise.then(() => true, () => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
      ]);
      expect(settled).toBe(false);
      // Terminal publication is behind the metadata durability barrier. While
      // the terminal write is held, the in-memory record must remain active and
      // no completed event may escape to Registry.
      expect(manager.get(targetJobId!).status).toBe("running");
      expect(events.filter((event) => event.job.job_id === targetJobId && event.type === "completed")).toHaveLength(0);
      released = true;
      releaseRunningWrite();
      releaseTerminalWrite();
      const result = await startPromise;
      expect(result.status).toBe("succeeded");
      const persisted = JSON.parse(await readFile(join(test.state, "jobs", result.job_id, "meta.json"), "utf8")) as Record<string, unknown>;
      expect(persisted).toMatchObject({ status: "succeeded" });
    } finally {
      if (!released) {
        releaseRunningWrite();
        releaseTerminalWrite();
      }
      if (startPromise !== undefined) await startPromise.catch(() => undefined);
      await test.cleanup();
    }
  });

  it("does not emit a stale started event when cancellation wins the running write", async () => {
    const test = await fixture();
    const events: JobEvent[] = [];
    let manager: JobManager | undefined;
    let job: JobRecord | undefined;
    try {
      manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state, onEvent: (event) => events.push(event) });
      const internals = manager as unknown as {
        readonly jobs: Map<string, JobRecord>;
        readonly processes: Map<string, ChildProcess>;
        persist: (record: JobRecord) => Promise<void>;
      };
      const originalPersist = internals.persist.bind(manager);
      let mutated = false;
      internals.persist = async (record) => {
        const result = await originalPersist(record);
        // Model a cancellation callback that commits between the running
        // metadata write and start()'s event publication. The post-write
        // status guard must suppress a stale `started` event.
        if (!mutated && record.status === "running") {
          mutated = true;
          const current = internals.jobs.get(record.job_id)!;
          internals.jobs.set(record.job_id, { ...current, status: "cancelling", updated_at_ms: Date.now() });
        }
        return result;
      };
      await manager.initialize();
      job = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "setInterval(() => {}, 10000)"] });
      expect(job.status).toBe("cancelling");
      expect(events.filter((event) => event.job.job_id === job!.job_id && event.type === "started")).toHaveLength(0);
      const child = internals.processes.get(job.job_id);
      child?.kill();
      await waitFor(() => manager!.get(job!.job_id), (value) => !["queued", "running", "cancelling"].includes(value.status));
    } finally {
      if (manager !== undefined && job !== undefined) {
        const child = (manager as unknown as { readonly processes: Map<string, ChildProcess> }).processes.get(job.job_id);
        if (child !== undefined && child.exitCode === null && child.signalCode === null) {
          const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
          child.kill();
          await closed;
        }
      }
      await test.cleanup();
    }
  });

  it("releases the queued reservation when initial job persistence fails", async () => {
    const test = await fixture();
    try {
      const manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state });
      await manager.initialize();
      const internals = manager as unknown as {
        readonly jobs: Map<string, JobRecord>;
        persist: (record: JobRecord) => Promise<void>;
      };
      const originalPersist = internals.persist.bind(manager);
      let failQueued = true;
      internals.persist = async (record) => {
        if (failQueued && record.status === "queued") {
          failQueued = false;
          throw new Error("synthetic metadata write failure");
        }
        return originalPersist(record);
      };
      await expect(manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "process.exit(0)"] })).rejects.toThrow("synthetic metadata write failure");
      expect(internals.jobs.size).toBe(0);
      internals.persist = originalPersist;
      const restarted = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "process.exit(0)"] });
      // Child startup/close is asynchronous on Windows; assert the same
      // successful terminal outcome without requiring start() to race the
      // process exit synchronously.
      await expect(waitFor(() => manager.get(restarted.job_id), (value) => value.status === "succeeded")).resolves.toMatchObject({ status: "succeeded" });
    } finally { await test.cleanup(); }
  });

  it("releases the queued reservation when creating the job directory fails", async () => {
    const test = await fixture();
    try {
      const manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state });
      await manager.initialize();
      const blocker = join(test.state, "job-directory-blocker");
      await writeFile(blocker, "not a directory");
      const blockedPath = join(blocker, "job");
      const internals = manager as unknown as {
        readonly jobs: Map<string, JobRecord>;
        jobDir: (jobId: string) => string;
      };
      const originalJobDir = internals.jobDir.bind(manager);
      internals.jobDir = () => blockedPath;
      await expect(manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "process.exit(0)"] })).rejects.toMatchObject({ code: expect.stringMatching(/ENOTDIR|EEXIST|EPERM/) });
      internals.jobDir = originalJobDir;
      expect(internals.jobs.size).toBe(0);
      await expect(readFile(blocker, "utf8")).resolves.toBe("not a directory");
    } finally { await test.cleanup(); }
  });

  it("continues child state convergence when log descriptor cleanup fails", async () => {
    const test = await fixture();
    let manager: JobManager | undefined;
    let job: JobRecord | undefined;
    try {
      manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state });
      const internals = manager as unknown as {
        closeLogHandles: (...args: unknown[]) => Promise<void>;
        readonly processes: Map<string, ChildProcess>;
      };
      await manager.initialize();
      const originalClose = internals.closeLogHandles.bind(manager);
      // Close the real handles first, then report a synthetic failure. This
      // exercises the best-effort error path without leaving descriptors for
      // the test runner's garbage collector to reclaim.
      internals.closeLogHandles = async (...args) => { await originalClose(...args); throw new Error("synthetic descriptor close failure"); };
      job = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "setInterval(() => {}, 10000)"] });
      internals.closeLogHandles = originalClose;
      expect(job.status).toBe("running");
      const child = internals.processes.get(job.job_id);
      expect(child).toBeDefined();
      const closed = new Promise<void>((resolve) => child!.once("close", () => resolve()));
      child!.kill();
      await closed;
      await expect(waitFor(() => manager!.get(job!.job_id), (value) => !["queued", "running", "cancelling"].includes(value.status))).resolves.toMatchObject({ status: expect.any(String) });
    } finally {
      if (manager !== undefined && job !== undefined) {
        const child = (manager as unknown as { readonly processes: Map<string, ChildProcess> }).processes.get(job.job_id);
        if (child !== undefined && child.exitCode === null && child.signalCode === null) {
          const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
          child.kill();
          await closed;
        }
      }
      await test.cleanup();
    }
  });

  it("does not spawn a queued job that was cancelled while start was persisting", async () => {
    const test = await fixture();
    let releaseQueuedWrite!: () => void;
    const queuedWriteGate = new Promise<void>((resolve) => { releaseQueuedWrite = resolve; });
    let targetJobId: string | undefined;
    let startPromise: Promise<JobRecord> | undefined;
    let cancelPromise: Promise<JobRecord> | undefined;
    let manager: JobManager | undefined;
    try {
      manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state });
      const internals = manager as unknown as {
        persist: (record: JobRecord) => Promise<void>;
        readonly processes: Map<string, ChildProcess>;
      };
      const originalPersist = internals.persist.bind(manager);
      internals.persist = async (record) => {
        if (record.status === "queued" && targetJobId === undefined) {
          targetJobId = record.job_id;
          // Register the real per-job persistence chain before holding the
          // start caller. This models a slow await after persist() has queued
          // its write, without allowing the synthetic gate to reorder writes.
          const write = originalPersist(record);
          await queuedWriteGate;
          return write;
        }
        return originalPersist(record);
      };
      await manager.initialize();
      startPromise = manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "setInterval(() => {}, 10000)"] });
      await waitFor(() => targetJobId, (value) => value !== undefined);
      cancelPromise = manager.cancel(targetJobId!);
      await waitFor(() => manager!.get(targetJobId!), (value) => value.status === "cancelled");
      // Release the queued metadata write only after cancellation has published
      // its terminal in memory; the pre-spawn check must observe that state.
      releaseQueuedWrite();
      await expect(cancelPromise).resolves.toMatchObject({ status: "cancelled" });
      await expect(startPromise).resolves.toMatchObject({ status: "cancelled" });
      expect(internals.processes.has(targetJobId!)).toBe(false);
      const persisted = JSON.parse(await readFile(join(test.state, "jobs", targetJobId!, "meta.json"), "utf8")) as Record<string, unknown>;
      expect(persisted).toMatchObject({ status: "cancelled" });
    } finally {
      releaseQueuedWrite();
      if (cancelPromise !== undefined) await cancelPromise.catch(() => undefined);
      if (startPromise !== undefined) await startPromise.catch(() => undefined);
      if (manager !== undefined && targetJobId !== undefined) {
        const child = (manager as unknown as { readonly processes: Map<string, ChildProcess> }).processes.get(targetJobId);
        if (child !== undefined && child.exitCode === null && child.signalCode === null) {
          const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
          child.kill();
          await closed;
        }
      }
      await test.cleanup();
    }
  });

  it("preserves a queued cancellation when opening the child logs fails", async () => {
    const test = await fixture();
    let releaseQueuedWrite!: () => void;
    const queuedWriteGate = new Promise<void>((resolve) => { releaseQueuedWrite = resolve; });
    let targetJobId: string | undefined;
    let startPromise: Promise<JobRecord> | undefined;
    let cancelPromise: Promise<JobRecord> | undefined;
    let manager: JobManager | undefined;
    try {
      manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state });
      const internals = manager as unknown as { persist: (record: JobRecord) => Promise<void>; readonly processes: Map<string, ChildProcess> };
      const originalPersist = internals.persist.bind(manager);
      internals.persist = async (record) => {
        if (record.status === "queued" && targetJobId === undefined) {
          targetJobId = record.job_id;
          const write = originalPersist(record);
          await queuedWriteGate;
          return write;
        }
        return originalPersist(record);
      };
      await manager.initialize();
      startPromise = manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "setInterval(() => {}, 10000)"] });
      await waitFor(() => targetJobId, (value) => value !== undefined);
      cancelPromise = manager.cancel(targetJobId!);
      await waitFor(() => manager!.get(targetJobId!), (value) => value.status === "cancelled");
      // Force the second log open to reject after cancellation has published
      // its in-memory terminal state. The catch path must preserve cancelled,
      // not rebuild a stale failed record from the original queued snapshot.
      await mkdir(join(test.state, "jobs", targetJobId!, "stderr.log"));
      releaseQueuedWrite();
      await expect(cancelPromise).resolves.toMatchObject({ status: "cancelled" });
      await expect(startPromise).resolves.toMatchObject({ status: "cancelled" });
      expect(internals.processes.has(targetJobId!)).toBe(false);
      const persisted = JSON.parse(await readFile(join(test.state, "jobs", targetJobId!, "meta.json"), "utf8")) as Record<string, unknown>;
      expect(persisted).toMatchObject({ status: "cancelled" });
    } finally {
      releaseQueuedWrite();
      if (cancelPromise !== undefined) await cancelPromise.catch(() => undefined);
      if (startPromise !== undefined) await startPromise.catch(() => undefined);
      if (manager !== undefined && targetJobId !== undefined) {
        const child = (manager as unknown as { readonly processes: Map<string, ChildProcess> }).processes.get(targetJobId);
        if (child !== undefined && child.exitCode === null && child.signalCode === null) {
          const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
          child.kill();
          await closed;
        }
      }
      await test.cleanup();
    }
  });

  it("records failed commands, accepts stdin, and cancels detached long-running processes", async () => {
    const test = await fixture();
    try {
      const manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state });
      await manager.initialize();
      const job = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "process.exit(7)"] });
      expect(await waitFor(() => manager.get(job.job_id), (value) => value.status === "failed")).toMatchObject({ exit_code: 7 });
      const input = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "process.stdin.once('data', d => { process.stdout.write(d); process.exit(0) })"] });
      await manager.input(input.job_id, "hello stdin\n");
      await waitFor(() => manager.get(input.job_id), (value) => value.status === "succeeded");
      await expect(manager.logs(input.job_id, { stream: "stdout", limit: 1024 })).resolves.toMatchObject({ data: "hello stdin\n" });
      const longRunning = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] });
      await manager.cancel(longRunning.job_id);
      expect(await waitFor(() => manager.get(longRunning.job_id), (value) => value.status === "cancelled")).toMatchObject({ exit_code: null });
    } finally { await test.cleanup(); }
  });

  it("does not signal a local PID after the child exits during cancellation persistence", async () => {
    const test = await fixture();
    try {
      let terminateCalls = 0;
      const manager = new JobManager({
        policy: policy(test.workspace),
        stateDir: test.state,
        terminateProcess: async () => { terminateCalls += 1; return true; },
      });
      await manager.initialize();
      const job = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] });
      const internals = manager as unknown as {
        readonly processes: Map<string, { readonly kill: () => boolean }>;
        persist: (record: JobRecord) => Promise<void>;
      };
      const child = internals.processes.get(job.job_id);
      expect(child).toBeDefined();
      const originalPersist = internals.persist.bind(manager);
      let killed = false;
      internals.persist = async (record) => {
        if (!killed && record.job_id === job.job_id && record.status === "cancelling") {
          killed = true;
          child?.kill();
          // Let the close handler commit before the post-persist target check.
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return originalPersist(record);
      };
      const result = await manager.cancel(job.job_id);
      expect(terminateCalls).toBe(0);
      expect(["succeeded", "failed", "interrupted"]).toContain(result.status);
      expect(["succeeded", "failed", "interrupted"]).toContain(manager.get(job.job_id).status);
    } finally { await test.cleanup(); }
  });

  it("fails promptly when process-tree termination is not delivered", async () => {
    const test = await fixture();
    try {
      const manager = new JobManager({
        policy: policy(test.workspace),
        stateDir: test.state,
        terminateProcess: async () => false,
      });
      await manager.initialize();
      const job = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] });
      const internals = manager as unknown as { readonly processes: Map<string, { readonly kill: () => boolean }> };
      const child = internals.processes.get(job.job_id);
      expect(child).toBeDefined();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await expect(Promise.race([
          manager.cancel(job.job_id),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("cancel timed out")), 1_500); }),
        ])).rejects.toThrow("process termination was not delivered");
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      expect(manager.get(job.job_id).status).toBe("running");
      child?.kill();
      await waitFor(() => manager.get(job.job_id), (value) => !["queued", "running", "cancelling"].includes(value.status));
    } finally { await test.cleanup(); }
  });

  it("persists cancellation delivery evidence when close races the terminator decision", async () => {
    const test = await fixture();
    let child: ChildProcess | undefined;
    try {
      const manager = new JobManager({
        policy: policy(test.workspace),
        stateDir: test.state,
        terminateProcess: async () => {
          // Model a platform terminator that causes the child close callback
          // before its own delivery promise settles. This ordering is possible
          // for taskkill/process-group signals and must retain durable evidence.
          child?.emit("close", null, "SIGTERM");
          return true;
        },
      });
      await manager.initialize();
      const job = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] });
      const internals = manager as unknown as { readonly processes: Map<string, ChildProcess> };
      child = internals.processes.get(job.job_id);
      expect(child).toBeDefined();
      const result = await manager.cancel(job.job_id);
      expect(result.status).toBe("cancelled");
      expect(result.cancellation_delivered_at_ms).toEqual(expect.any(Number));
      const persisted = JSON.parse(await readFile(join(test.state, "jobs", job.job_id, "meta.json"), "utf8")) as Record<string, unknown>;
      expect(persisted).toMatchObject({ status: "cancelled", cancellation_delivered_at_ms: expect.any(Number) });
    } finally {
      // The synthetic close event does not terminate the actual child.
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>((resolve) => child?.once("close", () => resolve()));
        child.kill();
        await closed;
      }
      await test.cleanup();
    }
  });

  it("does not resurrect a terminal record while completion logs are flushing", async () => {
    const test = await fixture();
    try {
      const manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state });
      await manager.initialize();
      const job = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] });
      const internals = manager as unknown as {
        readonly jobs: Map<string, JobRecord>;
        readonly processes: Map<string, ChildProcess>;
        flushLogs: (jobId: string) => Promise<void>;
        persist: (record: JobRecord) => Promise<void>;
      };
      const originalFlushLogs = internals.flushLogs.bind(manager);
      let injected = false;
      internals.flushLogs = async (jobId) => {
        if (!injected && jobId === job.job_id) {
          injected = true;
          const current = internals.jobs.get(jobId)!;
          const terminal: JobRecord = {
            ...current,
            status: "interrupted",
            updated_at_ms: Date.now(),
            completed_at_ms: Date.now(),
            exit_code: null,
            signal: null,
            recovery_liveness: { checked_at_ms: Date.now(), alive: false, fingerprint_matches: false },
            recovery_note: "synthetic terminalization during log flush",
          };
          internals.jobs.set(jobId, terminal);
          internals.processes.delete(jobId);
          await internals.persist(terminal);
        }
        await originalFlushLogs(jobId);
      };
      const child = internals.processes.get(job.job_id);
      expect(child).toBeDefined();
      child!.kill();
      await expect(waitFor(() => manager.get(job.job_id), (value) => value.status === "interrupted")).resolves.toMatchObject({ status: "interrupted" });
      const persisted = JSON.parse(await readFile(join(test.state, "jobs", job.job_id, "meta.json"), "utf8")) as Record<string, unknown>;
      expect(persisted).toMatchObject({ status: "interrupted", recovery_note: "synthetic terminalization during log flush" });
    } finally { await test.cleanup(); }
  });

  it("waits for a cancellation registered during log flush before finalizing", async () => {
    const test = await fixture();
    let releaseFlush!: () => void;
    const flushGate = new Promise<void>((resolve) => { releaseFlush = resolve; });
    let flushStarted!: () => void;
    const flushStartedSignal = new Promise<void>((resolve) => { flushStarted = resolve; });
    let child: ChildProcess | undefined;
    let finishPromise: Promise<void> | undefined;
    let cancelPromise: Promise<JobRecord> | undefined;
    try {
      const manager = new JobManager({
        policy: policy(test.workspace),
        stateDir: test.state,
        terminateProcess: async () => {
          child?.kill();
          return true;
        },
      });
      await manager.initialize();
      const internals = manager as unknown as {
        readonly processes: Map<string, ChildProcess>;
        finish: (jobId: string, code: number | null, signal: NodeJS.Signals | null, spawnFailed: boolean) => Promise<void>;
        flushLogs: (jobId: string) => Promise<void>;
      };
      const job = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "setInterval(() => {}, 10000)"] });
      child = internals.processes.get(job.job_id);
      expect(child).toBeDefined();
      const originalFlushLogs = internals.flushLogs.bind(manager);
      let blocked = false;
      internals.flushLogs = async (jobId) => {
        if (!blocked && jobId === job.job_id) {
          blocked = true;
          flushStarted();
          await flushGate;
        }
        await originalFlushLogs(jobId);
      };
      // Model the close callback beginning completion just before cancellation
      // gets to its process-tree decision. The real child is then terminated by
      // the injected seam, and both paths must converge on one durable result.
      finishPromise = internals.finish(job.job_id, 143, "SIGTERM", false);
      await flushStartedSignal;
      cancelPromise = manager.cancel(job.job_id);
      await waitFor(() => manager.get(job.job_id), (value) => value.status === "cancelling");
      releaseFlush();
      await expect(cancelPromise).resolves.toMatchObject({ status: "cancelled", cancellation_delivered_at_ms: expect.any(Number) });
      await finishPromise;
      const persisted = JSON.parse(await readFile(join(test.state, "jobs", job.job_id, "meta.json"), "utf8")) as Record<string, unknown>;
      expect(persisted).toMatchObject({ status: "cancelled", cancellation_delivered_at_ms: expect.any(Number) });
    } finally {
      releaseFlush();
      if (cancelPromise !== undefined) await cancelPromise.catch(() => undefined);
      if (finishPromise !== undefined) await finishPromise.catch(() => undefined);
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>((resolve) => child?.once("close", () => resolve()));
        child.kill();
        await closed;
      }
      await test.cleanup();
    }
  });

  it("handles ENOENT and fast exits, UTF-8 cursors, EOF, completion log availability, and concurrency", async () => {
    const test = await fixture();
    try {
      const manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state });
      await manager.initialize();
      const missing = await manager.start({ workspace_id: "workspace-1", command: "definitely-not-an-executable" });
      await waitFor(() => manager.get(missing.job_id), (value) => value.status === "failed");
      const fast = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "process.stdout.write('😀é')"] });
      await waitFor(() => manager.get(fast.job_id), (value) => value.status === "succeeded");
      const first = await manager.logs(fast.job_id, { stream: "stdout", limit: 4 });
      expect(first).toMatchObject({ data: "😀", next_cursor: "4", truncated: true });
      const second = await manager.logs(fast.job_id, { stream: "stdout", cursor: first.next_cursor, limit: 4 });
      expect(second).toMatchObject({ data: "é", offset: 4, next_cursor: null });
      const stdin = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('eof'))"] });
      await expect(manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "setTimeout(() => {}, 1000)"] })).rejects.toThrow(/max concurrent/);
      await expect(manager.input(stdin.job_id, undefined, true)).resolves.toMatchObject({ accepted: 0, eof: true });
      await waitFor(() => manager.get(stdin.job_id), (value) => value.status === "succeeded");
      await expect(manager.logs(stdin.job_id, { stream: "stdout" })).resolves.toMatchObject({ data: "eof" });
    } finally { await test.cleanup(); }
  });

  it.skipIf(process.platform === "win32")("cancels a POSIX detached descendant process group", async () => {
    const test = await fixture();
    try {
      const manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state });
      await manager.initialize();
      const job = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'}); setInterval(()=>{},1000)"] });
      await manager.cancel(job.job_id);
      await expect(waitFor(() => manager.get(job.job_id), (value) => value.status === "cancelled")).resolves.toMatchObject({ signal: "SIGTERM" });
    } finally { await test.cleanup(); }
  });

  it.skipIf(process.platform === "win32")("does not escalate a process group after the original leader exits", async () => {
    const test = await fixture();
    vi.useFakeTimers();
    const kill = vi.spyOn(process, "kill");
    let manager: JobManager | undefined;
    let job: JobRecord | undefined;
    try {
      manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state });
      await manager.initialize();
      job = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "setInterval(() => {}, 10000)"] });
      await expect(manager.cancel(job.job_id)).resolves.toMatchObject({ status: "cancelled" });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(kill.mock.calls.filter(([, signal]) => signal === "SIGKILL")).toHaveLength(0);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
      if (manager !== undefined && job !== undefined) await manager.cancel(job.job_id).catch(() => undefined);
      await test.cleanup();
    }
  });

  it.skipIf(process.platform !== "win32")("fails closed for a recovered Windows PID without its ChildProcess handle", async () => {
    const test = await fixture();
    let child: ChildProcess | undefined;
    try {
      const manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state });
      await manager.initialize();
      const internals = manager as unknown as {
        terminate: (pid: number | null, expectedFingerprint?: string | null, expectedChild?: ChildProcess) => Promise<boolean>;
      };
      child = spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"], { stdio: "ignore", windowsHide: true });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await expect(internals.terminate(child.pid ?? null, null)).resolves.toBe(false);
      // The child is deliberately omitted from the call: a recovered record
      // has no handle, so native Windows termination must not taskkill this
      // potentially reused PID.
      expect(child.exitCode).toBeNull();
    } finally {
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>((resolve) => child?.once("close", () => resolve()));
        child.kill();
        await closed;
      }
      await test.cleanup();
    }
  });

  it("counts recovered unknown processes against the concurrency limit", async () => {
    const test = await fixture();
    let first: JobManager | undefined;
    let job: JobRecord | undefined;
    try {
      first = new JobManager({ policy: policy(test.workspace), stateDir: test.state, maxConcurrentJobs: 1 });
      await first.initialize();
      job = await first.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "setInterval(() => {}, 10000)"] });
      const restarted = new JobManager({ policy: policy(test.workspace), stateDir: test.state, maxConcurrentJobs: 1 });
      await restarted.initialize();
      expect(restarted.get(job.job_id).status).toBe("unknown");
      await expect(restarted.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "process.exit(0)"] })).rejects.toThrow(/max concurrent/);
      // A second restart must inspect the already-persisted `unknown` state;
      // otherwise it would remain unknown forever and leak the slot.
      const restartedAgain = new JobManager({ policy: policy(test.workspace), stateDir: test.state, maxConcurrentJobs: 1 });
      await restartedAgain.initialize();
      expect(restartedAgain.get(job.job_id).status).toBe("unknown");
    } finally {
      if (first !== undefined && job !== undefined) {
        await first.cancel(job.job_id).catch(() => undefined);
        await waitFor(() => first!.get(job!.job_id), (value) => !["queued", "running", "cancelling"].includes(value.status), 10_000).catch(() => undefined);
      }
      await test.cleanup();
    }
  });

  it.skipIf(process.platform === "win32")("does not resurrect a recovered terminal record after an identity probe yields", async () => {
    const test = await fixture();
    let first: JobManager | undefined;
    let job: JobRecord | undefined;
    let restoreKill: (() => void) | undefined;
    try {
      first = new JobManager({ policy: policy(test.workspace), stateDir: test.state, maxConcurrentJobs: 1 });
      await first.initialize();
      job = await first.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "setInterval(() => {}, 10000)"] });
      const restarted = new JobManager({ policy: policy(test.workspace), stateDir: test.state, maxConcurrentJobs: 1 });
      await restarted.initialize();
      const internals = restarted as unknown as {
        readonly jobs: Map<string, JobRecord>;
        cancelRecoveredUnknown: (record: JobRecord) => Promise<JobRecord>;
      };
      const stale = internals.jobs.get(job.job_id)!;
      expect(stale.status).toBe("unknown");
      const originalKill = process.kill.bind(process);
      let mutated = false;
      const kill = vi.spyOn(process, "kill");
      restoreKill = () => kill.mockRestore();
      kill.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
        if (!mutated && pid === job!.pid && signal === 0) {
          mutated = true;
          const current = internals.jobs.get(job!.job_id)!;
          internals.jobs.set(job!.job_id, {
            ...current,
            status: "interrupted",
            updated_at_ms: Date.now(),
            completed_at_ms: Date.now(),
            recovery_liveness: { checked_at_ms: Date.now(), alive: false, fingerprint_matches: false },
          });
          const error = Object.assign(new Error("process disappeared"), { code: "ESRCH" });
          throw error;
        }
        return originalKill(pid, signal as NodeJS.Signals);
      }) as typeof process.kill);
      await expect(internals.cancelRecoveredUnknown(stale)).resolves.toMatchObject({ status: "interrupted" });
      expect(internals.jobs.get(job.job_id)?.status).toBe("interrupted");
    } finally {
      restoreKill?.();
      if (first !== undefined && job !== undefined) {
        await first.cancel(job.job_id).catch(() => undefined);
        await waitFor(() => first!.get(job!.job_id), (value) => !["queued", "running", "cancelling"].includes(value.status), 10_000).catch(() => undefined);
      }
      await test.cleanup();
    }
  });

  it.skipIf(process.platform === "win32")("preserves recovered cancellation delivery evidence after a stale liveness probe", async () => {
    const test = await fixture();
    let first: JobManager | undefined;
    let job: JobRecord | undefined;
    let restoreKill: (() => void) | undefined;
    try {
      first = new JobManager({ policy: policy(test.workspace), stateDir: test.state, maxConcurrentJobs: 1 });
      await first.initialize();
      job = await first.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "setInterval(() => {}, 10000)"] });
      const restarted = new JobManager({ policy: policy(test.workspace), stateDir: test.state, maxConcurrentJobs: 1 });
      await restarted.initialize();
      const internals = restarted as unknown as {
        readonly jobs: Map<string, JobRecord>;
        cancelRecoveredUnknown: (record: JobRecord) => Promise<JobRecord>;
      };
      const stale = internals.jobs.get(job.job_id)!;
      expect(stale.status).toBe("unknown");
      const originalKill = process.kill.bind(process);
      const kill = vi.spyOn(process, "kill");
      restoreKill = () => kill.mockRestore();
      let probes = 0;
      kill.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
        if (pid === job!.pid && signal === 0) {
          probes += 1;
          // The first probe validates the recovered snapshot. During the
          // second (post-persist) probe, model a concurrent cancellation path
          // recording delivery before the process disappears.
          if (probes === 2) {
            const current = internals.jobs.get(job!.job_id)!;
            internals.jobs.set(job!.job_id, {
              ...current,
              cancellation_delivered_at_ms: Date.now(),
              updated_at_ms: Date.now(),
            });
            const error = Object.assign(new Error("process disappeared"), { code: "ESRCH" });
            throw error;
          }
        }
        return originalKill(pid, signal as NodeJS.Signals);
      }) as typeof process.kill);
      await expect(internals.cancelRecoveredUnknown(stale)).resolves.toMatchObject({ status: "cancelled", cancellation_delivered_at_ms: expect.any(Number) });
      expect(internals.jobs.get(job.job_id)).toMatchObject({ status: "cancelled", cancellation_delivered_at_ms: expect.any(Number) });
    } finally {
      restoreKill?.();
      if (first !== undefined && job !== undefined) {
        await first.cancel(job.job_id).catch(() => undefined);
        await waitFor(() => first!.get(job!.job_id), (value) => !["queued", "running", "cancelling"].includes(value.status), 10_000).catch(() => undefined);
      }
      await test.cleanup();
    }
  });

  it.skipIf(process.platform !== "linux")("deduplicates concurrent recovered cancellation signals", async () => {
    const test = await fixture();
    let first: JobManager | undefined;
    let job: JobRecord | undefined;
    let releaseTermination!: () => void;
    const terminationGate = new Promise<void>((resolve) => { releaseTermination = resolve; });
    let terminationCalls = 0;
    let cancelA: Promise<JobRecord> | undefined;
    let cancelB: Promise<JobRecord> | undefined;
    try {
      first = new JobManager({ policy: policy(test.workspace), stateDir: test.state, maxConcurrentJobs: 1 });
      await first.initialize();
      job = await first.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "setInterval(() => {}, 10000)"] });
      const restarted = new JobManager({
        policy: policy(test.workspace),
        stateDir: test.state,
        maxConcurrentJobs: 1,
        terminateProcess: async () => {
          terminationCalls += 1;
          await terminationGate;
          return true;
        },
      });
      await restarted.initialize();
      const internals = restarted as unknown as {
        readonly jobs: Map<string, JobRecord>;
        cancelRecoveredUnknown: (record: JobRecord) => Promise<JobRecord>;
      };
      const stale = internals.jobs.get(job.job_id)!;
      expect(stale.status).toBe("unknown");
      cancelA = internals.cancelRecoveredUnknown(stale);
      cancelB = internals.cancelRecoveredUnknown(stale);
      await waitFor(() => terminationCalls, (value) => value === 1);
      releaseTermination();
      await expect(Promise.all([cancelA, cancelB])).resolves.toEqual([
        expect.objectContaining({ status: "cancelling", cancellation_delivered_at_ms: expect.any(Number) }),
        expect.objectContaining({ status: "cancelling", cancellation_delivered_at_ms: expect.any(Number) }),
      ]);
      expect(terminationCalls).toBe(1);
    } finally {
      releaseTermination();
      if (cancelA !== undefined) await cancelA.catch(() => undefined);
      if (cancelB !== undefined) await cancelB.catch(() => undefined);
      if (first !== undefined && job !== undefined) {
        await first.cancel(job.job_id).catch(() => undefined);
        await waitFor(() => first!.get(job!.job_id), (value) => !["queued", "running", "cancelling"].includes(value.status), 10_000).catch(() => undefined);
      }
      await test.cleanup();
    }
  });

  it("does not overwrite a newer recovered state after a liveness probe", async () => {
    const test = await fixture();
    let first: JobManager | undefined;
    let job: JobRecord | undefined;
    let restoreKill: (() => void) | undefined;
    try {
      first = new JobManager({ policy: policy(test.workspace), stateDir: test.state, maxConcurrentJobs: 1 });
      await first.initialize();
      job = await first.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "setInterval(() => {}, 10000)"] });
      const restarted = new JobManager({ policy: policy(test.workspace), stateDir: test.state, maxConcurrentJobs: 1 });
      await restarted.initialize();
      const internals = restarted as unknown as {
        readonly jobs: Map<string, JobRecord>;
        reconcileRecoveredJob: (jobId: string) => Promise<void>;
      };
      const stale = internals.jobs.get(job.job_id)!;
      expect(stale.status).toBe("unknown");
      const originalKill = process.kill.bind(process);
      const kill = vi.spyOn(process, "kill");
      restoreKill = () => kill.mockRestore();
      let mutated = false;
      kill.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
        if (!mutated && pid === job!.pid && signal === 0) {
          mutated = true;
          const current = internals.jobs.get(job!.job_id)!;
          internals.jobs.set(job!.job_id, {
            ...current,
            status: "interrupted",
            updated_at_ms: Date.now(),
            completed_at_ms: Date.now(),
            recovery_note: "newer recovered state",
            recovery_liveness: { checked_at_ms: Date.now(), alive: false, fingerprint_matches: false },
          });
          const error = Object.assign(new Error("process disappeared"), { code: "ESRCH" });
          throw error;
        }
        return originalKill(pid, signal as NodeJS.Signals);
      }) as typeof process.kill);
      await internals.reconcileRecoveredJob(job.job_id);
      expect(internals.jobs.get(job.job_id)).toMatchObject({ status: "interrupted", recovery_note: "newer recovered state" });
    } finally {
      restoreKill?.();
      if (first !== undefined && job !== undefined) {
        await first.cancel(job.job_id).catch(() => undefined);
        await waitFor(() => first!.get(job!.job_id), (value) => !["queued", "running", "cancelling"].includes(value.status), 10_000).catch(() => undefined);
      }
      await test.cleanup();
    }
  });

  it("marks jobs found alive after restart unknown and vanished processes interrupted", async () => {
    const test = await fixture();
    try {
      const first = new JobManager({ policy: policy(test.workspace), stateDir: test.state, maxConcurrentJobs: 2, maxRetainedJobs: 100 });
      await first.initialize();
      const alive = await first.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "setTimeout(() => {}, 1500)"] });
      const restarted = new JobManager({ policy: policy(test.workspace), stateDir: test.state });
      await restarted.initialize();
      expect(restarted.get(alive.job_id).status).toBe("unknown");
      const vanished = await first.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "setTimeout(() => {}, 10)"] });
      await waitFor(() => first.get(vanished.job_id), (value) => value.status === "succeeded");
      const metaPath = join(test.state, "jobs", vanished.job_id, "meta.json");
      const meta = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
      meta.status = "running"; meta.pid = 999_999_999; meta.completed_at_ms = null;
      await writeFile(metaPath, JSON.stringify(meta));
      const afterCrash = new JobManager({ policy: policy(test.workspace), stateDir: test.state, maxRetainedJobs: 100 });
      await afterCrash.initialize();
      await expect(waitFor(() => afterCrash.get(vanished.job_id), (value) => value.status === "interrupted", 10_000)).resolves.toMatchObject({ status: "interrupted" });
      await first.cancel(alive.job_id);
      await waitFor(() => first.get(alive.job_id), (value) => value.status === "cancelled" || value.status === "failed");
    } finally { await test.cleanup(); }
  });

  it("ignores log data delivered after terminalization and retention pruning", async () => {
    const test = await fixture();
    try {
      const manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state, maxRetainedJobs: 2 });
      await manager.initialize();
      const first = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "process.stdout.write('before')"] });
      await waitFor(() => manager.get(first.job_id), (value) => value.status === "succeeded");
      const internals = manager as unknown as {
        queueLogAppend: (jobId: string, stream: "stdout" | "stderr", chunk: Buffer) => void;
        readonly logWriteChain: Promise<void>;
        readonly jobs: Map<string, JobRecord>;
      };
      const before = await manager.logs(first.job_id, { stream: "stdout", limit: 1024 });
      internals.queueLogAppend(first.job_id, "stdout", Buffer.from("late"));
      await internals.logWriteChain;
      await manager.flushPersistence();
      const after = await manager.logs(first.job_id, { stream: "stdout", limit: 1024 });
      expect(after).toMatchObject({ data: before.data, size: before.size });

      const second = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "process.exit(0)"] });
      await waitFor(() => manager.get(second.job_id), (value) => value.status === "succeeded");
      const third = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "process.exit(0)"] });
      await waitFor(() => manager.get(third.job_id), (value) => value.status === "succeeded");
      expect(internals.jobs.has(first.job_id)).toBe(false);
      internals.queueLogAppend(first.job_id, "stdout", Buffer.from("after-prune"));
      await manager.flushPersistence();
      await expect(readFile(join(test.state, "jobs", first.job_id, "meta.json"), "utf8")).rejects.toThrow();
    } finally { await test.cleanup(); }
  });

  it("accepts a legal near-limit exec.run and rejects values above the shared local cap", async () => {
    const test = await fixture();
    try {
      const config: RunnerConfig = { server: "ws://127.0.0.1", token: "0123456789abcdef", runnerId: "runner-1", workspaces: [test.workspace] };
      const runtime = new RunnerRuntime({ config, stateDir: test.state });
      await runtime.initialize();
      const legal = await runtime.dispatch("exec.run", { workspace_id: "workspace-1", command: process.execPath, args: ["-e", "process.stdout.write('ok')"], wait_ms: LOCAL_RUNNER_OPERATION_TIMEOUT_MS - 100 });
      expect(legal).toMatchObject({ completed: true, job: { status: "succeeded" } });
      await expect(runtime.dispatch("exec.run", { workspace_id: "workspace-1", command: process.execPath, args: ["-e", "process.exit(0)"], wait_ms: LOCAL_RUNNER_OPERATION_TIMEOUT_MS + 1 })).rejects.toMatchObject({ code: "invalid_params" });
    } finally { await test.cleanup(); }
  });

  it("pages mixed UTF-8 filesystem reads with byte cursors without replacement characters", async () => {
    const test = await fixture();
    try {
      const original = "Hello你好😀éWorld";
      await writeFile(join(test.root, "utf8.txt"), original, "utf8");
      const service = new FilesystemService(policy(test.workspace));
      let cursor: string | undefined;
      let result = "";
      do {
        const page = await service.read({ workspace_id: "workspace-1", path: "utf8.txt", ...(cursor === undefined ? {} : { cursor }), limit: 4 });
        result += page.data as string;
        cursor = typeof page.next_cursor === "string" ? page.next_cursor : undefined;
      } while (cursor !== undefined);
      expect(result).toBe(original);
      expect(result).not.toContain("\ufffd");
      const middle = await service.read({ workspace_id: "workspace-1", path: "utf8.txt", offset: Buffer.byteLength("Hello你", "utf8") + 1, limit: 4 });
      expect(middle.data).not.toContain("\ufffd");
      expect(middle.offset).toBeGreaterThan(Buffer.byteLength("Hello你", "utf8"));
    } finally { await test.cleanup(); }
  });

  it("caps persisted job output and retires only terminal jobs", async () => {
    const test = await fixture();
    try {
      const manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state, maxConcurrentJobs: 2, maxRetainedJobs: 2, maxLogBytesPerJob: 64, maxTotalLogBytes: 128 });
      await manager.initialize();
      const noisy = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(1024))"] });
      const completed = await waitFor(() => manager.get(noisy.job_id), (job) => job.status === "succeeded");
      expect(completed.output_truncated).toBe(true);
      expect(await manager.logs(noisy.job_id, { stream: "stdout", limit: 128 })).toMatchObject({ data: "x".repeat(64), size: 64 });
      const first = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "process.exit(0)"] });
      await waitFor(() => manager.get(first.job_id), (job) => job.status === "succeeded");
      const second = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "process.exit(0)"] });
      await waitFor(() => manager.get(second.job_id), (job) => job.status === "succeeded");
      expect(manager.list({ limit: 10 })).toHaveLength(2);
      expect(() => manager.get(noisy.job_id)).toThrow("job not found");
    } finally { await test.cleanup(); }
  });

  it("keeps active jobs when the retained-job quota is exhausted", async () => {
    const test = await fixture();
    try {
      const manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state, maxRetainedJobs: 1, maxConcurrentJobs: 1 });
      await manager.initialize();
      const job = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "setTimeout(() => {}, 2000)"] });
      await expect(manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "process.exit(0)"] })).rejects.toThrow(/max retained jobs/);
      await manager.cancel(job.job_id);
      await expect(waitFor(() => manager.get(job.job_id), (value) => !["queued", "running", "cancelling"].includes(value.status))).resolves.toMatchObject({ status: "cancelled" });
    } finally { await test.cleanup(); }
  });

  it("lists bounded filtered job metadata and reconciles recovered jobs", async () => {
    const test = await fixture();
    try {
      const manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state, maxConcurrentJobs: 3 });
      await manager.initialize();
      const first = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "process.exit(0)"] });
      const second = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "process.exit(1)"] });
      await waitFor(() => manager.get(first.job_id), (job) => job.status === "succeeded");
      await waitFor(() => manager.get(second.job_id), (job) => job.status === "failed");
      expect(await manager.listReconciled({ status: "succeeded", limit: 1 })).toMatchObject([{ job_id: first.job_id, status: "succeeded" }]);
      expect(manager.list({ limit: 1 })).toHaveLength(1);
      const metaPath = join(test.state, "jobs", first.job_id, "meta.json");
      const meta = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
      meta.status = "unknown"; meta.pid = 999_999_999; meta.completed_at_ms = null; meta.exit_code = null;
      await writeFile(metaPath, JSON.stringify(meta));
      const recovered = new JobManager({ policy: policy(test.workspace), stateDir: test.state });
      await recovered.initialize();
      expect(await recovered.getReconciled(first.job_id)).toMatchObject({ status: "interrupted", exit_code: null });
    } finally { await test.cleanup(); }
  });

  it("caches bounded parallel environment discovery without leaking environment values", async () => {
    const test = await fixture();
    try {
      let calls = 0;
      const config: RunnerConfig = { server: "ws://127.0.0.1", token: "0123456789abcdef", runnerId: "runner-1", workspaces: [test.workspace] };
      const runtimeModule = await import("../src/runtime.js");
      const runtime = new RunnerRuntime({ config, stateDir: test.state, environment: new runtimeModule.EnvironmentInfoService({ probe: async (command) => { calls += 1; return command === "docker" ? undefined : `${command} version`; } }) });
      const [first, second] = await Promise.all([runtime.envInfo(), runtime.envInfo()]);
      expect(first).toEqual(second);
      expect(first).toMatchObject({ platform: process.platform, architecture: process.arch, tools: { docker: { available: false }, git: { available: true, version: "git version" } } });
      expect(JSON.stringify(first)).not.toContain("PATH=");
      expect(calls).toBe(8);
    } finally { await test.cleanup(); }
  });
});
