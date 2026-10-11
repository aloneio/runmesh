import type { Stats } from "node:fs";
import { dirname, join, parse, sep } from "node:path";
import { expect, it } from "vitest";
import { purgeInstallation, purgeLayout, type PurgeFilesystem } from "../src/purge.js";
import { currentServicePlatform, renderService, serviceProfilePath } from "../src/service.js";
import { runMaintenanceCli } from "../src/maintenance-cli.js";
import type { MaintenanceManagerInstaller } from "../src/updates/manager-install.js";

function memoryHost(withManifest = true) {
  const platform = currentServicePlatform(); const layout = purgeLayout(platform, "system");
  const entries = new Map<string, { ino: number; dir: boolean; text: string }>(); let index = 1; let native = true;
  const task = { stops: true };
  const calls: string[][] = [];
  function dir(path: string) {
    if (entries.has(path)) return;
    if (dirname(path) !== path) dir(dirname(path));
    entries.set(path, { ino: index++, dir: true, text: "" });
  }
  function file(path: string, text = "fixture") { dir(dirname(path)); entries.set(path, { ino: index++, dir: false, text }); }
  for (const path of layout.directories) { dir(path); file(path + sep + "fixture"); }
  if (withManifest) file(layout.manifestPath, renderService({ platform, mode: "system", executionMode: "privileged_host" }).content);
  if (platform === "linux") dir("/run/systemd/system");
  const io: PurgeFilesystem = {
    stat: async (path) => {
      const e = entries.get(path); if (!e) return undefined;
      return { dev: 1, ino: e.ino, mode: e.dir ? 0o40755 : 0o100644, uid: 0, isDirectory: () => e.dir, isFile: () => !e.dir, isSymbolicLink: () => false } as unknown as Stats;
    },
    canonical: async (path) => path,
    list: async (path) => [...entries.keys()].filter((p) => p !== path && dirname(p) === path).map((p) => p.slice(path.length + (path.endsWith(sep) ? 0 : 1))),
    text: async (path) => entries.get(path)?.text,
    link: async () => { throw new Error("unexpected link"); },
    file: async (path) => { entries.delete(path); },
    directory: async (path) => {
      if ([...entries.keys()].some((p) => p !== path && dirname(p) === path)) throw new Error("directory not empty");
      entries.delete(path);
    },
    mounts: async () => [],
  };
  const executor = { execute: async (program: string, args: readonly string[]) => {
    calls.push([program, ...args]);
    if (program === "powershell.exe") {
      if (args.at(-1)?.includes("GetInstances(0)")) return task.stops ? { exitCode: 0, stdout: "stopped" } : { exitCode: 1, stderr: "Runner task is still active" };
      return { exitCode: 0, stdout: native ? "present" : "absent" };
    }
    if (program === "schtasks" && args.includes("/End") && !task.stops) return { exitCode: 1 };
    if (program === "schtasks") { if (args.includes("/Delete")) native = false; return { exitCode: 0, stdout: layout.installRoot }; }
    if (program === "launchctl") { if (args[0] === "bootout") { native = false; return { exitCode: 0 }; } return { exitCode: native ? 0 : 113, stdout: layout.installRoot }; }
    if (args.includes("--property=ActiveState")) return { exitCode: 0, stdout: "inactive" };
    if (args.includes("--property=LoadState")) return { exitCode: 0, stdout: "not-found" };
    return { exitCode: 0, stdout: "LoadState=loaded\nActiveState=inactive\nExecStart=path=" + (withManifest ? layout.installRoot + "/bin/runmesh" : "/unrelated/service") };
  } };
  return { platform, layout, entries, io, executor, calls, task, file, dir };
}

function policy(host: ReturnType<typeof memoryHost>, roots: string[], name = "active-policy.json") {
  host.file(join(host.layout.stateRoot, "policy", name), JSON.stringify({ workspaces: roots.map(root_path => ({ root_path })) }));
}

function uninstallHost(host: ReturnType<typeof memoryHost>, maintenanceManager: MaintenanceManagerInstaller) {
  return runMaintenanceCli(["uninstall", "--purge", "--yes", "--json"], {
    store: { filePath: serviceProfilePath(host.layout), load: async () => { throw new Error("unexpected profile read"); },
      save: async () => { throw new Error("unexpected profile write"); }, remove: async () => { throw new Error("unexpected profile removal"); }, assertServiceOwnership: async () => undefined },
    isAdministrator: () => true, servicePlatform: host.platform, stdout: () => undefined, maintenanceManager,
    purgeInstallation: options => purgeInstallation({ ...options, filesystem: host.io, executor: host.executor }),
  });
}

