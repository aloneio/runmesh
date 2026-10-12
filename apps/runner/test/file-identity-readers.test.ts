import * as fs from "node:fs/promises";
import * as syncFs from "node:fs";
import type { BigIntStats, Stats } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runnerPolicyChecksum } from "@aloneio/runmesh-protocol";
import { exactFileStats } from "../src/file-identity.js";
import { ProfileStore } from "../src/profile.js";
import { PolicyStore } from "../src/policy-store.js";
import { readMetadataJson } from "../src/updates/metadata-file.js";
import { readManagerJson } from "../src/updates/journal.js";
import { inspectLocalJobs } from "../src/updates/job-drain.js";
import { acquireInstallationLock } from "../src/updates/installation-lock.js";
import { hostPurgeFilesystem } from "../src/purge.js";
import { hostLaunchdStopRecoveryFilesystem } from "../src/services/launchd-stop.js";
import { createIsolatedGitContext } from "../src/git/isolated-context.js";
import { snapshotGitObjects } from "../src/git/object-snapshot.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) };
});
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync) };
});
const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const syncActual = await vi.importActual<typeof import("node:fs")>("node:fs");
const roots: string[] = [];
const firstInode = 9_007_199_254_740_992n, nextInode = firstInode + 1n;
async function temporary(): Promise<string> {
  const root = await actual.realpath(await actual.mkdtemp(join(tmpdir(), "runmesh-exact-reader-")));
  roots.push(root); return root;
}
function metadata<T extends BigIntStats | Stats>(info: T, inode: bigint): T {
  return Object.assign(Object.create(Object.getPrototypeOf(info)), info, { ino: typeof info.ino === "bigint" ? inode : Number(inode) });
}
afterEach(async () => {
  vi.mocked(fs.lstat).mockImplementation(actual.lstat);
  vi.mocked(fs.open).mockImplementation(actual.open);
  vi.mocked(syncFs.lstatSync).mockImplementation(syncActual.lstatSync);
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map(root => actual.rm(root, { recursive: true, force: true })));
});

/** Only metadata is simulated; fixture files remain unchanged throughout. */
function mockReadIdentity(path: string, openedInode: bigint) {
  let pathReads = 0, handleReads = 0;
  const matches = (candidate: unknown) => String(candidate) === path || (String(candidate).startsWith("/proc/self/fd/") && basename(String(candidate)) === basename(path));
  vi.mocked(fs.lstat).mockImplementation((async (candidate, options) => {
    const info = await actual.lstat(candidate, options as never);
    if (!matches(candidate)) return info;
    expect(options).toMatchObject({ bigint: true }); pathReads++;
    return metadata(info, firstInode);
  }) as typeof fs.lstat);
  vi.mocked(fs.open).mockImplementation(async (candidate, flags, mode) => {
    const handle = await actual.open(candidate, flags, mode);
    if (matches(candidate)) {
      const stat = handle.stat.bind(handle);
      handle.stat = (async options => {
        expect(options).toMatchObject({ bigint: true }); handleReads++;
        return metadata(await stat(options as never), openedInode);
      }) as typeof handle.stat;
    }
    return handle;
  });
  return () => ({ pathReads, handleReads });
}

it.each(["profile", "policy", "manager", "job", "purge", "launchd", "git-head", "git-object"] as const)(
  "%s readers retain exact native metadata for stable and distinct identities", async kind => {
    const root = await temporary(); let path = join(root, "record.json"), observe: () => Promise<unknown>;
    const profile = { version: 1, server_url: "wss://runner.example.test/runner/connect", runner_id: "runner-1", token: "fixture-credential-012345", management_mode: "central", execution_mode: "dedicated_user", workspaces: [] };
    let content = JSON.stringify(profile);
    if (kind === "profile") observe = () => new ProfileStore({ filePath: path }).loadMaintenanceIdentity();
    else if (kind === "policy") {
      const store = new PolicyStore(root); path = store.activePath;
      const unsigned = { schema_version: 1, runner_id: "runner-1", revision: 1, runner_permissions: { read: true, edit: true, shell: true, job_control: true }, workspaces: [] } as const;
      content = JSON.stringify({ ...unsigned, checksum: runnerPolicyChecksum(unsigned) });
      observe = () => store.load("runner-1");
    } else if (kind === "manager") { content = '{"value":1}'; observe = () => readManagerJson(path); }
    else if (kind === "job") {
      const job = "job-12345678-1234-1234-1234-123456789abc";
      path = join(root, "jobs", job, "meta.json");
      content = JSON.stringify({ job_id: job, status: "succeeded", created_at_ms: 1, updated_at_ms: 2 });
      observe = () => inspectLocalJobs(root);
    } else if (kind === "purge") observe = () => hostPurgeFilesystem.text(path, 4096);
    else if (kind === "launchd") observe = () => hostLaunchdStopRecoveryFilesystem.read(path);
    else if (kind === "git-head") {
      path = join(root, ".git", "HEAD"); content = "a".repeat(40) + "\n";
      await actual.mkdir(join(root, ".git", "objects", "info"), { recursive: true });
      observe = async () => { const context = await createIsolatedGitContext(root); await context.cleanup(); return true; };
    } else {
      path = join(root, "objects", "record"); content = "object fixture";
      observe = async () => { const destination = join(root, "snapshot"); await actual.mkdir(destination); try { await snapshotGitObjects(dirname(path), destination); return await actual.readFile(join(destination, "record"), "utf8"); } finally { await actual.rm(destination, { recursive: true, force: true }); } };
    }
    await actual.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await actual.writeFile(path, content, { mode: 0o600 });
    for (const inode of [firstInode, nextInode]) {
      const counts = mockReadIdentity(path, inode);
      if (inode === firstInode) expect(await observe()).toBeDefined();
      else await expect(observe()).rejects.toThrow();
      expect(counts().pathReads).toBeGreaterThan(0); expect(counts().handleReads).toBeGreaterThan(0);
      expect(await actual.readFile(path, "utf8")).toBe(content);
    }
  });

