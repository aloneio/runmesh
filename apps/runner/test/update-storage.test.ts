import { afterEach, describe, expect, it } from "vitest";
import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { inspectLocalJobs } from "../src/updates/job-drain.js";
import { ManagedInstallationPointer } from "../src/updates/installation.js";
import { FileUpdateJournal, loadManagerId } from "../src/updates/journal.js";
import type { UpdateJournal, UpdatePreparation } from "../src/updates/contracts.js";

const roots: string[] = [];
async function temporary(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "runmesh-update-")); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const jobId = "job-12345678-1234-1234-1234-123456789abc";
const job = (status: string) => ({ job_id: jobId, workspace_id: "workspace_1", cwd: ".", command: ["node"], shell: false, status, pid: null, created_at_ms: 1, updated_at_ms: 2, record_history: false });
async function jobsRoot(): Promise<string> { const root = await temporary(); await mkdir(join(root, "jobs")); return root; }
async function writeJob(root: string, value: unknown): Promise<void> { await mkdir(join(root, "jobs", jobId), { recursive: true }); await writeFile(join(root, "jobs", jobId, "meta.json"), JSON.stringify(value)); }

describe("complete local job drain", () => {
  it.each(["queued", "running", "cancelling", "unknown"])("blocks %s jobs even with record_history=false", async status => {
    const root = await jobsRoot(); await writeJob(root, job(status));
    await expect(inspectLocalJobs(root)).resolves.toEqual({ idle: false, active: 1 });
  });
  it("accepts only valid terminal records as idle", async () => {
    const root = await jobsRoot(); await writeJob(root, job("succeeded"));
    await expect(inspectLocalJobs(root)).resolves.toEqual({ idle: true, active: 0 });
    await writeJob(root, { status: "succeeded" });
    await expect(inspectLocalJobs(root)).rejects.toThrow("local_state_invalid");
  });
  it("does not interpret missing storage, unreadable metadata or directory links as no jobs", async () => {
    const missing = await temporary(); await expect(inspectLocalJobs(missing)).rejects.toThrow("local_state_invalid");
    const root = await jobsRoot(); await mkdir(join(root, "jobs", jobId));
    await expect(inspectLocalJobs(root)).rejects.toThrow("local_state_invalid");
    const outside = await temporary(); await writeFile(join(outside, "meta.json"), JSON.stringify(job("succeeded")));
    await rm(join(root, "jobs", jobId), { recursive: true });
    await symlink(outside, join(root, "jobs", jobId), process.platform === "win32" ? "junction" : "dir");
    await expect(inspectLocalJobs(root)).rejects.toThrow("local_state_invalid");
  });
});

async function installation() {
  const root = await temporary(); await mkdir(join(root, "versions"));
  const release = async (version: string, name: string) => {
    const directory = join(root, "versions", name);
    const packagePath = process.platform === "win32" ? join(directory, "node_modules", "@aloneio", "runmesh-runner") : join(directory, "lib", "node_modules", "@aloneio", "runmesh-runner");
    await mkdir(packagePath, { recursive: true }); await writeFile(join(packagePath, "package.json"), JSON.stringify({ name: "@aloneio/runmesh-runner", version }));
    return { version, directory };
  };
  const previous = await release("0.1.7", "0.1.7"); const next = await release("0.1.6", "0.1.6-upgrade_1-random");
  await symlink(previous.directory, join(root, "current"), process.platform === "win32" ? "junction" : "dir");
  return { root, previous, next, release, pointer: new ManagedInstallationPointer(root) };
}