it.each(["workspace", "mount", "foreign-manifest"])("keeps the manager registered when CLI purge preflight rejects %s", async failure => {
  const host = memoryHost();
  if (failure === "workspace") policy(host, [host.layout.installRoot]);
  if (failure === "mount") host.io.mounts = async () => [join(host.layout.stateRoot, "mounted-data")];
  if (failure === "foreign-manifest") host.file(host.layout.manifestPath, "unrelated service");
  const before = [...host.entries]; let managerInstalled = true;
  await expect(uninstallHost(host, { install: async () => undefined, uninstall: async () => { managerInstalled = false; } })).rejects.toThrow("uninstall incomplete");
  expect(managerInstalled).toBe(true);
  expect([...host.entries]).toEqual(before); expect(host.calls).toEqual([]);
});

it("awaits manager removal before CLI purge changes the Runner installation", async () => {
  const host = memoryHost(), before = [...host.entries]; let managerRemoved = false;
  const execute = host.executor.execute;
  host.executor.execute = async (...args) => { expect(managerRemoved).toBe(true); return execute(...args); };
  await uninstallHost(host, { install: async () => undefined, uninstall: async options => {
    expect([...host.entries]).toEqual(before); expect(host.calls).toEqual([]);
    expect(options.preservePackage).toBe(true);
    await Promise.resolve(); managerRemoved = true;
  } });
  expect(managerRemoved).toBe(true); expect(host.entries.has(host.layout.installRoot)).toBe(false);
});

it("keeps Runner files and services when the manager requires recovery", async () => {
  const host = memoryHost(), before = [...host.entries];
  await expect(uninstallHost(host, { install: async () => undefined, uninstall: async () => { throw new Error("maintenance is unfinished"); } })).rejects.toThrow("maintenance is unfinished");
  expect([...host.entries]).toEqual(before); expect(host.calls).toEqual([]);
});

it.each(["policy", "mount", "manifest"])("rechecks %s after the manager has stopped", async change => {
  const host = memoryHost(); policy(host, [parse(host.layout.installRoot).root]);
  let afterStop: typeof host.entries;
  await expect(uninstallHost(host, { install: async () => undefined, uninstall: async () => {
    if (change === "policy") policy(host, [host.layout.installRoot], "previous-policy.json");
    if (change === "mount") host.io.mounts = async () => [join(host.layout.stateRoot, "mounted-data")];
    if (change === "manifest") host.file(host.layout.manifestPath, "unrelated service");
    afterStop = new Map(host.entries);
  } })).rejects.toThrow("uninstall incomplete");
  expect(host.entries).toEqual(afterStop!); expect(host.calls).toEqual([]);
});

it.each(["policy", "mount"])("rechecks %s received while the Runner was stopping", async change => {
  const host = memoryHost(); policy(host, [parse(host.layout.installRoot).root]);
  let afterChange: typeof host.entries | undefined;
  const execute = host.executor.execute;
  host.executor.execute = async (...args) => {
    const result = await execute(...args);
    if (!afterChange) {
      if (change === "policy") policy(host, [host.layout.installRoot]);
      if (change === "mount") host.io.mounts = async () => [join(host.layout.stateRoot, "mounted-data")];
      afterChange = new Map(host.entries);
    }
    return result;
  };
  await expect(uninstallHost(host, { install: async () => undefined, uninstall: async () => undefined })).rejects.toThrow("uninstall incomplete");
  expect(afterChange).toBeDefined(); expect(host.entries).toEqual(afterChange);
});

it("cleans the current native layout with injected OS adapters", async () => {
  const host = memoryHost();
  const result = await purgeInstallation({ platform: host.platform, filesystem: host.io, executor: host.executor });
  expect(result.failures).toEqual([]); expect(result.purged).toBe(true);
  for (const root of host.layout.directories) expect(host.entries.has(root)).toBe(false);
  expect(host.entries.has(host.layout.manifestPath)).toBe(false);
});
it("does not stop an unrecognized native service when the manifest is missing", async () => {
  const host = memoryHost(false);
  policy(host, [parse(host.layout.installRoot).root]);
  const result = await purgeInstallation({ platform: host.platform, filesystem: host.io, executor: host.executor });
  expect(result.purged).toBe(false);
  expect(host.entries.has(host.layout.installRoot)).toBe(true);
  expect(host.calls.every((call) => !call.some((arg) => ["stop", "bootout", "/End", "/Delete"].includes(arg)))).toBe(true);
});

it.skipIf(process.platform !== "win32")("retains the Windows task and installation when its process cannot be stopped", async () => {
  const host = memoryHost(); host.task.stops = false;
  policy(host, [parse(host.layout.installRoot).root]);
  const result = await purgeInstallation({ platform: host.platform, filesystem: host.io, executor: host.executor });
  expect(result.purged).toBe(false);
  expect(result.failures).toEqual([expect.objectContaining({ reason: "Runner task could not be confirmed stopped" })]);
  for (const root of host.layout.directories) expect(host.entries.has(root)).toBe(true);
  expect(host.entries.has(host.layout.manifestPath)).toBe(true);
  expect(host.calls.some(call => call.includes("/Delete"))).toBe(false);
});

