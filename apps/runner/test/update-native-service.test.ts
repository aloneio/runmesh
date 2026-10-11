import { expect, it } from "vitest";
import { createServiceManager, renderService, serviceLayout, serviceProfilePath, type ServiceCommandExecutor } from "../src/service.js";
import { createNativeServiceMaintenance, hasStandardEffectiveMaintenanceLaunch, hasStandardMaintenanceLaunch, type NativeServiceMaintenanceOptions } from "../src/updates/native-service.js";

const linuxArguments = ["/opt/runmesh/current/bin/runmesh", "start", "--profile", "/etc/runmesh/profile.json", "--state-dir", "/var/lib/runmesh"];
const effectiveProperties = "--property=User,Group,FragmentPath,DropInPaths,NeedDaemonReload,RootDirectory,RootImage,BindPaths,BindReadOnlyPaths,TemporaryFileSystem,DynamicUser,MountImages,ExtensionImages,ExtensionDirectories";
const linuxMetadata = (overrides: Record<string, string> = {}) => Object.entries({ User: "runmesh", Group: "runmesh", FragmentPath: "/etc/systemd/system/runmesh-runner.service", DropInPaths: "", NeedDaemonReload: "no", RootDirectory: "", RootImage: "", BindPaths: "", BindReadOnlyPaths: "", TemporaryFileSystem: "", DynamicUser: "no", MountImages: "", ExtensionImages: "", ExtensionDirectories: "", ...overrides }).map(([name, value]) => `${name}=${value}`).join("\n");
const linuxExecStart = (args: readonly string[] = linuxArguments, path = args[0]) => JSON.stringify({ type: "a(sasbttttuii)", data: [[path, args, false, 0, 0, 0, 0, 0, 0, 0]] });

function options(platform: "linux" | "darwin" | "win32", executor: ServiceCommandExecutor): NativeServiceMaintenanceOptions {
  const layout = serviceLayout({ platform, mode: "system" });
  const manifest = renderService({ platform, mode: "system" });
  const records = new Map<string, string>();
  return { platform, mode: "system", profilePath: serviceProfilePath(layout), installRoot: layout.installRoot, executor,
    stopRecoveryFilesystem: {
      read: async path => records.get(path),
      create: async (path, text) => { if (records.has(path)) throw new Error("record exists"); records.set(path, text); },
      sync: async () => undefined,
      remove: async path => { records.delete(path); },
    },
    filesystem: { read: async path => path === manifest.path ? manifest.content : undefined } };
}

it.each(["enabled", "enabled-runtime", "disabled"])("stops a Linux Runner and restores its exact %s enablement", async original => {
  let enablement = original, active = true;
  const calls: string[][] = [];
  const port = createNativeServiceMaintenance(options("linux", { execute: async (file, args) => {
    calls.push([file, ...args]);
    if (args.includes(effectiveProperties)) return { exitCode: 0, stdout: linuxMetadata() };
    if (file === "busctl") return { exitCode: 0, stdout: linuxExecStart() };
    if (args.includes("show")) return { exitCode: 0, stdout: `LoadState=loaded\nActiveState=${active ? "active" : "inactive"}\nMainPID=${active ? 42 : 0}\nUnitFileState=${enablement}\n` };
    if (args.includes("disable")) enablement = "disabled";
    if (args.includes("stop")) active = false;
    if (args.includes("start")) active = true;
    if (args.includes("enable")) enablement = args.includes("--runtime") ? "enabled-runtime" : "enabled";
    return { exitCode: 0 };
  } }));
  const snapshot = await port.snapshot();
  expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  await port.stop();
  expect(active).toBe(false);
  expect(enablement).toBe("disabled");
  const beforeStart = calls.slice();
  if (original === "disabled") expect(beforeStart.some(call => call.includes("disable"))).toBe(false);
  else expect(beforeStart.findIndex(call => call.includes("disable"))).toBeLessThan(beforeStart.findIndex(call => call.includes("stop")));
  await port.start();
  await port.restoreEnabled(snapshot);
  expect(active).toBe(true);
  expect(enablement).toBe(original);
});

