import { nativeJobFiles } from "../src/jobs/storage.js";
import { createJobProcessProbe } from "./helpers/job-process-probe.js";
import { createJobFileFaults } from "./helpers/job-file-faults.js";
import { nativeJobProcesses } from "../src/jobs/process.js";
import { lstat, mkdir, readFile, rm, symlink, writeFile, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { LOCAL_RUNNER_OPERATION_TIMEOUT_MS } from "@aloneio/runmesh-protocol";
import { describe, expect, it, vi } from "vitest";
import { FilesystemService } from "../src/filesystem.js";
import { JobManager, type JobEvent, type JobRecord } from "../src/jobs.js";
import { PathPolicy } from "../src/path-policy.js";
import { validateCentralWorkspacePolicy } from "../src/policy-config.js";
import { RunnerRuntime, rpcError } from "../src/runtime.js";
import { discoverShellRuntime } from "../src/environment.js";
import type { RunnerConfig, WorkspaceConfig } from "../src/config.js";

async function fixture(): Promise<{ root: string; outside: string; state: string; workspace: WorkspaceConfig; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), "runner-runtime-"));
  const root = join(base, "workspace");
  const outside = join(base, "outside");
  const state = join(base, "state");
  // Positive fixtures must not rely on the invoking user's umask. Runtime
  // state correctly rejects group/other-writable directories.
  await mkdir(root); await mkdir(outside); await mkdir(state, { mode: 0o700 });
  const workspace = { workspaceId: "workspace-1", rootPath: await realpath(root), readonly: false, shell: false };
  const cleanup = async (): Promise<void> => {
    // Windows can keep a just-closed child cwd handle for a short interval.
    // Retry only the transient sharing violation so test cleanup never masks
    // the assertion that actually failed.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rm(base, { recursive: true, force: true });
        return;
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? (error as { readonly code?: unknown }).code : undefined;
        if (process.platform !== "win32" || !["EBUSY", "EPERM"].includes(String(code)) || attempt >= 20) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  };
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
    if (runtime === undefined) return;
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

  it.each([
    ["three-byte first byte", Buffer.from("a".repeat(4095) + "中" + "tail"), false],
    ["three-byte second byte", Buffer.from("a".repeat(4094) + "中" + "tail"), false],
    ["four-byte first byte", Buffer.from("a".repeat(4095) + "😀" + "tail"), false],
    ["four-byte second byte", Buffer.from("a".repeat(4094) + "😀" + "tail"), false],
    ["four-byte third byte", Buffer.from("a".repeat(4093) + "😀" + "tail"), false],
    ["complete short text", Buffer.from("中文😀"), false],
    ["incomplete short file", Buffer.from([0xe4, 0xb8]), true],
    ["incomplete complete sample", Buffer.concat([Buffer.from("a".repeat(4095)), Buffer.from([0xe4])]), true],
    ["invalid interior byte", Buffer.concat([Buffer.from("a".repeat(1000)), Buffer.from([0xff]), Buffer.from("a".repeat(5000))]), true],
  ] as const)("classifies UTF-8 stat samples at the %s boundary", async (_name, content, binary) => {
    const test = await fixture();
    try {
      await writeFile(join(test.root, "sample.txt"), content);
      await expect(new FilesystemService(policy(test.workspace)).stat({ workspace_id: test.workspace.workspaceId, path: "sample.txt" }))
        .resolves.toMatchObject({ binary, encoding: binary ? "binary" : "utf-8", size: content.length });
    } finally { await test.cleanup(); }
  });

  it("searches large filenames without reading their contents", async () => {
    const test = await fixture();
    try {
      await writeFile(join(test.root, "large-needle.txt"), "needle" + "a".repeat(256 * 1024));
      await writeFile(join(test.root, "small-needle.txt"), "needle");
      const filesystem = new FilesystemService(policy(test.workspace));
      const result = await filesystem.search({ workspace_id: test.workspace.workspaceId, mode: "filename", query: "needle" });
      expect(result).toMatchObject({ truncated: false, scanned: { bytes: 0, files: 2 } });
      expect(result.results).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "large-needle.txt" }), expect.objectContaining({ path: "small-needle.txt" }),
      ]));
      await expect(filesystem.search({ workspace_id: test.workspace.workspaceId, query: "needle" }))
        .resolves.toMatchObject({ results: [{ path: "small-needle.txt" }] });
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

  it("rejects directory cursors outside the bounded scan window", async () => {
    const test = await fixture();
    try {
      const service = new FilesystemService(policy(test.workspace));
      await expect(service.list({ workspace_id: test.workspace.workspaceId, path: ".", cursor: 100_001 })).rejects.toThrow(/invalid pagination value/);
      await expect(service.list({ workspace_id: test.workspace.workspaceId, path: ".", cursor: "100001" })).rejects.toThrow(/invalid pagination value/);
    } finally { await test.cleanup(); }
  });

  it.each([
    ["fs.read", { path: "sample.txt", limit: 0 }],
    ["fs.list", { path: ".", cursor: "100001" }],
    ["fs.search", { query: "needle", context_before: -1 }],
  ] as const)("classifies invalid %s pagination as a correctable request", async (method, params) => {
    const test = await fixture();
    try {
      await writeFile(join(test.root, "sample.txt"), "needle\n");
      const config: RunnerConfig = { server: "ws://127.0.0.1", token: "0123456789abcdef", runnerId: "runner-1", workspaces: [test.workspace] };
      const runtime = new RunnerRuntime({ config, stateDir: test.state });
      await expect(runtime.dispatch(method, { workspace_id: test.workspace.workspaceId, ...params }).catch(rpcError)).resolves.toMatchObject({
        code: "invalid_params", failure_class: "validation", operation_state: "not_started", next_action: "correct_request",
      });
    } finally { await test.cleanup(); }
  });

  it("classifies malformed direct filesystem input at the service boundary", async () => {
    const service = new FilesystemService(new PathPolicy([]));
    await expect(service.search(null).catch(rpcError)).resolves.toMatchObject({
      code: "invalid_params", failure_class: "validation", operation_state: "not_started", next_action: "correct_request",
    });
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
      // Even before native shell discovery, the same policy must deny this.
      await expect(runtime.dispatch("exec.start", { workspace_id: readonly.workspaceId, command: "echo", args: ["x"], shell: true })).rejects.toMatchObject({ code: "permission_denied" });
      await runtime.initialize();
      await expect(runtime.dispatch("exec.start", { workspace_id: readonly.workspaceId, command: "echo", args: ["x"], shell: true })).rejects.toThrow(/shell execution/);
    } finally { await test.cleanup(); }
  });
});

