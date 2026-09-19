import { mkdtemp, mkdir, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { JobManager } from "../src/jobs.js";
import { PathPolicy } from "../src/path-policy.js";
import { nativeJobFiles } from "../src/jobs/storage.js";
import { nativeJobProcesses } from "../src/jobs/process.js";

it.each(["symlink", "replacement"])("revalidates the cwd identity after launch preparation (%s)", async kind => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "runmesh-cwd-race-")));
  const root = join(base, "workspace"), cwd = join(root, "cwd"), outside = join(base, "outside");
  await mkdir(root); await mkdir(cwd); await mkdir(outside);
  let swapped = false;
  const spawn = vi.fn<typeof nativeJobProcesses.spawn>(() => { throw new Error("unsafe spawn reached"); });
  const manager = new JobManager({ stateDir: join(base, "state"), policy: new PathPolicy([{ workspaceId: "w", rootPath: root, readonly: false, shell: false }]) }, {
    files: { ...nativeJobFiles, async openJobLog(path, mode) {
      if (mode === "append" && !swapped) {
        swapped = true; await rename(cwd, join(root, "held"));
        if (kind === "symlink") await symlink(outside, cwd, "junction"); else await mkdir(cwd);
      }
      return nativeJobFiles.openJobLog(path, mode);
    } },
    processes: { ...nativeJobProcesses, spawn },
  });
  try {
    await manager.initialize();
    await expect(manager.start({ workspace_id: "w", cwd: "cwd", command: [process.execPath, "-e", ""] })).rejects.toMatchObject({ code: kind === "symlink" ? "symlink_escape" : "path_changed" });
    expect(swapped).toBe(true); expect(spawn).not.toHaveBeenCalled();
    expect(manager.list()).toMatchObject([{ status: "failed", pid: null }]);
  } finally { await manager.flushPersistence(); await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});