it("does not permit a Linux switch while the old MainPID remains alive", async () => {
  let time = 0;
  const port = createNativeServiceMaintenance({ ...options("linux", { execute: async (file, args) => {
    if (args.includes(effectiveProperties)) return { exitCode: 0, stdout: linuxMetadata() };
    if (file === "busctl") return { exitCode: 0, stdout: linuxExecStart() };
    return args.includes("show") ? { exitCode: 0, stdout: "LoadState=loaded\nActiveState=inactive\nMainPID=99\nUnitFileState=disabled\n" } : { exitCode: 0 };
  } }),
    now: () => time, delay: async ms => { time += ms; } });
  await expect(port.stop()).rejects.toThrow("did not stop");
});

const effectiveMismatches: { name: string; args?: string[]; metadata?: Record<string, string>; path?: string }[] = [
  { name: "state-directory override", args: [...linuxArguments.slice(0, -1), "/srv/runmesh-state"] },
  { name: "profile override", args: [linuxArguments[0]!, "start", "--profile", "/srv/profile.json", "--state-dir", "/var/lib/runmesh"] },
  { name: "executable override", path: "/srv/custom/runmesh" },
  { name: "effective user override", metadata: { User: "root" } },
  { name: "effective group override", metadata: { Group: "root" } },
  { name: "different unit fragment", metadata: { FragmentPath: "/run/systemd/system/runmesh-runner.service" } },
  { name: "definition awaiting reload", metadata: { NeedDaemonReload: "yes" } },
  { name: "ambiguous joined argv", args: [...linuxArguments.slice(0, -2), "--state-dir /var/lib/runmesh"] },
  ...["RootDirectory", "RootImage", "BindPaths", "BindReadOnlyPaths", "TemporaryFileSystem", "MountImages", "ExtensionImages", "ExtensionDirectories"].map(property => ({ name: `${property} filesystem override`, metadata: { [property]: "/srv/custom-root" } })),
  { name: "dynamic service account", metadata: { DynamicUser: "yes" } },
];
it.each(effectiveMismatches)("rejects a $name before stopping the managed Runner", async mismatch => {
  const calls: string[][] = [];
  const port = createNativeServiceMaintenance(options("linux", { execute: async (file, args) => {
    calls.push([file, ...args]);
    if (args.includes(effectiveProperties)) return { exitCode: 0, stdout: linuxMetadata({ DropInPaths: "/etc/systemd/system/runmesh-runner.service.d/override.conf", ...mismatch.metadata }) };
    if (file === "busctl") return { exitCode: 0, stdout: linuxExecStart(mismatch.args, mismatch.path) };
    throw new Error("unexpected native service command");
  } }));
  await expect(port.stop()).rejects.toThrow("effective service definition");
  expect(calls.some(call => call.includes("disable") || call.includes("stop") || call.includes("start"))).toBe(false);
});

it("accepts resource-only drop-ins when their effective launch and identity still match", async () => {
  const base = options("linux", { execute: async (file, args) => args.includes(effectiveProperties)
    ? { exitCode: 0, stdout: linuxMetadata({ DropInPaths: "/etc/systemd/system/runmesh-runner.service.d/resources.conf" }) }
    : { exitCode: file === "busctl" ? 0 : 1, stdout: linuxExecStart() } });
  await expect(hasStandardEffectiveMaintenanceLaunch(renderService({ platform: "linux" }).content, base)).resolves.toBe(true);
});

