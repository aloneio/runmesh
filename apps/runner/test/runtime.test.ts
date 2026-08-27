import { mkdir, readFile, rm, symlink, writeFile, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_RUNNER_OPERATION_TIMEOUT_MS } from "@aloneio/runmesh-protocol";
import { describe, expect, it } from "vitest";
import { FilesystemService } from "../src/filesystem.js";
import { JobManager } from "../src/jobs.js";
import { PathPolicy } from "../src/path-policy.js";
import { RunnerRuntime } from "../src/runtime.js";
import type { RunnerConfig, WorkspaceConfig } from "../src/config.js";

async function fixture(): Promise<{ root: string; outside: string; state: string; workspace: WorkspaceConfig; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), "runner-runtime-"));
  const root = join(base, "workspace");
  const outside = join(base, "outside");
  const state = join(base, "state");
  await mkdir(root); await mkdir(outside); await mkdir(state);
  const workspace = { workspaceId: "workspace-1", rootPath: await realpath(root), readonly: false, shell: false };
  return { root, outside, state, workspace, cleanup: () => rm(base, { recursive: true, force: true }) };
}
function policy(workspace: WorkspaceConfig): PathPolicy { return new PathPolicy([workspace]); }
async function waitFor<T>(get: () => T, predicate: (value: T) => boolean, timeout = 5_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = get(); if (predicate(value)) return value; await new Promise((resolve) => setTimeout(resolve, 25)); }
  throw new Error("timed out waiting for process");
}

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

  it("reads only the requested range and bounds recursive search without following symlinks", async () => {
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

  it("records failed commands, accepts stdin, and cancels detached long-running processes", async () => {
    const test = await fixture();
    try {
      const manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state });
      await manager.initialize();
      const failed = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "process.exit(7)"] });
      expect(await waitFor(() => manager.get(failed.job_id), (value) => value.status === "failed")).toMatchObject({ exit_code: 7 });
      const input = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "process.stdin.once('data', d => { process.stdout.write(d); process.exit(0) })"] });
      await manager.input(input.job_id, "hello stdin\n");
      await waitFor(() => manager.get(input.job_id), (value) => value.status === "succeeded");
      await expect(manager.logs(input.job_id, { stream: "stdout", limit: 1024 })).resolves.toMatchObject({ data: "hello stdin\n" });
      const longRunning = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] });
      await manager.cancel(longRunning.job_id);
      expect(await waitFor(() => manager.get(longRunning.job_id), (value) => value.status === "cancelled")).toMatchObject({ exit_code: null });
    } finally { await test.cleanup(); }
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
      await expect(waitFor(() => afterCrash.get(vanished.job_id), (value) => value.status === "interrupted")).resolves.toMatchObject({ status: "interrupted" });
      await first.cancel(alive.job_id);
      await waitFor(() => first.get(alive.job_id), (value) => value.status === "cancelled" || value.status === "failed");
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
