import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, readdir, readlink, realpath, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { purgeInstallation, purgeLayout, hostPurgeFilesystem, type PurgeFilesystem } from "../src/purge.js";
import { runCli } from "../src/cli.js";
import { ProfileStore } from "../src/profile.js";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runmesh-purge-test-")));
  const path = (p: string) => join(root, p.replace(/^\//, ""));
  const logical = (p: string) => "/" + relative(root, p);
  const changes: string[] = []; const calls: string[][] = []; const mounts: string[] = []; let failStop = false;
  const filesystem: PurgeFilesystem = {
    stat: (p) => hostPurgeFilesystem.stat(path(p)), canonical: async (p) => logical(await realpath(path(p))), list: (p) => readdir(path(p)),
    text: (p, limit) => hostPurgeFilesystem.text(path(p), limit),
    link: async (p) => { const t = await readlink(path(p)); return t.startsWith(root) ? logical(t) : t; },
    file: async (p) => { changes.push(p); await unlink(path(p)); }, directory: async (p) => { changes.push(p); await rmdir(path(p)); }, mounts: async () => mounts,
  };
  const executor = { execute: vi.fn(async (file: string, args: readonly string[]) => {
    calls.push([file, ...args]);
    if (failStop && args.includes("stop")) return { exitCode: 1, stderr: "synthetic failure" };
    if (args.includes("--property=ActiveState")) return { exitCode: 0, stdout: "inactive\n" };
    if (args.includes("--property=LoadState")) return { exitCode: 0, stdout: "not-found\n" };
    return { exitCode: 0, stdout: "LoadState=loaded\nActiveState=inactive\nExecStart={ path=/opt/runmesh/current/bin/runmesh ; }\n" };
  }) };
  async function file(p: string, content = "synthetic") { await mkdir(dirname(path(p)), { recursive: true }); await writeFile(path(p), content); }
  async function link(p: string, target: string) { await mkdir(dirname(path(p)), { recursive: true }); await symlink(target.startsWith("/") ? path(target) : target, path(p)); }
  async function installed() {
    for (const dir of purgeLayout("linux", "system").directories) await file(dir + "/leftover");
    await file("/opt/runmesh/versions/0.1.0-dev.4/bin/runmesh"); await file("/opt/runmesh/versions/dev.5.staging.1/.partial");
    await file("/opt/runmesh/.refresh.lock/marker"); await link("/opt/runmesh/current", "versions/0.1.0-dev.4");
    await file("/etc/systemd/system/runmesh-runner.service", "[Service]\nExecStart=/opt/runmesh/current/bin/runmesh\n");
    await file("/etc/systemd/system/runmesh-runner.service.d/override.conf");
    await link("/etc/systemd/system/multi-user.target.wants/runmesh-runner.service", "/etc/systemd/system/runmesh-runner.service");
    await link("/usr/local/bin/runmesh", "/opt/runmesh/current/bin/runmesh"); await file("/run/systemd/system/.keep");
    await file("/home/operator/project/database.sql", "preserve-project"); await file("/etc/systemd/system/unrelated.service", "preserve-service");
  }
  return { root, path, file, link, installed, filesystem, executor, changes, calls, mounts, stopFails: () => { failStop = true; }, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe.skipIf(process.platform === "win32")("complete purge in synthetic filesystem", () => {
  it("removes runtime remnants but preserves projects and other services; repeating is safe", async () => {
    const f = await fixture();
    try {
      await f.installed(); const result = await purgeInstallation({ platform: "linux", filesystem: f.filesystem, executor: f.executor });
      expect(result.failures).toEqual([]); expect(result.purged).toBe(true);
      for (const path of purgeLayout("linux", "system").directories) expect(await f.filesystem.stat(path)).toBeUndefined();
      expect(await f.filesystem.stat("/usr/local/bin/runmesh")).toBeUndefined();
      expect(await readFile(f.path("/home/operator/project/database.sql"), "utf8")).toBe("preserve-project");
      expect(await readFile(f.path("/etc/systemd/system/unrelated.service"), "utf8")).toBe("preserve-service");
      expect(f.calls).toContainEqual(["systemctl", "daemon-reload"]); expect(f.calls).toContainEqual(["systemctl", "reset-failed", "runmesh-runner.service"]);
      expect(f.changes.at(-1)).toBe("/opt/runmesh");
      const again = await purgeInstallation({ platform: "linux", filesystem: f.filesystem, executor: f.executor });
      expect(again.purged).toBe(true); expect(again.removed).toEqual([]);
    } finally { await f.cleanup(); }
  });
  it("handles corrupt profile without loading credentials", async () => {
    const f = await fixture();
    try { await f.file("/etc/runmesh/profile.json", "{corrupt"); expect((await purgeInstallation({ platform: "linux", filesystem: f.filesystem, executor: f.executor })).purged).toBe(true); }
    finally { await f.cleanup(); }
  });
  it("unlinks installation symlinks without deleting external targets", async () => {
    const f = await fixture();
    try {
      await f.file("/projects/keep/important", "keep"); await f.link("/opt/runmesh", "/projects/keep");
      expect((await purgeInstallation({ platform: "linux", filesystem: f.filesystem, executor: f.executor })).purged).toBe(true);
      expect(await readFile(f.path("/projects/keep/important"), "utf8")).toBe("keep");
    } finally { await f.cleanup(); }
  });
  it.each(["foreign-unit", "mounted-data", "workspace", "symlink-parent", "stop-failure"])("retains data for %s", async (failure) => {
    const f = await fixture();
    try {
      await f.installed();
      if (failure === "foreign-unit") await f.file("/etc/systemd/system/runmesh-runner.service", "[Service]\nExecStart=/usr/bin/unrelated\n");
      if (failure === "mounted-data") f.mounts.push("/var/lib/runmesh/data");
      if (failure === "workspace") await f.file("/var/lib/runmesh/policy/active-policy.json", JSON.stringify({ workspaces: [{ root_path: "/opt/runmesh/my-project" }] }));
      if (failure === "symlink-parent") { await rm(f.path("/var/log"), { recursive: true }); await f.link("/var/log", "/home/operator/project"); }
      if (failure === "stop-failure") f.stopFails();
      const result = await purgeInstallation({ platform: "linux", filesystem: f.filesystem, executor: f.executor });
      expect(result.purged).toBe(false); expect(result.failures.length).toBeGreaterThan(0); expect(f.changes).toEqual([]);
      expect(await f.filesystem.stat("/opt/runmesh")).toBeDefined();
    } finally { await f.cleanup(); }
  });
  it("reports failed removal rather than success and retains maintenance CLI", async () => {
    const f = await fixture();
    try {
      await f.installed(); const io = { ...f.filesystem, file: async (p: string) => { if (p === "/var/log/runmesh/leftover") throw new Error("EACCES synthetic"); await f.filesystem.file(p); } };
      const result = await purgeInstallation({ platform: "linux", filesystem: io, executor: f.executor });
      expect(result.purged).toBe(false); expect(result.failures.some((e) => e.reason.includes("EACCES"))).toBe(true);
      expect(await f.filesystem.stat("/opt/runmesh")).toBeDefined();
    } finally { await f.cleanup(); }
  });
});

it("requires confirmation and routes canonical purge without loading profile", async () => {
  const store = new ProfileStore({ filePath: "/etc/runmesh/profile.json", platform: "linux" });
  const read = vi.spyOn(store, "load").mockRejectedValue(new Error("profile must not be loaded"));
  const purge = vi.fn(async () => ({ action: "uninstall" as const, purged: true, removed: [], absent: [], failures: [], preserved: [] }));
  const output: string[] = [];
  const deps = { store, servicePlatform: "linux" as const, purgeInstallation: purge, isAdministrator: () => true, stdout: (s: string) => output.push(s) };
  await expect(runCli(["uninstall", "--purge"], deps)).rejects.toThrow("--yes"); expect(purge).not.toHaveBeenCalled();
  await runCli(["uninstall", "--purge", "--yes", "--json"], deps); expect(read).not.toHaveBeenCalled(); expect(purge).toHaveBeenCalledOnce(); expect(JSON.parse(output[0]!)).toMatchObject({ purged: true });
  read.mockRestore();
});

it.skipIf(process.platform !== "linux")("pins cleanup enumeration when the directory path is replaced", async () => {
  const { rename } = await import("node:fs/promises");
  const f = await fixture();
  try {
    await f.file("/safe/inside", "inside"); await f.file("/outside/keep", "outside");
    const original = f.path("/safe"); const expected = (await hostPurgeFilesystem.stat(original))!;
    await hostPurgeFilesystem.withDirectory!(original, expected, async (anchor) => {
      await rename(original, f.path("/old-safe")); await symlink(f.path("/outside"), original);
      expect(await hostPurgeFilesystem.list(anchor)).toEqual(["inside"]);
      await hostPurgeFilesystem.file(join(anchor, "inside"));
    });
    expect(await readFile(f.path("/outside/keep"), "utf8")).toBe("outside");
  } finally { await f.cleanup(); }
});