describe("persistent local jobs", () => {
  it("uses two product execution slots by default and reports effective scheduler capacity", async () => {
    const test = await fixture();
    let first: JobRecord | undefined;
    let second: JobRecord | undefined;
    let runtime: RunnerRuntime | undefined;
    try {
      const config: RunnerConfig = { server: "ws://127.0.0.1", token: "0123456789abcdef", runnerId: "runner-1", workspaces: [test.workspace] };
      runtime = new RunnerRuntime({ config, stateDir: test.state });
      await runtime.initialize();
      first = await runtime.dispatch("exec.start", { workspace_id: test.workspace.workspaceId, command: process.execPath, args: ["-e", "setTimeout(() => {}, 5000)"] }) as JobRecord;
      second = await runtime.dispatch("exec.start", { workspace_id: test.workspace.workspaceId, command: process.execPath, args: ["-e", "setTimeout(() => {}, 5000)"] }) as JobRecord;
      expect(first.status).toBe("running");
      expect(second.status).toBe("running");
      expect(runtime.jobs.queueStatus()).toMatchObject({ running: 2, waiting: 0, max_concurrent_jobs: 2, available_slots: 0 });
      await expect(runtime.envInfo()).resolves.toMatchObject({
        runtime_capabilities: { max_concurrent_jobs: 2 },
        job_scheduler: { running: 2, waiting: 0, max_concurrent_jobs: 2, available_slots: 0 },
      });
    } finally {
      // The runtime owns the live ChildProcess handles; cancel through that same
      // supervisor rather than constructing a second manager over persisted state.
      if (runtime !== undefined) {
        for (const job of [first, second]) if (job !== undefined) await runtime.jobs.cancel(job.job_id).catch(() => undefined);
      }
      await test.cleanup();
    }
  });
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
  it("deduplicates an explicit request_id and rejects conflicting reuse", async () => {
    const test = await fixture();
    try {
      const manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state, maxConcurrentJobs: 1 });
      await manager.initialize();
      const input = { workspace_id: test.workspace.workspaceId, command: process.execPath, args: ["-e", "setTimeout(() => {}, 5000)"], created_by_client_id: "client-a", request_id: "request-a" };
      const first = await manager.start(input);
      const repeated = await manager.start(input);
      expect(repeated.job_id).toBe(first.job_id);
      expect(repeated.request_id).toBe("request-a");
      await expect(manager.start({ ...input, args: ["-e", "process.exit(0)"] })).rejects.toMatchObject({ code: "request_id_conflict" });
      await manager.cancel(first.job_id);
      await waitFor(() => manager.get(first.job_id), (job) => !["queued", "running", "cancelling"].includes(job.status));
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

  it("advances the log cursor to EOF when a log ends with an incomplete UTF-8 sequence", async () => {
    const test = await fixture();
    try {
      const manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state });
      await manager.initialize();
      // "ok" followed by the first two bytes of a three-byte code point. The
      // tail can never be decoded, so a byte-cursor reader that echoed the same
      // cursor back would poll this job forever instead of reaching EOF.
      const job = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "process.stdout.write(Buffer.from([0x6f, 0x6b, 0xe4, 0xb8]))"] });
      await waitFor(() => manager.get(job.job_id), (value) => value.status === "succeeded");
      let cursor: string | null = "0";
      let collected = "";
      let pages = 0;
      while (cursor !== null) {
        const page = await manager.logs(job.job_id, { stream: "stdout", cursor, limit: 1024 });
        collected += page.data as string;
        pages += 1;
        // A stalled cursor would spin here until this bound tripped.
        expect(pages).toBeLessThan(8);
        const next = page.next_cursor as string | null;
        if (next !== null) expect(Number(next)).toBeGreaterThan(Number(cursor));
        cursor = next;
      }
      expect(collected).toBe("ok");
      expect(pages).toBe(2);
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

  it("filters public job lists by current readable workspaces before the result limit", async () => {
    const test = await fixture();
    try {
      const removedRoot = join(test.root, "removed"); await mkdir(removedRoot);
      const denied = { ...test.workspace, workspaceId: "denied", rootPath: test.outside };
      const removed = { ...test.workspace, workspaceId: "removed", rootPath: removedRoot };
      const runtime = new RunnerRuntime({ stateDir: test.state, config: {
        server: "ws://127.0.0.1", token: "0123456789abcdef", runnerId: "runner-list", workspaces: [test.workspace, denied, removed],
      } });
      await runtime.jobs.initialize();
      const created: JobRecord[] = [];
      for (const workspace of [test.workspace, denied, removed]) {
        const job = await runtime.dispatch("exec.start", { workspace_id: workspace.workspaceId, command: [process.execPath, "-e", "process.exit(0)"] }) as JobRecord;
        await waitFor(() => runtime.jobs.get(job.job_id), current => current.status === "succeeded");
        created.push(job);
      }
      runtime.applyPolicy([test.workspace, { ...denied, readonly: true, permissions: { read: false, edit: false, shell: false, job_control: false } }]);
      await expect(runtime.dispatch("job.list", { limit: 1 })).resolves.toMatchObject([{ job_id: created[0]!.job_id }]);
      await expect(runtime.dispatch("job.list", {})).resolves.toHaveLength(1);
      await expect(runtime.dispatch("job.list", { workspace_id: "denied" })).rejects.toMatchObject({ code: "permission_denied" });
      await expect(runtime.dispatch("job.list", { workspace_id: "removed" })).rejects.toThrow();
      // Internal history reconciliation still retains all durable Jobs.
      await expect(runtime.syncJobs(500)).resolves.toHaveLength(3);
      // Match job.get's existing workspace-ID semantics after a root update.
      runtime.applyPolicy([{ ...test.workspace, rootPath: test.outside }]);
      await expect(runtime.dispatch("job.get", { expected_workspace_id: test.workspace.workspaceId, job_id: created[0]!.job_id })).resolves.toMatchObject({ job_id: created[0]!.job_id });
      await expect(runtime.dispatch("job.list", { limit: 1 })).resolves.toMatchObject([{ job_id: created[0]!.job_id }]);
      runtime.applyPolicy([]);
      await expect(runtime.dispatch("job.list", {})).resolves.toEqual([]);
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
      let targetJobId: string | undefined;
      const manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state, onEvent: (event) => events.push(event) }, { persistence: { write: async (record, enqueue) => {
        if (targetJobId === undefined && record.status === "queued") targetJobId = record.job_id;
        // Hold the start() running snapshot long enough for the child close
        // callback to prepare a terminal record and enter its own write.
        if (record.job_id === targetJobId && record.status === "running") await runningWriteGate;
        if (record.job_id === targetJobId && ["succeeded", "failed"].includes(record.status)) {
          terminalWriteStarted = true;
          await terminalWriteGate;
        }
        return enqueue();
      } } });
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

  it("does not let a late running metadata write overwrite terminal state", async () => {
    const test = await fixture();
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    let releaseTerminal!: () => void;
    const terminalGate = new Promise<void>((resolve) => { releaseTerminal = resolve; });
    let terminalWriteStarted = false;
    let runningWriteQueued = false;
    let startPromise: Promise<JobRecord> | undefined;
    try {
      let targetJobId: string | undefined;
      const manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state }, { files: { ...nativeJobFiles, openJobLog: async (path, mode) => {
        const handle = await nativeJobFiles.openJobLog(path, mode);
        if (mode === "append") { const close = handle.close.bind(handle); handle.close = async () => { await closeGate; await close(); }; }
        return handle;
      } }, persistence: { write: async (record, enqueue) => {
        if (targetJobId === undefined && record.status === "queued") targetJobId = record.job_id;
        if (record.job_id === targetJobId && record.status === "succeeded") {
          // Let the terminal metadata callback complete, then hold finishOnce
          // before it publishes the in-memory terminal record. This is the
          // ordering window in which start() can queue its stale running copy.
          await enqueue();
          terminalWriteStarted = true;
          await terminalGate;
          return;
        }
        if (record.job_id === targetJobId && record.status === "running") runningWriteQueued = true;
        return enqueue();
      } } });
      await manager.initialize();
      startPromise = manager.start({ workspace_id: test.workspace.workspaceId, command: process.execPath, args: ["-e", "process.exit(0)"] });
      await waitFor(() => terminalWriteStarted, Boolean);
      // The child has terminalized while start() is still blocked closing its
      // descriptors. Its late running persistence must be suppressed.
      releaseClose();
      await waitFor(() => runningWriteQueued, Boolean);
      releaseTerminal();
      const result = await startPromise;
      expect(result.status).toBe("succeeded");
      const persisted = JSON.parse(await readFile(join(test.state, "jobs", result.job_id, "meta.json"), "utf8")) as Record<string, unknown>;
      expect(persisted).toMatchObject({ status: "succeeded" });
    } finally {
      releaseClose();
      releaseTerminal();
      if (startPromise !== undefined) await startPromise.catch(() => undefined);
      await test.cleanup();
    }
  });

  it("does not emit a stale started event when cancellation wins the running write", async () => {
    const probe = createJobProcessProbe();
    const test = await fixture();
    const events: JobEvent[] = [];
    let manager: JobManager | undefined;
    let job: JobRecord | undefined;
    let cancelling: Promise<JobRecord> | undefined;
    try {
      const snapshotFaults = createJobFileFaults();
      manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state, onEvent: (event) => events.push(event) }, { processes: probe.processes,  files: snapshotFaults.files });

      let mutated = false;
      snapshotFaults.write = async (record, commit) => {
        const result = await commit();
        // Model a cancellation callback that commits between the running
        // metadata write and start()'s event publication. The post-write
        // status guard must suppress a stale `started` event.
        if (!mutated && record.status === "running") {
          mutated = true;
          cancelling = manager!.cancel(record.job_id);
          await waitFor(() => manager!.get(record.job_id).status, status => status === "cancelling");
        }
        return result;
      };
      await manager.initialize();
      job = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "setInterval(() => {}, 10000)"] });
      expect(job.status).toBe("cancelling");
      expect(events.filter((event) => event.job.job_id === job!.job_id && event.type === "started")).toHaveLength(0);
      const child = probe.children[0];
      await cancelling;
      child?.kill();
      await waitFor(() => manager!.get(job!.job_id), (value) => !["queued", "running", "cancelling"].includes(value.status));
    } finally {
      await cancelling?.catch(() => undefined);
      if (manager !== undefined && job !== undefined) {
        const child = probe.children[0];
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
      const snapshotFaults = createJobFileFaults();
      const manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state }, { files: snapshotFaults.files });
      await manager.initialize();


      let failQueued = true;
      snapshotFaults.write = async (record, commit) => {
        if (failQueued && record.status === "queued") {
          failQueued = false;
          throw new Error("synthetic metadata write failure");
        }
        return commit();
      };
      await expect(manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "process.exit(0)"] })).rejects.toThrow("synthetic metadata write failure");
      expect(manager.list()).toHaveLength(0);
      snapshotFaults.write = (_record, commit) => commit();
      const second = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "process.exit(0)"] });
      const settled = await waitFor(() => manager.get(second.job_id), (value) => !["queued", "running", "cancelling"].includes(value.status));
      expect(settled).toMatchObject({ status: "succeeded" });
    } finally { await test.cleanup(); }
  });

  it("releases the queued reservation when creating the job directory fails", async () => {
    const test = await fixture();
    try {
      let blockedPath: string | undefined;
      const manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state }, { files: { ...nativeJobFiles, ensureDirectoryPath: (path, label, privateMode) => nativeJobFiles.ensureDirectoryPath(blockedPath ?? path, label, privateMode) } });
      await manager.initialize();
      const blocker = join(test.state, "job-directory-blocker");
      await writeFile(blocker, "not a directory");
      blockedPath = join(blocker, "job");
      await expect(manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "process.exit(0)"] })).rejects.toMatchObject({ code: expect.stringMatching(/ENOTDIR|EEXIST|EPERM/) });
      blockedPath = undefined;
      expect(manager.list()).toHaveLength(0);
      await expect(readFile(blocker, "utf8")).resolves.toBe("not a directory");
    } finally { await test.cleanup(); }
  });

  it("continues child state convergence when log descriptor cleanup fails", async () => {
    const probe = createJobProcessProbe();
    const test = await fixture();
    let manager: JobManager | undefined;
    let job: JobRecord | undefined;
    try {
      manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state }, { processes: probe.processes, files: { ...nativeJobFiles, openJobLog: async (path, mode) => {
        const handle = await nativeJobFiles.openJobLog(path, mode);
        if (mode === "append") { const close = handle.close.bind(handle); handle.close = async () => { await close(); throw new Error("synthetic descriptor close failure"); }; }
        return handle;
      } } });
      await manager.initialize();
      job = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "setInterval(() => {}, 10000)"] });

      expect(job.status).toBe("running");
      const child = probe.children[0];
      expect(child).toBeDefined();
      const closed = new Promise<void>((resolve) => child!.once("close", () => resolve()));
      child!.kill();
      await closed;
      await expect(waitFor(() => manager!.get(job!.job_id), (value) => !["queued", "running", "cancelling"].includes(value.status))).resolves.toMatchObject({ status: expect.any(String) });
    } finally {
      if (manager !== undefined && job !== undefined) {
        const child = probe.children[0];
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
    const probe = createJobProcessProbe();
    const test = await fixture();
    let releaseQueuedWrite!: () => void;
    const queuedWriteGate = new Promise<void>((resolve) => { releaseQueuedWrite = resolve; });
    let targetJobId: string | undefined;
    let startPromise: Promise<JobRecord> | undefined;
    let cancelPromise: Promise<JobRecord> | undefined;
    let manager: JobManager | undefined;
    try {
      const snapshotFaults = createJobFileFaults();
      manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state }, { processes: probe.processes,  files: snapshotFaults.files });

      snapshotFaults.write = async (record, commit) => {
        if (record.status === "queued" && targetJobId === undefined) {
          targetJobId = record.job_id;
          // The real per-job chain already owns this atomic-file call. Hold
          // its completion while cancellation uses the public Job API; the
          // adapter must not reorder the actual writes.
          const write = commit();
          await queuedWriteGate;
          return write;
        }
        return commit();
      };
      await manager.initialize();
      startPromise = manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "setInterval(() => {}, 10000)"] });
      await waitFor(() => targetJobId, (value) => value !== undefined);
      cancelPromise = manager.cancel(targetJobId!);
      expect(manager.get(targetJobId!).status).toBe("queued");
      expect(manager.hasPendingHistoryRecovery()).toBe(true);
      expect(probe.children).toHaveLength(0);
      // Cancellation owns the pending terminal decision while the original
      // write is blocked. Publication waits for its own durable write.
      releaseQueuedWrite();
      await expect(cancelPromise).resolves.toMatchObject({ status: "cancelled" });
      await expect(startPromise).resolves.toMatchObject({ status: "cancelled" });
      expect((probe.children.length > 0)).toBe(false);
      const persisted = JSON.parse(await readFile(join(test.state, "jobs", targetJobId!, "meta.json"), "utf8")) as Record<string, unknown>;
      expect(persisted).toMatchObject({ status: "cancelled" });
    } finally {
      releaseQueuedWrite();
      if (cancelPromise !== undefined) await cancelPromise.catch(() => undefined);
      if (startPromise !== undefined) await startPromise.catch(() => undefined);
      if (manager !== undefined && targetJobId !== undefined) {
        const child = probe.children[0];
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
    const probe = createJobProcessProbe();
    const test = await fixture();
    let releaseQueuedWrite!: () => void;
    const queuedWriteGate = new Promise<void>((resolve) => { releaseQueuedWrite = resolve; });
    let releaseCancelledWrite!: () => void;
    const cancelledWriteGate = new Promise<void>((resolve) => { releaseCancelledWrite = resolve; });
    let observeLogFailure!: () => void, observeLogClose!: () => void;
    const logFailed = new Promise<void>((resolve) => { observeLogFailure = resolve; });
    const logClosed = new Promise<void>((resolve) => { observeLogClose = resolve; });
    let startSettled = false;
    let targetJobId: string | undefined;
    let startPromise: Promise<JobRecord> | undefined;
    let cancelPromise: Promise<JobRecord> | undefined;
    let manager: JobManager | undefined;
    try {
      const snapshotFaults = createJobFileFaults();
      manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state }, { processes: probe.processes, files: {
        ...snapshotFaults.files,
        async openJobLog(path, mode) {
          try {
            const handle = await nativeJobFiles.openJobLog(path, mode);
            if (mode === "append" && path.endsWith("stdout.log")) {
              const close = handle.close.bind(handle);
              handle.close = async () => { await close(); observeLogClose(); };
            }
            return handle;
          } catch (error) { observeLogFailure(); throw error; }
        },
      } });

      snapshotFaults.write = async (record, commit) => {
        if (record.status === "queued" && targetJobId === undefined) {
          targetJobId = record.job_id;
          const write = commit();
          await queuedWriteGate;
          return write;
        }
        if (record.status === "cancelled") await cancelledWriteGate;
        return commit();
      };
      await manager.initialize();
      startPromise = manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "setInterval(() => {}, 10000)"] });
      void startPromise.then(() => { startSettled = true; }, () => { startSettled = true; });
      await waitFor(() => targetJobId, (value) => value !== undefined);
      cancelPromise = manager.cancel(targetJobId!);
      expect(manager.get(targetJobId!).status).toBe("queued");
      expect(manager.hasPendingHistoryRecovery()).toBe(true);
      // The second log open fails while cancellation is still writing. The
      // start catch must join that decision and preserve its eventual result.
      await mkdir(join(test.state, "jobs", targetJobId!, "stderr.log"));
      releaseQueuedWrite();
      await logFailed;
      await logClosed;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(startSettled).toBe(false);
      expect(manager.get(targetJobId!).status).toBe("queued");
      expect(probe.children).toHaveLength(0);
      releaseCancelledWrite();
      await expect(cancelPromise).resolves.toMatchObject({ status: "cancelled" });
      await expect(startPromise).resolves.toMatchObject({ status: "cancelled" });
      expect((probe.children.length > 0)).toBe(false);
      const persisted = JSON.parse(await readFile(join(test.state, "jobs", targetJobId!, "meta.json"), "utf8")) as Record<string, unknown>;
      expect(persisted).toMatchObject({ status: "cancelled" });
    } finally {
      releaseQueuedWrite();
      releaseCancelledWrite();
      if (cancelPromise !== undefined) await cancelPromise.catch(() => undefined);
      if (startPromise !== undefined) await startPromise.catch(() => undefined);
      if (manager !== undefined && targetJobId !== undefined) {
        const child = probe.children[0];
        if (child !== undefined && child.exitCode === null && child.signalCode === null) {
          const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
          child.kill();
          await closed;
        }
      }
      await test.cleanup();
    }
  });

  it("does not overwrite a queued cancellation after a spawn setup failure races", async () => {
    const probe = createJobProcessProbe();
    const test = await fixture();
    let releaseQueuedWrite!: () => void;
    const queuedWriteGate = new Promise<void>((resolve) => { releaseQueuedWrite = resolve; });
    let releaseFailedWrite!: () => void;
    const failedWriteGate = new Promise<void>((resolve) => { releaseFailedWrite = resolve; });
    let resolveFailedPersist!: () => void;
    const failedPersistEntered = new Promise<void>((resolve) => { resolveFailedPersist = resolve; });
    let targetJobId: string | undefined;
    let startPromise: Promise<JobRecord> | undefined;
    let cancelPromise: Promise<JobRecord> | undefined;
    let manager: JobManager | undefined;
    try {
      manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state }, { processes: probe.processes, persistence: { write: async (record, enqueue) => {
        if (record.status === "queued" && targetJobId === undefined) {
          targetJobId = record.job_id;
          const write = enqueue();
          await queuedWriteGate;
          return write;
        }
        if (record.status === "failed" && record.job_id === targetJobId) {
          // Hold the failed terminal decision before it reaches storage.
          // Cancellation can supersede it while publication is still pending.
          resolveFailedPersist();
          await failedWriteGate;
        }
        return enqueue();
      } } });
      await manager.initialize();
      startPromise = manager.start({ workspace_id: test.workspace.workspaceId, command: process.execPath, args: ["-e", "setInterval(() => {}, 10000)"] });
      await waitFor(() => targetJobId, (value) => value !== undefined);
      await mkdir(join(test.state, "jobs", targetJobId!, "stderr.log"));
      releaseQueuedWrite();
      await failedPersistEntered;
      cancelPromise = manager.cancel(targetJobId!);
      expect(manager.get(targetJobId!).status).toBe("queued");
      expect(manager.hasPendingHistoryRecovery()).toBe(true);
      expect(probe.children).toHaveLength(0);
      releaseFailedWrite();
      await expect(cancelPromise).resolves.toMatchObject({ status: "cancelled" });
      await expect(startPromise).resolves.toMatchObject({ status: "cancelled" });
      expect(probe.children).toHaveLength(0);
      const persisted = JSON.parse(await readFile(join(test.state, "jobs", targetJobId!, "meta.json"), "utf8")) as Record<string, unknown>;
      expect(persisted).toMatchObject({ status: "cancelled" });
    } finally {
      releaseQueuedWrite();
      releaseFailedWrite();
      if (cancelPromise !== undefined) await cancelPromise.catch(() => undefined);
      if (startPromise !== undefined) await startPromise.catch(() => undefined);
      if (manager !== undefined && targetJobId !== undefined) {
        const child = probe.children[0];
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
    const faults = createJobFileFaults();
    let child: ChildProcess | undefined;
    try {
      let terminateCalls = 0;
      const manager = new JobManager({
        policy: policy(test.workspace),
        stateDir: test.state,
        terminateProcess: async () => { terminateCalls += 1; return true; },
      }, { files: faults.files, processes: {
        ...nativeJobProcesses,
        spawn: ((...args: Parameters<typeof spawn>) => { child = spawn(...args); return child; }) as typeof spawn,
      } });
      await manager.initialize();
      const job = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] });
      expect(child).toBeDefined();
      let killed = false;
      faults.write = async (record, commit) => {
        if (!killed && record.job_id === job.job_id && record.status === "cancelling") {
          killed = true;
          // Observe real child exit inside the file-write barrier. The normal
          // persistence queue must then converge before cancel can return.
          const closed = new Promise<void>(resolve => child!.once("close", () => resolve()));
          child!.kill();
          await closed;
        }
        return commit();
      };
      const result = await manager.cancel(job.job_id);
      expect(killed).toBe(true);
      expect(terminateCalls).toBe(0);
      expect(["succeeded", "failed", "interrupted"]).toContain(result.status);
      expect(manager.get(job.job_id).status).toBe(result.status);
      const persisted = JSON.parse(await readFile(join(test.state, "jobs", job.job_id, "meta.json"), "utf8"));
      expect(persisted).toMatchObject({ status: result.status, cancellation_delivered_at_ms: null });
    } finally {
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>(resolve => child!.once("close", () => resolve()));
        child.kill();
        await closed;
      }
      await test.cleanup();
    }
  });

  it("fails promptly when process-tree termination is not delivered", async () => {
    const probe = createJobProcessProbe();
    const test = await fixture();
    try {
      const manager = new JobManager({
        policy: policy(test.workspace),
        stateDir: test.state,
        terminateProcess: async () => false,
      }, { processes: probe.processes });
      await manager.initialize();
      const job = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] });
      const child = probe.children[0];
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
    const probe = createJobProcessProbe();
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
      }, { processes: probe.processes });
      await manager.initialize();
      const job = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] });
      child = probe.children[0];
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


  it("waits for a cancellation registered during log flush before finalizing", async () => {
    const probe = createJobProcessProbe();
    const test = await fixture();
    let releaseFlush!: () => void;
    const flushGate = new Promise<void>((resolve) => { releaseFlush = resolve; });
    let flushStarted!: () => void;
    const flushStartedSignal = new Promise<void>((resolve) => { flushStarted = resolve; });
    let child: ChildProcess | undefined;

    let cancelPromise: Promise<JobRecord> | undefined;
    let blocked = false;
    try {
      const manager = new JobManager({
        policy: policy(test.workspace),
        stateDir: test.state,
        terminateProcess: async () => {
          child?.kill();
          return true;
        },
      }, { processes: probe.processes, files: { ...nativeJobFiles, openJobLog: async (path, mode) => {
        if (mode === "read" && path.endsWith("stdout.log") && !blocked) { blocked = true; flushStarted(); await flushGate; }
        return nativeJobFiles.openJobLog(path, mode);
      } } });
      await manager.initialize();
      const job = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "setInterval(() => {}, 10000)"] });
      child = probe.children[0];
      expect(child).toBeDefined();
      // Model the close callback beginning completion just before cancellation
      // gets to its process-tree decision. The real child is then terminated by
      // the injected seam, and both paths must converge on one durable result.
      child!.emit("close", 143, "SIGTERM");
      await flushStartedSignal;
      cancelPromise = manager.cancel(job.job_id);
      await waitFor(() => manager.get(job.job_id), (value) => value.status === "cancelling");
      releaseFlush();
      await expect(cancelPromise).resolves.toMatchObject({ status: "cancelled", cancellation_delivered_at_ms: expect.any(Number) });
      await manager.flushPersistence();
      const persisted = JSON.parse(await readFile(join(test.state, "jobs", job.job_id, "meta.json"), "utf8")) as Record<string, unknown>;
      expect(persisted).toMatchObject({ status: "cancelled", cancellation_delivered_at_ms: expect.any(Number) });
    } finally {
      releaseFlush();
      if (cancelPromise !== undefined) await cancelPromise.catch(() => undefined);

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
      child = spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"], { stdio: "ignore", windowsHide: true });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await expect(nativeJobProcesses.terminateProcess(child.pid ?? null, null)).resolves.toBe(false);
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









  it("marks jobs found alive after restart unknown and vanished processes interrupted", async () => {
    const test = await fixture();
    const first = new JobManager({ policy: policy(test.workspace), stateDir: test.state, maxConcurrentJobs: 2, maxRetainedJobs: 100 });
    let alive: JobRecord | undefined;
    try {
      await first.initialize();
      alive = await first.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] });
      const aliveId = alive.job_id;
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
      await waitFor(() => first.get(aliveId), (value) => value.status === "cancelled" || value.status === "failed");
    } finally {
      if (alive !== undefined) await first.cancel(alive.job_id).catch(() => undefined);
      await test.cleanup();
    }
  });

  it("ignores log data delivered after terminalization and retention pruning", async () => {
    const test = await fixture();
    const probe = createJobProcessProbe();
    try {
      const manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state, maxRetainedJobs: 2 }, { processes: probe.processes });
      await manager.initialize();
      const first = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "process.stdout.write('before')"] });
      await waitFor(() => manager.get(first.job_id), (value) => value.status === "succeeded");
      const child = probe.children[0]!;
      const before = await manager.logs(first.job_id, { stream: "stdout", limit: 1024 });
      child.stdout!.emit("data", Buffer.from("late"));

      await manager.flushPersistence();
      const after = await manager.logs(first.job_id, { stream: "stdout", limit: 1024 });
      expect(after).toMatchObject({ data: before.data, size: before.size });

      const second = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "process.exit(0)"] });
      await waitFor(() => manager.get(second.job_id), (value) => value.status === "succeeded");
      const third = await manager.start({ workspace_id: "workspace-1", command: process.execPath, args: ["-e", "process.exit(0)"] });
      await waitFor(() => manager.get(third.job_id), (value) => value.status === "succeeded");
      expect(() => manager.get(first.job_id)).toThrow("job not found");
      child.stdout!.emit("data", Buffer.from("after-prune"));
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
      const manager = new JobManager({ policy: policy(test.workspace), stateDir: test.state, maxRetainedJobs: 1, maxConcurrentJobs: 2 });
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
      // Flush any queued metadata writes before deliberately editing meta.json
      // so a late active snapshot cannot overwrite this recovery fixture.
      await manager.flushPersistence();
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
      const environmentModule = await import("../src/environment.js");
      const runtime = new RunnerRuntime({ config, stateDir: test.state, environment: new environmentModule.EnvironmentInfoService({ probe: async (command) => { calls += 1; return command === "docker" ? undefined : `${command} version`; } }) });
      const [first, second] = await Promise.all([runtime.envInfo(), runtime.envInfo()]);
      expect(first).toEqual(second);
      expect(first).toMatchObject({ platform: process.platform, architecture: process.arch, tools: { docker: { available: false }, git: { available: true, version: "git version" } } });
      expect(JSON.stringify(first)).not.toContain("PATH=");
      expect(calls).toBe(8);
    } finally { await test.cleanup(); }
  });

  it("refreshes workspace metadata after a policy update while reusing probes", async () => {
    const test = await fixture();
    try {
      let calls = 0;
      const config: RunnerConfig = { server: "ws://127.0.0.1", token: "0123456789abcdef", runnerId: "runner-1", workspaces: [test.workspace] };
      const environmentModule = await import("../src/environment.js");
      const runtime = new RunnerRuntime({ config, stateDir: test.state, environment: new environmentModule.EnvironmentInfoService({ probe: async (command) => { calls += 1; return `${command} version`; } }) });
      await runtime.envInfo();
      const replacement = { ...test.workspace, workspaceId: "workspace-2", readonly: true };
      runtime.applyPolicy([replacement]);
      const refreshed = await runtime.envInfo();
      expect(refreshed.workspaces).toEqual([{ workspace_id: "workspace-2", readonly: true, shell: false }]);
      expect(calls).toBe(8);
    } finally { await test.cleanup(); }
  });
});


