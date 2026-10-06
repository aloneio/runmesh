import { expect, it } from "vitest";
import { renderService, serviceLayout, serviceProfilePath, type ServiceCommandExecutor, type ServicePlatform } from "../src/service.js";
import { managerInstall, managerUninstall, maintenanceManagerLayout, renderMaintenanceManager, type MaintenanceManagerFilesystem, type MaintenanceManagerFileStat, type MaintenanceManagerOptions } from "../src/updates/manager-install.js";

function fixture(platform: ServicePlatform) {
  const layout = serviceLayout({ platform, mode: "system" });
  const options: MaintenanceManagerOptions = { platform, mode: "system", profilePath: serviceProfilePath(layout), installRoot: layout.installRoot, uid: 0 };
  const paths = maintenanceManagerLayout(options);
  const files = new Map<string, string>();
  const stats = new Map<string, MaintenanceManagerFileStat>();
  const calls: string[][] = [];
  const copies: string[][] = [];
  let registered = false, active = false, failStart = false, supportsManager = true;
  const parents = (path: string) => {
    let parent = paths.path.dirname(path);
    while (true) {
      if (!stats.has(parent)) stats.set(parent, { directory: true, file: false, symlink: false, uid: 0, mode: 0o755 });
      const next = paths.path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  };
  const directory = (path: string, symlink = false) => { parents(path); stats.set(path, { directory: true, file: false, symlink, uid: 0, mode: 0o755 }); };
  const file = (path: string, content: string) => { parents(path); files.set(path, content); stats.set(path, { directory: false, file: true, symlink: false, uid: 0, mode: 0o600 }); };
  const version = paths.path.join(layout.installRoot, "versions", "0.1.7");
  const current = paths.path.join(layout.installRoot, "current");
  directory(layout.installRoot); directory(paths.path.join(layout.installRoot, "versions")); directory(version); directory(current, true);
  const manifest = renderService({ platform, mode: "system" });
  file(layout.manifestPath, manifest.content);
  file(options.profilePath, "existing credential profile");
  file(paths.path.join(version, "runtime", platform === "win32" ? "node.exe" : "node"), "runtime bytes");
  file(platform === "win32" ? paths.path.join(version, "runmesh.cjs") : paths.path.join(version, "lib", "node_modules", "@aloneio", "runmesh-runner", "dist", "runmesh.cjs"), "bundle bytes");
  for (const name of platform === "win32" ? ["runmesh.cmd", "runmesh-runner.cmd"] : ["bin/runmesh", "bin/runmesh-runner"]) file(paths.path.join(version, ...name.split("/")), "original launcher");
  const filesystem: MaintenanceManagerFilesystem = {
    read: async path => files.get(path), stat: async path => stats.get(path), realpath: async path => path === current ? version : path,
    mkdir: async path => { if (stats.has(path)) throw new Error("exists"); directory(path); },
    write: async (path, value) => { if (stats.has(path)) throw new Error("exists"); file(path, value); },
    copy: async (source, destination) => { copies.push([source, destination]); file(destination, files.get(source)!); },
    rename: async (source, destination) => {
      for (const path of [...stats.keys()]) if (path === source || path.startsWith(source + paths.path.sep)) {
        const target = destination + path.slice(source.length);
        stats.set(target, stats.get(path)!); stats.delete(path);
        if (files.has(path)) { files.set(target, files.get(path)!); files.delete(path); }
      }
    },
    remove: async root => { for (const path of [...stats.keys()]) if (path === root || path.startsWith(root + paths.path.sep)) { stats.delete(path); files.delete(path); } },
    chmod: async (path, mode) => { const value = stats.get(path)!; stats.set(path, { ...value, mode }); },
    symlink: async (source, destination) => { file(destination, files.get(source)!); stats.set(destination, { ...stats.get(destination)!, symlink: true }); },
  };
  const executor: ServiceCommandExecutor = { execute: async (name, args) => {
    calls.push([name, ...args]);
    if (args[1] === "--help") return { exitCode: 0, stdout: supportsManager ? "usage: runmesh <start|maintenance-agent|stop>" : "usage: runmesh <start|stop>" };
    if (name === "systemctl") {
      if (args.some(argument => argument.startsWith("--property=User,Group,FragmentPath,DropInPaths,NeedDaemonReload"))) return { exitCode: 0, stdout: `User=runmesh\nGroup=runmesh\nFragmentPath=${layout.manifestPath}\nDropInPaths=\nNeedDaemonReload=no\nRootDirectory=\nRootImage=\nBindPaths=\nBindReadOnlyPaths=\nTemporaryFileSystem=\nDynamicUser=no\n` };
      if (args.includes("daemon-reload")) registered = files.has(paths.manifestPath);
      if (args.includes("--property=LoadState")) return { exitCode: 0, stdout: registered ? "loaded\n" : "not-found\n" };
      if (args.includes("--property=ActiveState,MainPID")) return { exitCode: 0, stdout: `ActiveState=${active ? "active" : "inactive"}\nMainPID=${active ? 12 : 0}\n` };
      if (args.includes("enable")) { registered = true; active = true; }
      if (args.includes("disable")) active = false;
      if (args.includes("is-active") && failStart) return { exitCode: 1 };
    }
    if (name === "busctl") return { exitCode: 0, stdout: JSON.stringify({ type: "a(sasbttttuii)", data: [[layout.executablePath, [layout.executablePath, "start", "--profile", options.profilePath, "--state-dir", layout.stateRoot], false, 0, 0, 0, 0, 0, 0, 0]] }) };
    if (name === "launchctl") {
      if (args[0] === "print") return registered ? { exitCode: 0, stdout: "state = running\npid = 12\n" } : { exitCode: 113, stderr: "Could not find service" };
      if (args[0] === "bootstrap") { registered = true; active = true; }
      if (args[0] === "bootout") { registered = false; active = false; }
    }
    if (name === "ps") return active ? { exitCode: 0, stdout: "12\n" } : { exitCode: 1, stdout: "", stderr: "" };
    if (name === "powershell.exe" && args.at(-1)?.includes("[Console]::Write('present')")) return { exitCode: 0, stdout: registered ? "present" : "absent" };
    if (name === "powershell.exe" && args.at(-1)?.includes("$t.Stop(0)")) active = false;
    if (name === "schtasks") {
      if (args[0] === "/Create") registered = true;
      if (args[0] === "/Run") active = true;
      if (args[0] === "/Delete") registered = false;
    }
    return { exitCode: 0 };
  } };
  return { options: { ...options, filesystem, executor }, paths, calls, copies, files, stats, manifest,
    failStartup: () => { failStart = true; }, oldRunner: () => { supportsManager = false; }, isActive: () => active };
}

it.each(["linux", "darwin", "win32"] as const)("installs an independent %s manager without changing Runner identity, profile or current", async platform => {
  const test = fixture(platform);
  await managerInstall(test.options);
  expect(test.isActive()).toBe(true);
  expect(test.files.get(test.paths.runtimePath)).toBe("runtime bytes");
  expect(test.files.get(test.paths.bundlePath)).toBe("bundle bytes");
  expect(test.files.get(test.options.profilePath)).toBe("existing credential profile");
  expect(test.files.get(test.manifest.path)).toBe(test.manifest.content);
  expect(test.stats.get(test.paths.path.join(test.paths.layout.installRoot, "current"))?.symlink).toBe(true);
  const content = test.files.get(test.paths.manifestPath)!;
  expect(content).toContain("maintenance-agent");
  expect(content).toContain("--install-root");
  expect(content).not.toContain("existing credential profile");
  if (platform === "win32") expect(content).toContain("<UserId>SYSTEM</UserId>");
  else expect(content).not.toContain(platform === "linux" ? "User=runmesh" : "<key>UserName</key>");
  await managerInstall(test.options);
  expect(test.copies).toHaveLength(2); // Never replace a live manager with a new Runner target.
  await managerUninstall(test.options);
  expect(test.stats.has(test.paths.managerRoot)).toBe(false);
  expect(test.files.get(test.manifest.path)).toBe(test.manifest.content);
  expect(test.files.get(test.options.profilePath)).toBe("existing credential profile");
});

it("rolls back a failed new manager installation while retaining all Runner state", async () => {
  const test = fixture("linux");
  test.failStartup();
  await expect(managerInstall(test.options)).rejects.toThrow("maintenance manager command failed");
  expect(test.stats.has(test.paths.managerRoot)).toBe(false);
  expect(test.files.has(test.paths.manifestPath)).toBe(false);
  expect(test.files.get(test.manifest.path)).toBe(test.manifest.content);
  expect(test.files.get(test.options.profilePath)).toBe("existing credential profile");
  expect(test.files.get(test.paths.path.join(test.paths.layout.installRoot, "versions", "0.1.7", "bin", "runmesh"))).toBe("original launcher");
});

it("retains the stable management package across ordinary uninstall and reinstall of an older Runner", async () => {
  const test = fixture("linux"); await managerInstall(test.options);
  await managerUninstall({ ...test.options, preservePackage: true });
  expect(test.files.has(test.paths.manifestPath)).toBe(false); expect(test.files.has(test.paths.bundlePath)).toBe(true);
  test.oldRunner(); await managerInstall(test.options);
  expect(test.copies).toHaveLength(2); expect(test.isActive()).toBe(true);
  await managerUninstall({ ...test.options, preservePackage: true });
  await managerUninstall(test.options);
  expect(test.stats.has(test.paths.managerRoot)).toBe(false);
});

it("does not register maintenance for a custom Runner executable", async () => {
  const test = fixture("linux");
  test.files.set(test.manifest.path, renderService({ platform: "linux", executablePath: "/srv/custom/bin/runmesh" }).content);
  await expect(managerInstall(test.options)).resolves.toEqual({ enabled: false, reason: "custom_service_layout" });
  expect(test.copies).toEqual([]);
  expect(test.calls).toEqual([]);
});

it("keeps a custom job-state service operational but reports manual version management", async () => {
  const test = fixture("linux");
  test.files.set(test.manifest.path, renderService({ platform: "linux", stateDir: "/srv/custom/jobs" }).content);
  await expect(managerInstall(test.options)).resolves.toEqual({ enabled: false, reason: "custom_service_layout" });
  expect(test.copies).toEqual([]);
  expect(test.calls).toEqual([]);
});

it("rejects an unmanaged manager manifest before copying executable files", async () => {
  const test = fixture("linux");
  test.files.set(test.paths.manifestPath, "operator-owned unit");
  await expect(managerInstall(test.options)).rejects.toThrow("unmanaged maintenance service");
  expect(test.copies).toEqual([]);
});

it("refuses to copy an older current bundle that lacks maintenance-agent", async () => {
  const test = fixture("linux");
  test.oldRunner();
  await expect(managerInstall(test.options)).rejects.toThrow("does not support maintenance-agent");
  expect(test.copies).toEqual([]);
  expect(test.calls.some(call => call.includes("enable"))).toBe(false);
});

it("rejects a profile whose parent is writable by the dedicated Runner", async () => {
  const test = fixture("linux");
  test.stats.set(test.paths.layout.configRoot, { directory: true, file: false, symlink: false, uid: 0, mode: 0o770 });
  await expect(managerInstall(test.options)).rejects.toThrow("not owned exclusively");
  expect(test.copies).toEqual([]);
});

it("retains the stopped independent manager and its journal when an update needs recovery", async () => {
  const test = fixture("linux");
  await managerInstall(test.options);
  const stateDirectory = test.paths.path.join(test.paths.managerRoot, "state");
  await test.options.filesystem.mkdir(stateDirectory, 0o700);
  const journal = test.paths.path.join(stateDirectory, "active-operation.json");
  await test.options.filesystem.write(journal, JSON.stringify({ phase: "switching" }));
  await expect(managerUninstall(test.options)).rejects.toThrow("maintenance is unfinished");
  expect(test.isActive()).toBe(false);
  expect(test.files.has(test.paths.bundlePath)).toBe(true);
  expect(test.files.has(journal)).toBe(true);
  expect(test.files.get(test.options.profilePath)).toBe("existing credential profile");
});

it.each(["linux", "darwin", "win32"] as const)("keeps the %s user manager in the user's service domain", platform => {
  const layout = serviceLayout({ platform, mode: "user", home: platform === "win32" ? "C:\\Users\\fixture" : "/home/fixture" });
  const rendered = renderMaintenanceManager({ platform, mode: "user", profilePath: serviceProfilePath(layout), installRoot: layout.installRoot, home: platform === "win32" ? "C:\\Users\\fixture" : "/home/fixture" });
  expect(rendered.content).toContain("--user");
  expect(rendered.content).not.toContain("<UserId>SYSTEM</UserId>");
});
