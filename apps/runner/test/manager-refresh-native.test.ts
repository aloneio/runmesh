import { describe, expect, it } from "vitest";
import { posix, win32 } from "node:path";
import { ownedManifest } from "../src/services/manifest-ownership.js";
import {
  createManagerRefreshNativePort,
  validManagerRefreshNativeState,
  type ManagerRefreshNativeState,
} from "../src/updates/manager-refresh-native.js";

type HostLike = Parameters<typeof createManagerRefreshNativePort>[0];

function fakeHost(platform: "darwin" | "win32", body: string, execute: HostLike["executor"]["execute"]): HostLike {
  const path = platform === "darwin" ? posix : win32;
  const mode = "system" as const;
  const manifestPath = platform === "darwin" ? "/Library/LaunchDaemons/io.alone.runmesh.manager.plist" : "C:\\ProgramData\\Runmesh\\RunmeshManager.xml";
  const domain = "system";
  return {
    platform,
    mode,
    prefix: [],
    domain,
    target: `${domain}/io.alone.runmesh.manager`,
    manifestPath,
    path,
    executor: { execute },
    filesystem: {
      read: async pathName => pathName === manifestPath ? ownedManifest(body, platform, "maintenance").content : undefined,
      stat: async pathName => pathName === manifestPath ? { file: true, directory: false, symlink: false, uid: 0, mode: 0o600 } : undefined,
      createFile: async () => undefined,
      syncFile: async () => undefined,
      remove: async () => undefined,
    },
    trustedTreePath: async () => undefined,
  } as unknown as HostLike;
}

describe("manager refresh native state", () => {
  it("accepts a registered but idle launchd job", () => {
    const idle: ManagerRefreshNativeState = { registered: true, active: false, enabled: true, enablement: "enabled" };
    expect(validManagerRefreshNativeState(idle, "darwin")).toBe(true);
    expect(validManagerRefreshNativeState({ ...idle, active: true, registered: false }, "darwin")).toBe(false);
  });

  it("accepts a disabled running Windows task for recovery", () => {
    expect(validManagerRefreshNativeState({ registered: true, active: true, enabled: false, enablement: "disabled" }, "win32")).toBe(true);
    expect(validManagerRefreshNativeState({ registered: true, active: false, enabled: true, enablement: "enabled-runtime" }, "win32")).toBe(false);
  });

  it("rejects native state objects with unknown fields", () => {
    expect(validManagerRefreshNativeState({ registered: true, active: false, enabled: true, enablement: "enabled", extra: true }, "darwin")).toBe(false);
  });

  it("binds Windows SYSTEM ownership to the COM logon enum", async () => {
    const body = "<Task><Principals><Principal id=\"Author\"><UserId>SYSTEM</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals><Actions Context=\"Author\"><Exec><Command>C:\\\\Node.exe</Command><Arguments>--manager</Arguments></Exec></Actions></Task>\n";
    const calls: string[] = [];
    const host = fakeHost("win32", body, async (_file, args) => {
      calls.push(args.join(" "));
      return { exitCode: 0, stdout: JSON.stringify({ definition: ["1", "Exec", "c:\\\\node.exe", "--manager", "", "1", "true", "S-1-5-18", "", "5", "HighestAvailable"], caller_sid: "S-1-5-21-1", enabled: false, state: 1, instances: 1 }) };
    });
    let guardCalls = 0;
    const port = createManagerRefreshNativePort(host, () => { guardCalls += 1; });
    await expect(port.snapshot()).resolves.toMatchObject({ registered: true, active: true, enabled: false, enablement: "disabled" });
    expect(guardCalls).toBeGreaterThan(4);
    expect(calls.some(call => call.includes("Definition.Principal.LogonType"))).toBe(true);
    expect(calls.some(call => call.includes("ServiceAccount"))).toBe(false);
  });

  it("retains a loaded idle launchd registration as inactive", async () => {
    const body = "<plist><dict><key>ProgramArguments</key><array><string>/usr/bin/node</string><string>--manager</string></array></dict></plist>\n";
    const host = fakeHost("darwin", body, async (file, args) => {
      if (file === "launchctl" && args[0] === "print-disabled") return { exitCode: 0, stdout: '{"io.alone.runmesh.manager" => false}' };
      return { exitCode: 0, stdout: "path = /Library/LaunchDaemons/io.alone.runmesh.manager.plist\nprogram = /usr/bin/node\narguments = {\n/usr/bin/node\n--manager\n}\nstate = waiting\n" };
    });
    await expect(createManagerRefreshNativePort(host, () => undefined).snapshot()).resolves.toEqual({ registered: true, active: false, enabled: true, enablement: "enabled" });
  });

  it("stops an externally started Windows task when restoring an inactive state", async () => {
    const body = "<Task><Principals><Principal id=\"Author\"><UserId>SYSTEM</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals><Actions Context=\"Author\"><Exec><Command>C:\\Node.exe</Command><Arguments>--manager</Arguments></Exec></Actions></Task>\n";
    let enabled = true, instances = 1;
    const host = fakeHost("win32", body, async (_file, args) => {
      const script = args.at(-1) ?? "";
      if (script.includes("$t.Enabled=$false")) enabled = false;
      if (script.includes("$t.Enabled=$true")) enabled = true;
      if (script.includes("$t.Stop(0)")) instances = 0;
      const state = instances > 0 ? (enabled ? 4 : 1) : (enabled ? 3 : 1);
      return { exitCode: 0, stdout: JSON.stringify({ definition: ["1", "Exec", "c:\\node.exe", "--manager", "", "1", "true", "S-1-5-18", "", "5", "HighestAvailable"], caller_sid: "S-1-5-21-1", enabled, state, instances }) };
    });
    const inactive: ManagerRefreshNativeState = { registered: true, active: false, enabled: true, enablement: "enabled" };
    await expect(createManagerRefreshNativePort(host, () => undefined).restore(inactive)).resolves.toBeUndefined();
    await expect(createManagerRefreshNativePort(host, () => undefined).snapshot()).resolves.toEqual(inactive);
  });

  it("restores a registered idle launchd job without waiting for a process", async () => {
    const body = "<plist><dict><key>ProgramArguments</key><array><string>/usr/bin/node</string><string>--manager</string></array></dict></plist>\n";
    const host = fakeHost("darwin", body, async (file, args) => {
      if (file === "launchctl" && args[0] === "print-disabled") return { exitCode: 0, stdout: '{"io.alone.runmesh.manager" => false}' };
      if (file === "launchctl" && args[0] === "print") return { exitCode: 0, stdout: "path = /Library/LaunchDaemons/io.alone.runmesh.manager.plist\nprogram = /usr/bin/node\narguments = {\n/usr/bin/node\n--manager\n}\nstate = waiting\n" };
      return { exitCode: 0, stdout: "" };
    });
    const state: ManagerRefreshNativeState = { registered: true, active: false, enabled: true, enablement: "enabled" };
    await expect(createManagerRefreshNativePort(host, () => undefined).restore(state)).resolves.toBeUndefined();
  });
});