describe("managed version pointer and durable journal", () => {
  it("rejects an installation reached through an aliased ancestor while accepting its canonical root", async () => {
    const test = await installation(); const container = await temporary(); const alias = join(container, "temp-alias");
    await symlink(dirname(test.root), alias, process.platform === "win32" ? "junction" : "dir");
    try {
      const aliasedRoot = join(alias, basename(test.root));
      expect((await lstat(aliasedRoot)).isSymbolicLink()).toBe(false);
      expect(await realpath(aliasedRoot)).toBe(test.root);
      await expect(new ManagedInstallationPointer(aliasedRoot).inspect()).rejects.toThrow("invalid_installation");
      await expect(test.pointer.inspect()).resolves.toEqual(test.previous);
    } finally { await unlink(alias); }
  });
  it("switches to a verified operation-specific older directory and restores the original", async () => {
    const test = await installation(); await expect(test.pointer.inspect()).resolves.toEqual(test.previous);
    await expect(test.pointer.assertRecoverable(test.previous, undefined, "upgrade_1")).resolves.toBeUndefined();
    await test.pointer.switch(test.previous, test.next, "upgrade_1"); await expect(test.pointer.inspect()).resolves.toEqual(test.next);
    await expect(test.pointer.assertRecoverable(test.previous, test.next, "upgrade_1")).resolves.toBeUndefined();
    await test.pointer.restore(test.previous, test.next, "upgrade_1"); await expect(test.pointer.inspect()).resolves.toEqual(test.previous);
    await expect(test.pointer.assertRecoverable(test.previous, test.next, "upgrade_1")).resolves.toBeUndefined();
  });
  it("rejects a concurrent current replacement or an out-of-tree staged directory", async () => {
    const test = await installation();
    await expect(test.pointer.switch(test.previous, { ...test.next, directory: await temporary() }, "upgrade_1")).rejects.toThrow("invalid_installation");
    await test.pointer.switch(test.previous, test.next, "upgrade_1");
    await expect(test.pointer.switch({ ...test.previous, version: "0.1.8" }, test.next, "upgrade_2")).rejects.toThrow("invalid_installation");
  });
  it("rejects recovery of a replacement installation without changing any pointer", async () => {
    const test = await installation();
    await test.pointer.assertRecoverable(test.previous, test.next, "upgrade_1");
    const replacement = await test.release("0.1.8", "0.1.8-replacement");
    await rename(join(test.root, "current"), join(test.root, ".operator-current.previous"));
    await symlink(replacement.directory, join(test.root, "current"), process.platform === "win32" ? "junction" : "dir");
    const entries = await readdir(test.root);
    await expect(test.pointer.assertRecoverable(test.previous, test.next, "upgrade_1")).rejects.toThrow("invalid_installation");
    await expect(test.pointer.restore(test.previous, test.next, "upgrade_1")).rejects.toThrow("invalid_installation");
    await expect(test.pointer.inspect()).resolves.toEqual(replacement);
    expect(await readdir(test.root)).toEqual(entries);
  });
  it("rejects recovery when the running candidate no longer matches its recorded version", async () => {
    const test = await installation(); await test.pointer.switch(test.previous, test.next, "upgrade_1");
    await expect(test.pointer.assertRecoverable(test.previous, { ...test.next, version: "0.1.8" }, "upgrade_1")).rejects.toThrow("invalid_installation");
    await expect(test.pointer.inspect()).resolves.toEqual(test.next);
  });
  it("rejects a missing current pointer without this operation's Windows backup", async () => {
    const test = await installation(); await rename(join(test.root, "current"), join(test.root, ".operator-current.previous"));
    await expect(test.pointer.assertRecoverable(test.previous, test.next, "upgrade_1")).rejects.toThrow("invalid_installation");
    await expect(lstat(join(test.root, "current"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.skipIf(process.platform !== "win32")("restores the old junction after a crash between the two Windows renames", async () => {
    const test = await installation(); const id = createHash("sha256").update("upgrade_1").digest("hex").slice(0, 24);
    await rename(join(test.root, "current"), join(test.root, `.manager-current-${id}.previous`));
    await expect(test.pointer.assertRecoverable(test.previous, test.next, "upgrade_2")).rejects.toThrow("invalid_installation");
    await expect(test.pointer.assertRecoverable(test.previous, test.next, "upgrade_1")).resolves.toBeUndefined();
    await expect(lstat(join(test.root, "current"))).rejects.toMatchObject({ code: "ENOENT" });
    await test.pointer.restore(test.previous, test.next, "upgrade_1");
    await expect(test.pointer.inspect()).resolves.toEqual(test.previous);
  });
  it("preserves a stable non-secret manager identity and archives only acknowledged terminal operations", async () => {
    const directory = await temporary(); const managerId = await loadManagerId(directory);
    expect(await loadManagerId(directory)).toBe(managerId);
    const journal = new FileUpdateJournal(directory);
    const state: UpdateJournal = { schema_version: 1, manager_id: managerId, phase: "checking",
      operation: { operation_id: "upgrade_1", lifecycle_id: "lifecycle_1", target_version: "0.1.6", target_channel: "stable", manifest_sha256: "a".repeat(64), artifact_sha256: "b".repeat(64), original_version: "0.1.7", manager_id: managerId, state: "checking", error_code: null, created_at_ms: 1, updated_at_ms: 2 },
      previous: { version: "0.1.7", directory: "/managed/versions/old" }, next: { version: "0.1.6", directory: "/managed/versions/new" },
      service: { schema_version: 1, platform: "linux", mode: "system", registered: true, active: false, enabled: false, enablement: "disabled", pid: 0 } };
    await journal.save(state); expect(await journal.load()).toEqual(state);
    await journal.save({ ...state, phase: "succeeded" }); await journal.complete({ ...state, phase: "succeeded" });
    expect(await journal.load()).toBeUndefined(); expect(JSON.parse(await readFile(join(directory, "last-operation.json"), "utf8")).phase).toBe("succeeded");
  });
  it("blocks corrupt transaction state instead of discarding recovery evidence", async () => {
    const directory = await temporary(); await writeFile(join(directory, "active-operation.json"), '{"schema_version":1}', { mode: 0o600 });
    await expect(new FileUpdateJournal(directory).load()).rejects.toThrow("local_state_invalid");
  });
  it("persists preparation before an installation path or service snapshot is available", async () => {
    const directory = await temporary(); const journal = new FileUpdateJournal(directory);
    const preparation: UpdatePreparation = { schema_version: 1, manager_id: "manager_1", phase: "preparing",
      operation: { operation_id: "upgrade_1", lifecycle_id: "lifecycle_1", target_version: "0.1.6", target_channel: "stable", manifest_sha256: "a".repeat(64), artifact_sha256: "b".repeat(64), original_version: null, manager_id: null, state: "queued", error_code: null, created_at_ms: 1, updated_at_ms: 1 } };
    await journal.save(preparation);
    expect(await new FileUpdateJournal(directory).load()).toEqual(preparation);
    await journal.complete(preparation); expect(await journal.load()).toBeUndefined();
    await expect(journal.save({ ...preparation, operation: { ...preparation.operation, manager_id: "other-manager" } })).rejects.toThrow("local_state_invalid");
    await expect(journal.save({ ...preparation, operation: { ...preparation.operation, state: "installing" } })).rejects.toThrow("local_state_invalid");
    await expect(journal.save({ ...preparation, previous: { version: "0.1.7", directory: "/untrusted" } } as UpdatePreparation)).rejects.toThrow("local_state_invalid");
  });
});