it("expires only opted-in terminal local Job metadata and logs, not active or uncertain Jobs", async () => {
  const f = await fixture();
  let manager: JobManager | undefined, runningId: string | undefined, queuedId: string | undefined;
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const initial = new JobManager({ policy: policy(f.workspace), stateDir: f.state });
    await initial.initialize();
    const start = await initial.start({ workspace_id: f.workspace.workspaceId, command: [process.execPath, "-e", "console.log('retention-test')"] });
    await initial.waitForTerminal(start.job_id);
    const done = initial.get(start.job_id);
    expect(done.status).toBe("succeeded");
    const old = Date.now() - 3 * 86400000;
    const expired = { ...done, created_at_ms: old - 2, started_at_ms: old - 1, updated_at_ms: old, completed_at_ms: old };
    await writeFile(join(f.state, "jobs", done.job_id, "meta.json"), JSON.stringify(expired));
    const recoveredPid = 2147483000;
    const recoveredJobs = [["job-00000000-0000-0000-0000-000000000001", "cancelling"], ["job-00000000-0000-0000-0000-000000000002", "unknown"]] as const;
    for (const [id, status] of recoveredJobs) {
      await mkdir(join(f.state, "jobs", id), { mode: 0o700 });
      await writeFile(join(f.state, "jobs", id, "meta.json"), JSON.stringify({
        ...expired, job_id: id, pid: recoveredPid, status, completed_at_ms: null, exit_code: null,
      }));
      await writeFile(join(f.state, "jobs", id, "sentinel"), "preserve");
    }
    manager = new JobManager({
      policy: policy(f.workspace), stateDir: f.state, maxRetainedJobs: 10, maxConcurrentJobs: 3,
      authorizeQueuedJob: async () => true,
    }, { processes: {
      ...nativeJobProcesses,
      inspectProcess: async (pid, fingerprint) => pid === recoveredPid
        ? { alive: true, fingerprintMatches: true } : nativeJobProcesses.inspectProcess(pid, fingerprint),
    } });
    await manager.initialize();
    for (const [id, status] of recoveredJobs) expect(manager.get(id).status).toBe(status);
    const running = await manager.start({ workspace_id: f.workspace.workspaceId, command: [process.execPath, "-e", "process.stdin.resume();process.stdin.once('data',()=>process.exit(0))"] });
    runningId = running.job_id;
    const queued = await manager.start({ workspace_id: f.workspace.workspaceId, command: [process.execPath, "-e", "process.exit(0)"] });
    queuedId = queued.job_id;
    const protectedJobs = [[queuedId, "queued"], [runningId, "running"], ...recoveredJobs] as const;
    for (const [id, status] of protectedJobs) {
      expect(manager.get(id).status).toBe(status);
      await writeFile(join(f.state, "jobs", id, "sentinel"), "preserve");
    }
    // Advance only the wall clock: real process callbacks and disk I/O still run.
    // Even active/recovered records now older than the TTL must survive.
    clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3 * 86400000);
    await manager.cleanupExpired();
    expect(await lstat(join(f.state, "jobs", done.job_id))).toBeDefined();
    manager.setRetentionDays(1);
    await manager.cleanupExpired();
    await expect(lstat(join(f.state, "jobs", done.job_id))).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => manager!.get(done.job_id)).toThrow();
    for (const [id, status] of protectedJobs) {
      expect(manager.get(id).status).toBe(status);
      expect(await readFile(join(f.state, "jobs", id, "sentinel"), "utf8")).toBe("preserve");
    }
    expect(() => manager!.setRetentionDays(-1)).toThrow();
    expect(() => manager!.setRetentionDays(99999)).toThrow();
  } finally {
    clock?.mockRestore();
    if (manager !== undefined && queuedId !== undefined) await manager.cancel(queuedId);
    if (manager !== undefined && runningId !== undefined) {
      await manager.input(runningId, "exit\n");
      await manager.waitForTerminal(runningId);
    }
    await f.cleanup();
  }
});