it("preserves spaced Linux user paths through the exact native argument array", async () => {
  const home = "/home/Runner One";
  const layout = serviceLayout({ platform: "linux", mode: "user", home });
  const profilePath = serviceProfilePath(layout);
  const manifest = renderService({ platform: "linux", mode: "user", home });
  const args = [layout.executablePath, "start", "--user", "--profile", profilePath, "--state-dir", layout.stateRoot];
  const calls: string[][] = [];
  await expect(hasStandardEffectiveMaintenanceLaunch(manifest.content, { platform: "linux", mode: "user", home, uid: 1000,
    installRoot: layout.installRoot, profilePath, executor: { execute: async (file, invocation) => {
      calls.push([file, ...invocation]);
      return invocation.includes(effectiveProperties) ? { exitCode: 0, stdout: linuxMetadata({ User: "", Group: "", FragmentPath: layout.manifestPath }) }
        : { exitCode: file === "busctl" ? 0 : 1, stdout: linuxExecStart(args) };
    } } })).resolves.toBe(true);
  expect(calls.find(call => call[0] === "busctl")).toContain("--address=unix:path=/run/user/1000/bus");
});

it("rejects a definition that changes between effective metadata and argument reads", async () => {
  let reads = 0;
  const base = options("linux", { execute: async (file, args) => {
    if (args.includes(effectiveProperties)) return { exitCode: 0, stdout: linuxMetadata(++reads === 1 ? {} : { User: "root" }) };
    return { exitCode: file === "busctl" ? 0 : 1, stdout: linuxExecStart() };
  } });
  await expect(hasStandardEffectiveMaintenanceLaunch(renderService({ platform: "linux" }).content, base)).resolves.toBe(false);
});

it("fails closed when exact native argument inspection is unavailable", async () => {
  const base = options("linux", { execute: async (_file, args) => args.includes(effectiveProperties)
    ? { exitCode: 0, stdout: linuxMetadata() } : { exitCode: 127 } });
  await expect(hasStandardEffectiveMaintenanceLaunch(renderService({ platform: "linux" }).content, base)).resolves.toBe(false);
});

it("unloads a macOS KeepAlive job and proves its old PID exited before switching", async () => {
  let loaded = true, enabled = true, oldPidAlive = true, livePid = 123;
  const calls: string[][] = [];
  let time = 0;
  const port = createNativeServiceMaintenance({ ...options("darwin", { execute: async (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === "print-disabled") return { exitCode: 0, stdout: `{ "io.alone.runmesh.runner" => ${!enabled} }` };
    if (args[0] === "print") return loaded ? { exitCode: 0, stdout: `state = running\npid = ${livePid}\n` } : { exitCode: 113, stderr: "Could not find service" };
    if (args[0] === "disable") enabled = false;
    if (args[0] === "enable") enabled = true;
    if (args[0] === "bootout") loaded = false;
    if (args[0] === "bootstrap") { loaded = true; livePid = 456; oldPidAlive = true; }
    if (file === "ps") return oldPidAlive ? { exitCode: 0, stdout: `${livePid}\n` } : { exitCode: 1, stdout: "", stderr: "" };
    return { exitCode: 0 };
  } }), now: () => time, delay: async ms => { time += ms; oldPidAlive = false; } });
  const snapshot = await port.snapshot();
  await port.stop();
  expect(time).toBe(100);
  expect(enabled).toBe(false);
  expect(calls.findIndex(call => call.includes("disable"))).toBeLessThan(calls.findIndex(call => call.includes("bootout")));
  await port.start();
  await port.restoreEnabled(snapshot);
  expect(loaded).toBe(true);
  expect(enabled).toBe(true);
  expect(calls.some(call => call.includes("kill"))).toBe(false);
  await port.stop(); // A rollback must wait for the candidate, not the original PID.
  expect(calls.filter(call => call[0] === "ps").at(-1)).toEqual(["ps", "-p", "456", "-o", "pid="]);
});

