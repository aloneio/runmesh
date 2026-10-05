import * as fs from "node:fs/promises";
import type { PathLike } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PatchService, type ApplyPatchOptions } from "../src/patch-service.js";
import { PathPolicy } from "../src/path-policy.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), rm: vi.fn(actual.rm), lstat: vi.fn(actual.lstat), link: vi.fn(actual.link), rename: vi.fn(actual.rename) };
});
const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

async function fixture(options: ApplyPatchOptions = {}) {
  const root = await actual.realpath(await actual.mkdtemp(join(tmpdir(), "runmesh-patch-persistence-")));
  const policy = new PathPolicy([{ workspaceId: "patch", rootPath: root, readonly: false, shell: false }]);
  const service = new PatchService(policy, options);
  return { root, policy, service, cleanup: async () => {
    vi.mocked(fs.open).mockImplementation(actual.open);
    vi.mocked(fs.rm).mockImplementation(actual.rm);
    vi.mocked(fs.lstat).mockImplementation(actual.lstat);
    vi.mocked(fs.link).mockImplementation(actual.link);
    vi.mocked(fs.rename).mockImplementation(actual.rename);
    await actual.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } };
}

describe.sequential("public patch persistence failures", () => {
  it.each(["add", "update"].flatMap(kind => ["atomic-save", "same-content", "changed-content", "mode", "mtime", "unchanged"].map(writer => ({ kind, writer }))))("preserves $writer file ownership during $kind rollback", async ({ kind, writer }) => {
    let external: Awaited<ReturnType<typeof actual.lstat>> | undefined;
    let externalText: string | undefined;
    const f = await fixture({ beforeInstall: async path => {
      if (path !== "second.txt") return;
      const target = join(f.root, "target.txt");
      const installed = await actual.lstat(target);
      if (writer === "atomic-save") {
        const replacement = join(f.root, "external-save.txt");
        await actual.writeFile(replacement, "updated\n", { flag: "wx" });
        await actual.rename(replacement, target);
        expect((await actual.lstat(target)).ino).not.toBe(installed.ino);
      } else if (writer === "same-content" || writer === "changed-content") {
        await actual.writeFile(target, writer === "same-content" ? "updated\n" : "changed\n");
        // Distinguish the real in-place write even on coarse timestamp hosts.
        await actual.utimes(target, new Date(2000), new Date(2000));
        expect((await actual.lstat(target)).ino).toBe(installed.ino);
      } else if (writer === "mode") {
        await actual.chmod(target, (installed.mode & 0o222) === 0 ? 0o666 : 0o444);
        expect((await actual.lstat(target)).mode & 0o7777).not.toBe(installed.mode & 0o7777);
      } else if (writer === "mtime") {
        await actual.utimes(target, new Date(2000), new Date(2000));
        expect((await actual.lstat(target)).mtimeMs).not.toBe(installed.mtimeMs);
      }
      external = await actual.lstat(target);
      externalText = await actual.readFile(target, "utf8");
      throw new Error("second install failed");
    } });
    const target = join(f.root, "target.txt");
    try {
      if (kind === "update") await actual.writeFile(target, "original\n");
      const change = kind === "add" ? "*** Add File: target.txt\n+updated" : "*** Update File: target.txt\n@@\n-original\n+updated";
      const error = await f.service.apply({ workspace_id: "patch", patch: `*** Begin Patch\n${change}\n*** Add File: second.txt\n+second\n*** End Patch\n` }).catch(error => error);
      expect(external).toBeDefined();
      if (writer === "unchanged") {
        expect(error).toMatchObject({ code: "patch_install_failed" });
        if (kind === "update") expect(await actual.readFile(target, "utf8")).toBe("original\n");
        else await expect(actual.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
        expect((await actual.readdir(f.root)).filter(name => name.includes(".runmesh-"))).toEqual([]);
      } else {
        expect(error).toMatchObject({ code: "patch_rollback_failed", details: { recovery: expect.arrayContaining([expect.objectContaining({ path: "target.txt" })]) } });
        expect(await actual.readFile(target, "utf8")).toBe(externalText);
        const retained = await actual.lstat(target);
        expect({ dev: retained.dev, ino: retained.ino, mode: retained.mode, size: retained.size, mtime: retained.mtimeMs })
          .toEqual({ dev: external!.dev, ino: external!.ino, mode: external!.mode, size: external!.size, mtime: external!.mtimeMs });
        if (kind === "update") {
          const recovery = error.details.recovery.find((entry: { backup_path?: string }) => entry.backup_path !== undefined);
          expect(recovery).toBeDefined();
          expect(await actual.readFile(recovery.backup_path, "utf8")).toBe("original\n");
        }
      }
      await expect(actual.lstat(join(f.root, "second.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await actual.chmod(target, 0o600).catch(() => undefined);
      await f.cleanup();
    }
  });

  it.each(["add", "update"])("rolls back %s after the installed staging link cannot be removed", async kind => {
    const f = await fixture();
    try {
      const path = join(f.root, "target.txt");
      if (kind === "update") await actual.writeFile(path, "original\n");
      let failed = false;
      vi.mocked(fs.rm).mockImplementation(async (path, options) => {
        if (!failed && String(path).endsWith(".tmp")) {
          failed = true;
          throw Object.assign(new Error("temporary file is busy"), { code: "EACCES" });
        }
        return actual.rm(path, options);
      });
      const patch = kind === "add" ? "*** Add File: target.txt\n+updated" : "*** Update File: target.txt\n@@\n-original\n+updated";
      await expect(f.service.apply({ workspace_id: "patch", patch: `*** Begin Patch\n${patch}\n*** End Patch\n` })).rejects.toMatchObject({ code: "patch_install_failed" });
      expect(failed).toBe(true);
      if (kind === "update") expect(await actual.readFile(path, "utf8")).toBe("original\n");
      else await expect(actual.readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await actual.readdir(f.root)).filter(name => name.includes(".runmesh-"))).toEqual([]);
    } finally { await f.cleanup(); }
  });

  it.each(["write", "chmod"])("removes an incomplete stage after %s fails", async operation => {
    const f = await fixture();
    try {
      let failed = false;
      vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
        const handle = await actual.open(path, flags, mode);
        if (!failed && String(path).endsWith(".tmp")) {
          failed = true;
          if (operation === "write") {
            const write = handle.writeFile.bind(handle);
            handle.writeFile = async () => {
              await write("partial");
              throw Object.assign(new Error("device is full"), { code: "ENOSPC" });
            };
          } else {
            handle.chmod = async () => { throw Object.assign(new Error("mode update failed"), { code: "EACCES" }); };
          }
        }
        return handle;
      });
      await expect(f.service.apply({ workspace_id: "patch", patch: "*** Begin Patch\n*** Add File: target.txt\n+updated\n*** End Patch\n" })).rejects.toMatchObject({ code: operation === "write" ? "ENOSPC" : "EACCES" });
      expect(failed).toBe(true);
      expect(await actual.readdir(f.root)).toEqual([]);
    } finally { await f.cleanup(); }
  });

  it.each(["ENOSPC", "EIO"])("preserves the original when staged file sync fails with %s", async code => {
    const f = await fixture();
    try {
      const target = join(f.root, "target.txt");
      await actual.writeFile(target, "original\n");
      let failed = false;
      vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
        const handle = await actual.open(path, flags, mode);
        if (String(path).endsWith(".tmp")) {
          handle.sync = async () => { failed = true; throw Object.assign(new Error("file sync failed"), { code }); };
        }
        return handle;
      });
      await expect(f.service.apply({ workspace_id: "patch", patch: "*** Begin Patch\n*** Update File: target.txt\n@@\n-original\n+updated\n*** End Patch\n" })).rejects.toMatchObject({ code });
      expect(failed).toBe(true);
      expect(await actual.readFile(target, "utf8")).toBe("original\n");
      expect(await actual.readdir(f.root)).toEqual(["target.txt"]);
    } finally { await f.cleanup(); }
  });

  it("restores the original when validation fails after the source was unlinked", async () => {
    const f = await fixture();
    try {
      const target = join(f.root, "target.txt");
      await actual.writeFile(target, "original\n");
      let unlinked = false;
      let failed = false;
      vi.mocked(fs.rm).mockImplementation(async (path, options) => {
        await actual.rm(path, options);
        if (String(path) === target) unlinked = true;
      });
      vi.mocked(fs.lstat).mockImplementation((...args) => {
        if (unlinked && !failed) {
          failed = true;
          return Promise.reject(Object.assign(new Error("validation I/O failed"), { code: "EIO" }));
        }
        return actual.lstat(...args);
      });
      await expect(f.service.apply({ workspace_id: "patch", patch: "*** Begin Patch\n*** Update File: target.txt\n@@\n-original\n+updated\n*** End Patch\n" })).rejects.toMatchObject({ code: "patch_install_failed" });
      expect(failed).toBe(true);
      expect(await actual.readFile(target, "utf8")).toBe("original\n");
      expect(await actual.readdir(f.root)).toEqual(["target.txt"]);
    } finally { await f.cleanup(); }
  });

  it.each(["backup-link", "source-unlink"])("retains recovery paths when policy changes after %s", async phase => {
    const f = await fixture();
    try {
      const target = join(f.root, "target.txt");
      await actual.writeFile(target, "original\n");
      let changed = false;
      vi.mocked(fs.link).mockImplementation(async (source, destination) => {
        await actual.link(source, destination);
        if (phase === "backup-link" && String(destination).endsWith(".bak")) { changed = true; f.policy.replace([]); }
      });
      vi.mocked(fs.rm).mockImplementation(async (path, options) => {
        await actual.rm(path, options);
        if (phase === "source-unlink" && String(path) === target) { changed = true; f.policy.replace([]); }
      });
      const error = await f.service.apply({ workspace_id: "patch", patch: "*** Begin Patch\n*** Update File: target.txt\n@@\n-original\n+updated\n*** End Patch\n" }).catch(error => error);
      expect(changed).toBe(true);
      expect(error).toMatchObject({ code: "patch_rollback_failed", details: { recovery: expect.arrayContaining([expect.objectContaining({ backup_path: expect.any(String) })]) } });
      const backup = error.details.recovery.find((entry: { backup_path?: string }) => entry.backup_path !== undefined).backup_path;
      expect(await actual.readFile(backup, "utf8")).toBe("original\n");
    } finally { await f.cleanup(); }
  });

  it("reports the retained stage when a failed write cannot be cleaned up", async () => {
    const f = await fixture();
    try {
      vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
        const handle = await actual.open(path, flags, mode);
        if (String(path).endsWith(".tmp")) {
          const write = handle.writeFile.bind(handle);
          handle.writeFile = async () => { await write("partial"); throw Object.assign(new Error("device is full"), { code: "ENOSPC" }); };
        }
        return handle;
      });
      vi.mocked(fs.rm).mockImplementation(async (path, options) => {
        if (String(path).endsWith(".tmp")) throw Object.assign(new Error("temporary file is busy"), { code: "EACCES" });
        await actual.rm(path, options);
      });
      const error = await f.service.apply({ workspace_id: "patch", patch: "*** Begin Patch\n*** Add File: target.txt\n+updated\n*** End Patch\n" }).catch(error => error);
      expect(error).toMatchObject({ code: "patch_rollback_failed", details: { install_error: "device is full", recovery: [expect.objectContaining({ temporary_path: expect.any(String), error: "temporary file is busy" })] } });
      expect(await actual.readFile(error.details.recovery[0].temporary_path, "utf8")).toBe("partial");
      await expect(actual.readFile(join(f.root, "target.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await f.cleanup(); }
  });

  it.each(["preparation", "before-commit", "installation"])("reports every retained stage after %s fails", async phase => {
    const f = await fixture({ beforeCommit: () => { if (phase === "before-commit") throw new Error("commit cancelled"); } });
    try {
      vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
        const handle = await actual.open(path, flags, mode);
        if (phase === "preparation" && String(path).includes("second.txt.runmesh-") && String(path).endsWith(".tmp")) {
          handle.writeFile = async () => { throw Object.assign(new Error("device is full"), { code: "ENOSPC" }); };
        }
        return handle;
      });
      vi.mocked(fs.rm).mockImplementation(async (path, options) => {
        if (String(path).endsWith(".tmp")) throw Object.assign(new Error("temporary file is busy"), { code: "EACCES" });
        await actual.rm(path, options);
      });
      const error = await f.service.apply({ workspace_id: "patch", patch: "*** Begin Patch\n*** Add File: first.txt\n+first\n*** Add File: second.txt\n+second\n*** End Patch\n" }).catch(error => error);
      expect(error).toMatchObject({ code: "patch_rollback_failed", details: { recovery: expect.any(Array) } });
      const stages = error.details.recovery.map((entry: { temporary_path?: string }) => entry.temporary_path).filter(Boolean);
      expect(stages).toHaveLength(2);
      expect(new Set(stages).size).toBe(2);
      expect((await actual.readdir(f.root)).sort()).toEqual(stages.map((path: string) => path.slice(f.root.length + 1)).sort());
    } finally { await f.cleanup(); }
  });

  it("preserves a concurrent writer created at the final backup restore syscall", async () => {
    const f = await fixture({ beforeInstall: path => { if (path === "second.txt") throw new Error("second install failed"); } });
    try {
      const target = join(f.root, "target.txt");
      await actual.writeFile(target, "original\n");
      let injected = false;
      const insertWriter = async (source: PathLike, destination: PathLike) => {
        if (!injected && String(source).endsWith(".bak") && String(destination) === target) {
          injected = true;
          await actual.writeFile(destination, "concurrent writer\n", { flag: "wx" });
        }
      };
      vi.mocked(fs.rename).mockImplementation(async (source, destination) => { await insertWriter(source, destination); await actual.rename(source, destination); });
      vi.mocked(fs.link).mockImplementation(async (source, destination) => { await insertWriter(source, destination); await actual.link(source, destination); });
      const error = await f.service.apply({ workspace_id: "patch", patch: "*** Begin Patch\n*** Update File: target.txt\n@@\n-original\n+updated\n*** Add File: second.txt\n+second\n*** End Patch\n" }).catch(error => error);
      expect(injected).toBe(true);
      expect(await actual.readFile(target, "utf8")).toBe("concurrent writer\n");
      expect(error).toMatchObject({ code: "patch_rollback_failed", details: { recovery: expect.arrayContaining([expect.objectContaining({ backup_path: expect.any(String) })]) } });
      const backup = error.details.recovery.find((entry: { backup_path?: string }) => entry.backup_path !== undefined).backup_path;
      expect(await actual.readFile(backup, "utf8")).toBe("original\n");
    } finally { await f.cleanup(); }
  });

  it.each(["validation", "unlink"])("retains the restored backup when cleanup %s fails", async phase => {
    const f = await fixture({ beforeInstall: path => { if (path === "second.txt") throw new Error("second install failed"); } });
    try {
      const target = join(f.root, "target.txt");
      await actual.writeFile(target, "original\n");
      let restored = false;
      let failed = false;
      vi.mocked(fs.link).mockImplementation(async (source, destination) => {
        await actual.link(source, destination);
        if (String(source).endsWith(".bak") && String(destination) === target) restored = true;
      });
      vi.mocked(fs.lstat).mockImplementation((...args) => {
        if (phase === "validation" && restored && !failed) {
          failed = true;
          return Promise.reject(Object.assign(new Error("validation I/O failed"), { code: "EIO" }));
        }
        return actual.lstat(...args);
      });
      vi.mocked(fs.rm).mockImplementation(async (path, options) => {
        if (phase === "unlink" && restored && String(path).endsWith(".bak")) {
          failed = true;
          throw Object.assign(new Error("backup is busy"), { code: "EACCES" });
        }
        await actual.rm(path, options);
      });
      const error = await f.service.apply({ workspace_id: "patch", patch: "*** Begin Patch\n*** Update File: target.txt\n@@\n-original\n+updated\n*** Add File: second.txt\n+second\n*** End Patch\n" }).catch(error => error);
      expect(restored && failed).toBe(true);
      expect(await actual.readFile(target, "utf8")).toBe("original\n");
      expect(error).toMatchObject({ code: "patch_rollback_failed", details: { recovery: expect.arrayContaining([expect.objectContaining({ backup_path: expect.any(String) })]) } });
      const backup = error.details.recovery.find((entry: { backup_path?: string }) => entry.backup_path !== undefined).backup_path;
      expect(await actual.readFile(backup, "utf8")).toBe("original\n");
    } finally { await f.cleanup(); }
  });
});