it.each(["exact", "safe-legacy", "unsafe-legacy"] as const)("maintenance metadata admission handles %s identities", async kind => {
  const path = join(await temporary(), "metadata.json"); await actual.writeFile(path, '{"value":1}');
  const inode = kind === "safe-legacy" ? 7n : firstInode;
  vi.mocked(fs.lstat).mockImplementation((async (candidate, options) => metadata(await actual.lstat(candidate, options as never), inode)) as typeof fs.lstat);
  const expected = exactFileStats(metadata(await actual.lstat(path, { bigint: true }), inode));
  vi.mocked(fs.open).mockImplementation(async (candidate, flags, mode) => {
    const handle = await actual.open(candidate, flags, mode), stat = handle.stat.bind(handle);
    handle.stat = (async options => metadata(await stat(options as never), inode)) as typeof handle.stat;
    return handle;
  });
  const { identityKey: _key, ...legacy } = expected;
  const read = () => readMetadataJson(path, kind === "exact" ? expected : legacy, { maxBytes: 1024, errorCode: "local_state_invalid" });
  if (kind === "unsafe-legacy") { await expect(read()).rejects.toThrow("local_state_invalid"); expect(fs.open).not.toHaveBeenCalled(); }
  else await expect(read()).resolves.toEqual({ value: 1 });
});

it.each(["jobs", "git", "objects"] as const)("%s directory observations use exact identities across metadata reads", async kind => {
  const root = await temporary(), path = join(root, kind === "git" ? ".git" : kind);
  await actual.mkdir(path);
  if (kind === "git") {
    await actual.mkdir(join(path, "objects", "info"), { recursive: true });
    await actual.writeFile(join(path, "HEAD"), "a".repeat(40) + "\n");
  }
  const destination = join(root, "snapshot"); await actual.mkdir(destination);
  for (const changed of [false, true]) {
    let reads = 0;
    vi.mocked(fs.lstat).mockImplementation((async (candidate, options) => {
      const info = await actual.lstat(candidate, options as never);
      if (String(candidate) !== path || !options || typeof options === "string" || !options.bigint) return info;
      return metadata(info, changed && reads++ > 0 ? nextInode : firstInode);
    }) as typeof fs.lstat);
    vi.mocked(fs.open).mockImplementation(async (candidate, flags, mode) => {
      const handle = await actual.open(candidate, flags, mode);
      if (String(candidate) === path) { const stat = handle.stat.bind(handle); handle.stat = (async options => metadata(await stat(options as never), firstInode)) as typeof handle.stat; }
      return handle;
    });
    const observe = async () => {
      if (kind === "jobs") return inspectLocalJobs(root);
      if (kind === "objects") return snapshotGitObjects(path, destination);
      const context = await createIsolatedGitContext(root); await context.cleanup();
    };
    if (changed) await expect(observe()).rejects.toThrow();
    else await observe();
  }
});

it.skipIf(process.platform === "win32")("installation lease assertions retain exact synchronous identities", async () => {
  const root = await temporary(), shared = join(root, ".installation.lock"); let changed = false;
  vi.mocked(fs.lstat).mockImplementation((async (candidate, options) => {
    const info = await actual.lstat(candidate, options as never);
    return basename(String(candidate)) === "lease.json" ? metadata(info, firstInode) : info;
  }) as typeof fs.lstat);
  vi.mocked(syncFs.lstatSync).mockImplementation(((candidate, options) => {
    const info = syncActual.lstatSync(candidate, options as never);
    if (String(candidate) !== shared) return info;
    expect(options).toMatchObject({ bigint: true });
    return metadata(info, changed ? nextInode : firstInode);
  }) as typeof syncFs.lstatSync);
  const lease = await acquireInstallationLock("user", root); expect(lease).toBeDefined();
  try { expect(() => lease!.assertHeld()).not.toThrow(); changed = true; expect(() => lease!.assertHeld()).toThrow("owner changed"); }
  finally { changed = false; await lease!.release(); }
});