it.each([
  { enabled: false, active: false, state: 1 },
  { enabled: true, active: false, state: 3 },
  { enabled: false, active: true, state: 4 },
  { enabled: true, active: true, state: 4 },
])("reports Windows task enablement independently from activity: $enabled / $active", async initial => {
  let statusScript = "";
  const manager = createServiceManager({ platform: "win32", mode: "system", executor: { execute: async (file, args) => {
    if (file === "powershell.exe") {
      statusScript = args.at(-1) ?? "";
      return { exitCode: 0, stdout: JSON.stringify({ found: true, enabled: initial.enabled, state: initial.state, identity: "NT AUTHORITY\\LOCAL SERVICE" }) };
    }
    expect(file).toBe("schtasks");
    expect(args).toEqual(["/Query", "/TN", "RunmeshRunner"]);
    return { exitCode: 0 };
  } } });
  await expect(manager.status?.(renderService({ platform: "win32" }))).resolves.toMatchObject({
    installed: true, registered: true, reliable: true, enabled: initial.enabled, active: initial.active,
  });
  expect(statusScript).toContain("enabled=[bool]$task.Enabled");
});

it.each([undefined, "false", 0])("leaves legacy Windows enablement unknown when the probe returns %s", async enabled => {
  const manager = createServiceManager({ platform: "win32", executor: { execute: async file => file === "powershell.exe"
    ? { exitCode: 0, stdout: JSON.stringify({ found: true, state: 4, enabled }) }
    : { exitCode: 0 } } });
  const status = await manager.status?.(renderService({ platform: "win32" }));
  expect(status).toMatchObject({ installed: true, active: true, reliable: true });
  expect(status).not.toHaveProperty("enabled");
});

it.each([false, true])("disables a Windows task without changing its running state: %s", async active => {
  const state = { enabled: true, active };
  const calls: string[][] = [];
  const manager = createServiceManager({ platform: "win32", executor: { execute: async (file, args) => {
    calls.push([file, ...args]);
    if (file === "schtasks" && args[0] === "/Change" && args.includes("/DISABLE")) state.enabled = false;
    else throw new Error(`unexpected native operation: ${file} ${args.join(" ")}`);
    return { exitCode: 0 };
  } } });
  await manager.disable!(renderService({ platform: "win32" }));
  expect(state).toEqual({ enabled: false, active });
  expect(calls).toEqual([["schtasks", "/Change", "/TN", "RunmeshRunner", "/DISABLE"]]);
});

it("reports Windows disable failures so rollback cannot claim restored enablement", async () => {
  const manager = createServiceManager({ platform: "win32", executor: { execute: async () => ({ exitCode: 1, stderr: "fixture disable failure" }) } });
  await expect(manager.disable!(renderService({ platform: "win32" }))).rejects.toThrow("fixture disable failure");
});

it("disables a Windows task before stopping and restores an originally disabled task", async () => {
  let enabled = false, active = true;
  const calls: string[][] = [];
  const port = createNativeServiceMaintenance(options("win32", { execute: async (file, args) => {
    calls.push([file, ...args]);
    const script = args.at(-1) ?? "";
    if (script.includes("found=$true")) return { exitCode: 0, stdout: JSON.stringify({ found: true, enabled, state: active ? 4 : enabled ? 3 : 1, instances: active ? 1 : 0 }) };
    if (script.includes("$t.Enabled=$false")) enabled = false;
    if (script.includes("$t.Enabled=$true")) enabled = true;
    if (args[0] === "/End") { expect(enabled).toBe(false); active = false; }
    if (args[0] === "/Run") { expect(enabled).toBe(true); active = true; }
    if (script.includes("Write-Output 'stopped'")) return { exitCode: 0, stdout: "stopped\r\n" };
    return { exitCode: 0 };
  } }));
  const snapshot = await port.snapshot();
  await port.stop();
  expect(active).toBe(false);
  await port.start();
  await port.restoreEnabled(snapshot);
  expect(active).toBe(true);
  expect(enabled).toBe(false);
  expect(calls.some(call => call.includes("/Delete"))).toBe(false);
});

