import { expect, it, vi } from "vitest";
import { link, lstat, mkdtemp, mkdir, open, rm, readdir, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireInstallationLock } from "../src/updates/installation-lock.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), lstat: vi.fn(actual.lstat) };
});
const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

it("serializes local maintenance and releases only its own lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "runmesh-install-lock-"));
  try {
    const first = await acquireInstallationLock("user", root); expect(first).toBeDefined(); first?.assertHeld();
    expect(await acquireInstallationLock("user", root)).toBeUndefined();
    await first?.release(); expect(() => first?.assertHeld()).toThrow();
    const second = await acquireInstallationLock("user", root); expect(second).toBeDefined(); await second?.release();
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform === "win32")("leaves a lock created by an installer in place", async () => {
  const root = await mkdtemp(join(tmpdir(), "runmesh-install-lock-"));
  try {
    await mkdir(join(root, ".installation.lock"));
    expect(await acquireInstallationLock("user", root)).toBeUndefined();
    expect(await readdir(root)).toEqual([".installation.lock"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform === "win32")("concurrent stale recovery leaves exactly one live owner", async () => {
  const child = spawn(process.execPath, ["-e", ""], { windowsHide: true });
  await new Promise<void>((done, fail) => { child.once("close", () => done()); child.once("error", fail); });
  const root = await mkdtemp(join(tmpdir(), "runmesh-install-lock-"));
  try {
    const lock = join(root, ".installation.lock"); const generation = randomUUID();
    const directory = `${lock}.manager-${generation}`; await mkdir(directory);
    await writeFile(join(directory, "lease.json"), JSON.stringify({ schema_version: 1, generation }));
    await writeFile(join(directory, `owner-${child.pid}-${randomUUID()}`), "");
    await link(join(directory, "lease.json"), lock);
    const attempts = await Promise.all(Array.from({ length: 8 }, () => acquireInstallationLock("user", root)));
    const leases = attempts.filter(value => value !== undefined);
    expect(leases).toHaveLength(1); leases[0]!.assertHeld(); await leases[0]!.release();
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform === "win32")("releases a published lease when its parent directory fsync fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "runmesh-install-lock-"));
  const lock = join(root, ".installation.lock"); let failed = false;
  const failure = Object.assign(new Error("parent directory sync failed"), { code: "EIO" });
  try {
    vi.mocked(open).mockImplementation(async (path, flags, mode) => {
      const handle = await actual.open(path, flags, mode);
      if (String(path) === root && !failed) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          if (failed) return sync();
          expect((await actual.lstat(lock)).isFile()).toBe(true);
          failed = true; throw failure;
        };
      }
      return handle;
    });
    await expect(acquireInstallationLock("user", root)).rejects.toBe(failure);
    expect(failed).toBe(true); expect(await readdir(root)).toEqual([]);
    const retry = await acquireInstallationLock("user", root); expect(retry).toBeDefined();
    retry!.assertHeld(); await retry!.release(); expect(await readdir(root)).toEqual([]);
  } finally {
    vi.mocked(open).mockImplementation(actual.open);
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")("resets a stale recovery claim after a transient lease metadata read failure", async () => {
  const child = spawn(process.execPath, ["-e", ""], { windowsHide: true });
  await new Promise<void>((done, fail) => { child.once("close", () => done()); child.once("error", fail); });
  const root = await mkdtemp(join(tmpdir(), "runmesh-install-lock-"));
  try {
    const lock = join(root, ".installation.lock"); const generation = randomUUID();
    const directory = `${lock}.manager-${generation}`; const leasePath = join(directory, "lease.json");
    const oldMarker = `owner-${child.pid}-${randomUUID()}`; let failed = false;
    await mkdir(directory); await writeFile(leasePath, JSON.stringify({ schema_version: 1, generation }));
    await writeFile(join(directory, oldMarker), ""); await link(leasePath, lock);
    const original = await actual.lstat(lock);
    const failure = Object.assign(new Error("lease metadata temporarily unavailable"), { code: "EIO" });
    vi.mocked(lstat).mockImplementation((async (...args: Parameters<typeof actual.lstat>) => {
      if (String(args[0]) === leasePath && !failed) {
        const markers = (await actual.readdir(directory)).filter(name => name.startsWith("owner-"));
        expect(markers).toHaveLength(1); expect(markers[0]).toMatch(new RegExp(`^owner-${process.pid}-`));
        failed = true; throw failure;
      }
      return actual.lstat(...args);
    }) as typeof actual.lstat);
    await expect(acquireInstallationLock("user", root)).rejects.toBe(failure);
    expect(failed).toBe(true); expect((await readdir(directory)).sort()).toEqual(["lease.json", oldMarker].sort());
    const preserved = await actual.lstat(lock);
    expect({ dev: preserved.dev, ino: preserved.ino }).toEqual({ dev: original.dev, ino: original.ino });
    const retry = await acquireInstallationLock("user", root); expect(retry).toBeDefined();
    retry!.assertHeld(); await retry!.release(); expect(await readdir(root)).toEqual([]);
  } finally {
    vi.mocked(lstat).mockImplementation(actual.lstat);
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")("unpublished owner preparation and completed-release debris never block acquisition", async () => {
  const root = await mkdtemp(join(tmpdir(), "runmesh-install-lock-"));
  try {
    const preparation = join(root, `.installation.lock.manager-${randomUUID()}`); await mkdir(preparation);
    await writeFile(join(preparation, "lease.json"), "partial preparation");
    const first = await acquireInstallationLock("user", root); expect(first).toBeDefined(); await first!.release();
    const second = await acquireInstallationLock("user", root); expect(second).toBeDefined(); await second!.release();
    expect(await readdir(preparation)).toEqual(["lease.json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform === "win32")("detects a replaced directory before touching the installed Runner", async () => {
  const root = await mkdtemp(join(tmpdir(), "runmesh-install-lock-"));
  try {
    const lease = await acquireInstallationLock("user", root);
    await rename(join(root, ".installation.lock"), join(root, "moved")); await mkdir(join(root, ".installation.lock"));
    expect(() => lease!.assertHeld()).toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.runIf(process.platform === "win32")("serializes parallel Windows contenders while keeping independent installations separate", async () => {
  const root = await mkdtemp(join(tmpdir(), "runmesh-install-lock-"));
  try {
    const attempts = await Promise.all(Array.from({ length: 4 }, () => acquireInstallationLock("user", root)));
    const leases = attempts.filter(value => value !== undefined); expect(leases).toHaveLength(1);
    const separate = await acquireInstallationLock("user", join(root, "second")); expect(separate).toBeDefined();
    leases[0]!.assertHeld(); separate!.assertHeld(); await separate!.release(); await leases[0]!.release();
    const reacquired = await acquireInstallationLock("user", root); expect(reacquired).toBeDefined(); await reacquired!.release();
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);