it.each(["active-policy.json", "previous-policy.json"])("cleans only owned native paths with a filesystem-root workspace in %s", async name => {
  const host = memoryHost(), root = parse(host.layout.installRoot).root;
  const project = join(root, "unrelated-project", "keep.txt");
  const otherService = join(dirname(host.platform === "win32" ? host.layout.configRoot : host.layout.manifestPath), "unrelated-service.fixture");
  host.file(project, "keep-project"); host.file(otherService, "keep-service");
  policy(host, [root], name);
  const before = new Map(host.entries);
  const result = await purgeInstallation({ platform: host.platform, filesystem: host.io, executor: host.executor });
  expect(result.failures).toEqual([]); expect(result.purged).toBe(true);
  for (const directory of host.layout.directories) expect(host.entries.has(directory)).toBe(false);
  expect(host.entries.has(host.layout.manifestPath)).toBe(false);
  for (const [path, entry] of before) {
    const owned = path === host.layout.manifestPath || host.layout.directories.some(directory => path === directory || path.startsWith(directory + sep));
    if (!owned) expect(host.entries.get(path)).toEqual(entry);
  }
  expect(host.entries.get(project)?.text).toBe("keep-project"); expect(host.entries.get(otherService)?.text).toBe("keep-service");
  const again = await purgeInstallation({ platform: host.platform, filesystem: host.io, executor: host.executor });
  expect(again.purged).toBe(true); expect(again.removed).toEqual([]);
});

it.each(["ancestor", "same", "inside"])("preserves a concrete %s workspace alongside a root access scope", async kind => {
  const host = memoryHost(), install = host.layout.installRoot;
  const workspace = kind === "ancestor" ? dirname(install) : kind === "same" ? install : join(install, "project");
  host.dir(workspace); policy(host, [parse(install).root]); policy(host, [workspace], "previous-policy.json");
  const before = [...host.entries];
  const result = await purgeInstallation({ platform: host.platform, filesystem: host.io, executor: host.executor });
  expect(result.purged).toBe(false);
  expect(result.failures.some(item => item.reason.includes("overlaps a configured workspace"))).toBe(true);
  expect([...host.entries]).toEqual(before); expect(host.calls).toEqual([]);
});

it.each(["outside", "inside"])("preserves the lexical identity of a root alias %s the installation", async location => {
  const host = memoryHost(), root = parse(host.layout.installRoot).root;
  const alias = join(location === "inside" ? host.layout.installRoot : root, "root-access-alias");
  host.dir(alias); policy(host, [alias]);
  const io = { ...host.io, canonical: async (path: string) => path === alias ? root : host.io.canonical(path) };
  const before = [...host.entries];
  const result = await purgeInstallation({ platform: host.platform, filesystem: io, executor: host.executor });
  expect(result.purged).toBe(location === "outside");
  if (location === "inside") {
    expect(result.failures.some(item => item.reason.includes("overlaps a configured workspace"))).toBe(true);
    expect([...host.entries]).toEqual(before); expect(host.calls).toEqual([]);
  } else expect(host.entries.has(alias)).toBe(true);
});

it("requires canonical lookup even for a filesystem-root workspace", async () => {
  const host = memoryHost(), root = parse(host.layout.installRoot).root;
  policy(host, [root]);
  const before = [...host.entries];
  const io = { ...host.io, canonical: async (path: string) => {
    if (path === root) throw new Error("workspace root lookup unavailable");
    return host.io.canonical(path);
  } };
  const result = await purgeInstallation({ platform: host.platform, filesystem: io, executor: host.executor });
  expect(result.purged).toBe(false);
  expect(result.failures.some(item => item.reason === "workspace root lookup unavailable")).toBe(true);
  expect([...host.entries]).toEqual(before); expect(host.calls).toEqual([]);
});

it("retains mounted data with a filesystem-root workspace", async () => {
  const host = memoryHost(); policy(host, [parse(host.layout.installRoot).root]);
  const before = [...host.entries];
  const io = { ...host.io, mounts: async () => [join(host.layout.stateRoot, "mounted-data")] };
  const result = await purgeInstallation({ platform: host.platform, filesystem: io, executor: host.executor });
  expect(result.purged).toBe(false);
  expect(result.failures.some(item => item.reason.includes("mounted filesystem"))).toBe(true);
  expect([...host.entries]).toEqual(before); expect(host.calls).toEqual([]);
});