it("retains a macOS process across failed stop attempts and adapter recreation", async () => {
  let loaded = true, queryFails = true, alive = true, time = 0;
  const calls: string[][] = [];
  const base = { ...options("darwin", { execute: async (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === "print-disabled") return { exitCode: 0, stdout: '{ "io.alone.runmesh.runner" => true }' };
    if (args[0] === "print") return loaded ? { exitCode: 0, stdout: "state = running\npid = 123\n" } : { exitCode: 113, stderr: "Could not find service" };
    if (args[0] === "bootout") loaded = false;
    if (file === "ps") return queryFails ? { exitCode: 2, stderr: "process query failed" } : alive ? { exitCode: 0, stdout: "123\n" } : { exitCode: 1 };
    return { exitCode: 0 };
  } }), now: () => time, delay: async (ms: number) => { time += ms; } };
  await expect(createNativeServiceMaintenance(base).stop()).rejects.toThrow("process exit could not be confirmed");
  queryFails = false;
  await expect(createNativeServiceMaintenance(base).stop()).rejects.toThrow("did not stop");
  expect(calls.filter(call => call.includes("bootout"))).toHaveLength(1);
  alive = false;
  await createNativeServiceMaintenance(base).stop();
  expect(calls.filter(call => call[0] === "ps").at(-1)).toEqual(["ps", "-p", "123", "-o", "pid="]);
});

it("recovers a retained purge stop before enabling a macOS Runner", async () => {
  let alive = true, time = 0;
  const calls: string[][] = [];
  const base = { ...options("darwin", { execute: async (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === "print") return { exitCode: 113, stderr: "Could not find service" };
    if (file === "ps") return alive ? { exitCode: 0, stdout: "123" } : { exitCode: 1 };
    return { exitCode: 0 };
  } }), now: () => time, delay: async (ms: number) => { time += ms; } };
  const path = `${serviceLayout({ platform: "darwin", mode: "system" }).manifestPath}.purge-stop.json`;
  await base.stopRecoveryFilesystem!.create(path, JSON.stringify({ schema_version: 1, target: "system/io.alone.runmesh.runner", mode: "system", pid: 123 }));
  await expect(createNativeServiceMaintenance(base).start()).rejects.toThrow("did not stop");
  expect(calls.some(call => call.includes("enable") || call.includes("bootstrap"))).toBe(false);
  alive = false;
  await createNativeServiceMaintenance(base).start();
  expect(await base.stopRecoveryFilesystem!.read(path)).toBeUndefined();
  expect(calls.filter(call => call.includes("bootstrap"))).toHaveLength(1);
});

it("rejects unknown and custom service ownership before a stop command", async () => {
  const calls: unknown[] = [];
  const base = options("linux", { execute: async (...args) => { calls.push(args); return { exitCode: 0 }; } });
  const port = createNativeServiceMaintenance({ ...base, filesystem: { read: async () => renderService({ platform: "linux", executablePath: "/srv/custom/runmesh" }).content } });
  await expect(port.stop()).rejects.toThrow("standard current executable");
  expect(calls).toEqual([]);
  expect(() => createNativeServiceMaintenance({ ...base, installRoot: "/tmp/runmesh" })).toThrow("standard managed installation root");
});

it.each(["linux", "darwin", "win32"] as const)("validates the actual %s profile and job-state arguments before allowing maintenance", platform => {
  const base = options(platform, { execute: async () => ({ exitCode: 0 }) });
  expect(hasStandardMaintenanceLaunch(renderService({ platform }).content, base)).toBe(true);
  const otherState = platform === "win32" ? "C:\\Custom\\jobs" : "/srv/custom/jobs";
  expect(hasStandardMaintenanceLaunch(renderService({ platform, stateDir: otherState }).content, base)).toBe(false);
  const otherProfile = platform === "win32" ? "C:\\Custom\\profile.json" : "/srv/custom/profile.json";
  expect(hasStandardMaintenanceLaunch(renderService({ platform, profilePath: otherProfile }).content, base)).toBe(false);
});
