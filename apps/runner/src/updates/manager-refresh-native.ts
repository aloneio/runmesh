import { setTimeout as delay } from "node:timers/promises";
import type { ServiceCommandExecutor } from "../service.js";
import { parseOwnedManifest } from "../services/manifest-ownership.js";
import { nativeProbeReliable } from "../services/probes.js";
import { createLaunchdStopRecovery } from "../services/launchd-stop.js";
import type { managerHost } from "./manager-install.js";

export interface ManagerRefreshNativeState {
  readonly registered: boolean;
  readonly active: boolean;
  readonly enabled: boolean;
  readonly enablement: "enabled" | "enabled-runtime" | "disabled";
}
export interface ManagerRefreshNativePort {
  snapshot(): Promise<ManagerRefreshNativeState>;
  stop(): Promise<void>;
  restore(state: ManagerRefreshNativeState): Promise<void>;
}
type Host = ReturnType<typeof managerHost>;
class NativeStateUnsettled extends Error {}

export function validManagerRefreshNativeState(value: unknown, platform: string): value is ManagerRefreshNativeState {
  if (!["linux", "darwin", "win32"].includes(platform)) return false;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return Object.keys(state).every(key => ["registered", "active", "enabled", "enablement"].includes(key))
    && typeof state.registered === "boolean" && typeof state.active === "boolean" && typeof state.enabled === "boolean"
    && ["enabled", "disabled", ...(platform === "linux" ? ["enabled-runtime"] : [])].includes(String(state.enablement))
    && state.enabled === (state.enablement !== "disabled") && (!state.active || state.registered)
    && (platform === "darwin" ? true : state.registered === true);
}

function xmlText(value: string): string {
  return value.replace(/&([^;]+);/gu, (_match, entity: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (named[entity] !== undefined) return named[entity];
    const numeric = /^#x([0-9a-f]+)$/iu.exec(entity) ?? /^#(\d+)$/u.exec(entity);
    if (numeric === null) throw new Error("Manager service definition contains an unsupported XML entity.");
    return String.fromCodePoint(Number.parseInt(numeric[1]!, entity.startsWith("#x") ? 16 : 10));
  });
}
function xmlElement(body: string, name: string, optional = false): string {
  const matches = [...body.matchAll(new RegExp(`<${name}>([^<]*)<\\/${name}>`, "gu"))];
  if (optional && matches.length === 0) return "";
  if (matches.length !== 1) throw new Error("Manager service definition has an unexpected command shape.");
  return xmlText(matches[0]![1]!);
}
function systemdArgument(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (character === "%") { if (value[++index] !== "%") throw new Error("Manager service contains a dynamic argument."); result += "%"; }
    else if (character === "\\") {
      const escaped = value[++index];
      if (escaped === "x" && /^[0-9a-f]{2}$/iu.test(value.slice(index + 1, index + 3))) { result += String.fromCharCode(Number.parseInt(value.slice(index + 1, index + 3), 16)); index += 2; }
      else if (escaped === "\\" || escaped === '"') result += escaped;
      else throw new Error("Manager service contains an unsupported argument escape.");
    } else result += character;
  }
  return result;
}

const WINDOWS_QUERY = "$ErrorActionPreference='Stop'; $s=New-Object -ComObject Schedule.Service; $s.Connect(); $t=$s.GetFolder('\\').GetTask('RunmeshManager'); "
  + "[xml]$d=$t.Xml; $a=@($d.Task.Actions.ChildNodes | Where-Object {$_.NodeType -eq [Xml.XmlNodeType]::Element}); $p=@($d.Task.Principals.Principal); "
  + "$sid=''; if($p.Count -eq 1 -and [string]$p[0].UserId -ne '') { $id=[string]$p[0].UserId; if($id -match '^S-1-') {$sid=$id} else {$sid=([Security.Principal.NTAccount]$id).Translate([Security.Principal.SecurityIdentifier]).Value} }; "
  + "$v=@([string]$a.Count,[string]$a[0].LocalName,([string]$a[0].Command).ToLowerInvariant(),[string]$a[0].Arguments,[string]$a[0].WorkingDirectory,[string]$p.Count,"
  + "([string]([string]$d.Task.Actions.Context -eq [string]$p[0].id)).ToLowerInvariant(),$sid,[string]$p[0].GroupId,[string][int]$t.Definition.Principal.LogonType,[string]$p[0].RunLevel); ";

/** Native mutations share the installer's lease, including every awaited helper step. */
export function createManagerRefreshNativePort(host: Host, guard: () => void): ManagerRefreshNativePort {
  const { platform, prefix, target, domain, manifestPath } = host;
  const executor: ServiceCommandExecutor = { execute: async (file, args) => {
    guard(); const result = await host.executor.execute(file, args); guard(); return result;
  } };
  const command = async (file: string, args: readonly string[]) => {
    const result = await executor.execute(file, args);
    if (result.exitCode !== 0) throw new Error(`Manager native command failed: ${file} ${args[0] ?? ""}`);
    return result;
  };
  const powershell = (script: string) => command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  const manifest = async () => {
    guard(); await host.trustedTreePath(manifestPath, "file", host.path.dirname(manifestPath)); guard();
    const content = await host.filesystem.read(manifestPath); guard();
    const parsed = content === undefined ? undefined : parseOwnedManifest(content, "maintenance");
    if (parsed === undefined || parsed === null) throw new Error("Manager service definition requires inspection.");
    return { content: content!, body: parsed.body };
  };
  const wait = async (observe: () => Promise<boolean>) => {
    const deadline = performance.now() + 5_000;
    while (true) {
      try { if (await observe()) return; } catch (error) { if (!(error instanceof NativeStateUnsettled)) throw error; }
      guard(); if (performance.now() >= deadline) throw new Error("Manager service state was not restored before the native deadline.");
      await delay(100); guard();
    }
  };

  const linux = async (allowTransition = false): Promise<ManagerRefreshNativeState> => {
    const owned = await manifest();
    const requiredProperties = ["LoadState", "ActiveState", "MainPID", "UnitFileState", "User", "Group", "FragmentPath", "DropInPaths", "NeedDaemonReload", "RootDirectory", "RootImage", "BindPaths", "BindReadOnlyPaths", "TemporaryFileSystem", "DynamicUser"];
    const namespaceProperties = ["RootDirectory", "RootImage", "BindPaths", "BindReadOnlyPaths", "TemporaryFileSystem", "MountImages", "ExtensionImages", "ExtensionDirectories"];
    const properties = [...requiredProperties, "MountImages", "ExtensionImages", "ExtensionDirectories"];
    const metadata = async () => {
      const response = await command("systemctl", [...prefix, "show", "runmesh-manager.service", `--property=${properties.join(",")}`]);
      const fields = new Map<string, string>();
      for (const line of (response.stdout ?? "").split(/\r?\n/u).filter(Boolean)) {
        const at = line.indexOf("=");
        if (at < 1 || fields.has(line.slice(0, at))) throw new Error("Manager systemd metadata is invalid.");
        fields.set(line.slice(0, at), line.slice(at + 1));
      }
      if (requiredProperties.some(key => !fields.has(key))) throw new Error("Manager systemd metadata is incomplete.");
      return fields;
    };
    const before = await metadata();
    if (before.get("LoadState") !== "loaded" || before.get("FragmentPath") !== manifestPath || before.get("NeedDaemonReload") !== "no"
      || before.get("DropInPaths") !== "" || before.get("DynamicUser") !== "no"
      || namespaceProperties.some(key => (before.get(key) ?? "") !== "")) throw new Error("Manager effective systemd definition differs from its managed service.");
    for (const property of ["User", "Group"]) {
      const declarations = [...owned.body.matchAll(new RegExp(`^${property}=([^\\r\\n]*)\\r?$`, "gmu"))];
      if (declarations.length > 1 || before.get(property) !== (declarations[0]?.[1] ?? "")) throw new Error("Manager effective systemd identity differs from its managed service.");
    }
    const starts = [...owned.body.matchAll(/^ExecStart=([^\r\n]+)\r?$/gmu)];
    if (starts.length !== 1) throw new Error("Manager service command is invalid.");
    const expected = starts[0]![1]!.split(/[ \t]+/u).map(systemdArgument);
    const uid = domain.startsWith("gui/") ? domain.slice(4) : undefined;
    if (host.mode === "user" && (uid === undefined || !/^\d+$/u.test(uid) || !Number.isSafeInteger(Number(uid)))) throw new Error("Manager user service requires its owning UID.");
    const bus = host.mode === "user" ? ["--user", `--address=unix:path=/run/user/${uid}/bus`] : ["--system"];
    const response = await command("busctl", [...bus, "--json=short", "get-property", "org.freedesktop.systemd1", "/org/freedesktop/systemd1/unit/runmesh_2dmanager_2eservice", "org.freedesktop.systemd1.Service", "ExecStart"]);
    const value = JSON.parse(response.stdout ?? "") as { type?: unknown; data?: unknown };
    const launch = Array.isArray(value.data) && value.data.length === 1 ? value.data[0] : undefined;
    if (value.type !== "a(sasbttttuii)" || !Array.isArray(launch) || launch.length !== 10 || launch[0] !== expected[0] || launch[2] !== false
      || !Array.isArray(launch[1]) || launch[1].length !== expected.length || launch[1].some((arg: unknown, index: number) => arg !== expected[index])) throw new Error("Manager effective systemd command differs from its managed service.");
    const after = await metadata();
    if (properties.filter(key => !["ActiveState", "MainPID"].includes(key)).some(key => before.get(key) !== after.get(key)) || (await manifest()).content !== owned.content) throw new Error("Manager effective service changed during inspection.");
    const enablement = after.get("UnitFileState"), state = after.get("ActiveState"), pid = after.get("MainPID");
    if (!["enabled", "enabled-runtime", "disabled"].includes(enablement ?? "") || !["active", "inactive", "failed", "activating", "deactivating", "reloading"].includes(state ?? "") || !/^\d+$/u.test(pid ?? "")) throw new Error("Manager process state is unsettled.");
    if (allowTransition && ["activating", "deactivating", "reloading"].includes(state!)) throw new NativeStateUnsettled("Manager systemd state is transitioning.");
    if ((state === "active") !== (Number(pid) > 0)) {
      if (allowTransition) throw new NativeStateUnsettled("Manager systemd process state is transitioning.");
      throw new Error("Manager process state is unsettled.");
    }
    return { registered: true, active: state === "active", enabled: enablement !== "disabled", enablement: enablement as ManagerRefreshNativeState["enablement"] };
  };

  const macLoaded = async () => {
    const owned = await manifest(), result = await executor.execute("launchctl", ["print", target]);
    if (!nativeProbeReliable(result, "query")) throw new Error("Manager launchd registration requires inspection.");
    if (result.exitCode === 0) {
      const output = result.stdout ?? "", expected = [...(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u.exec(owned.body)?.[1] ?? "").matchAll(/<string>([^<]*)<\/string>/gu)].map(match => xmlText(match[1]!));
      const printed = /^[\t ]*arguments[\t ]*=[\t ]*\{\r?\n([\s\S]*?)^[\t ]*\}/mu.exec(output)?.[1];
      const argumentsList = printed?.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
      if (expected.length === 0 || /^[\t ]*path[\t ]*=[\t ]*([^\r\n]+)$/mu.exec(output)?.[1]?.trim() !== manifestPath
        || /^[\t ]*program[\t ]*=[\t ]*([^\r\n]+)$/mu.exec(output)?.[1]?.trim() !== expected[0]
        || argumentsList === undefined || argumentsList.length !== expected.length || argumentsList.some((value, index) => value !== expected[index])) throw new Error("Manager effective launchd command differs from its managed service.");
    }
    if ((await manifest()).content !== owned.content) throw new Error("Manager launchd definition changed during inspection.");
    return result;
  };
  const macSnapshot = async (allowTransition = false): Promise<ManagerRefreshNativeState> => {
    const loaded = await macLoaded(), disabled = await command("launchctl", ["print-disabled", domain]);
    if (!(disabled.stdout ?? "").includes("{")) throw new Error("Manager enablement requires inspection.");
    const enabled = /"io\.alone\.runmesh\.manager"\s*=>\s*(true|false)/u.exec(disabled.stdout ?? "")?.[1] !== "true";
    const active = loaded.exitCode === 0 && /\bstate\s*=\s*running\b/u.test(loaded.stdout ?? "");
    if (active && !/\bpid\s*=\s*[1-9]\d*\b/u.test(loaded.stdout ?? "")) {
      if (allowTransition) throw new NativeStateUnsettled("Manager launchd process is starting.");
      throw new Error("Manager process identity requires inspection.");
    }
    if (allowTransition && loaded.exitCode === 0 && !active && /\bstate\s*=\s*(?:starting|spawn(?:ed|ing)?|throttled)\b/iu.test(loaded.stdout ?? "")) {
      throw new NativeStateUnsettled("Manager launchd state is transitioning.");
    }
    return { registered: loaded.exitCode === 0, active, enabled, enablement: enabled ? "enabled" : "disabled" };
  };

  const windows = async (allowTransition = false) => {
    const owned = await manifest();
    const result = await powershell(WINDOWS_QUERY + "@{definition=$v;caller_sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;enabled=[bool]$t.Enabled;state=[int]$t.State;instances=[int]($t.GetInstances(0)).Count}|ConvertTo-Json -Compress");
    const value = JSON.parse(result.stdout ?? "") as { definition?: unknown; caller_sid?: unknown; enabled?: unknown; state?: unknown; instances?: unknown };
    const expected = ["1", "Exec", xmlElement(owned.body, "Command").toLowerCase(), xmlElement(owned.body, "Arguments"), xmlElement(owned.body, "WorkingDirectory", true), "1", "true",
      host.mode === "system" ? "S-1-5-18" : value.caller_sid, "", host.mode === "system" ? "5" : "3", xmlElement(owned.body, "RunLevel")];
    if (typeof value.caller_sid !== "string" || !/^S-1-/u.test(value.caller_sid) || !Array.isArray(value.definition) || value.definition.length !== expected.length
      || value.definition.some((part, index) => part !== expected[index])) throw new Error("Manager effective task definition differs from its managed service.");
    if ((await manifest()).content !== owned.content) throw new Error("Manager task definition changed during inspection.");
    if (typeof value.enabled !== "boolean" || !Number.isInteger(value.state) || !Number.isInteger(value.instances) || Number(value.instances) < 0
      || ![1, 2, 3, 4].includes(Number(value.state)) || (Number(value.instances) > 0 ? !(value.state === 4 || value.state === 1 && !value.enabled) : value.state === 4)) throw new Error("Manager task process state is unsettled.");
    if (allowTransition && Number(value.state) === 2) throw new NativeStateUnsettled("Manager task state is queued.");
    if (!allowTransition && Number(value.state) === 2) throw new Error("Manager task process state is unsettled.");
    const state: ManagerRefreshNativeState = { registered: true, active: Number(value.instances) > 0, enabled: value.enabled, enablement: value.enabled ? "enabled" : "disabled" };
    return { state, definition: expected as string[] };
  };
  const windowsChange = async (suffix: string) => {
    const observed = await windows();
    const expected = Buffer.from(JSON.stringify(observed.definition)).toString("base64");
    await powershell(WINDOWS_QUERY + `$expected=@(ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${expected}')))); if($v.Count -ne $expected.Count) {throw 'Manager task definition changed'}; for($i=0;$i -lt $v.Count;$i++) {if(-not [String]::Equals($v[$i],$expected[$i],[StringComparison]::Ordinal)) {throw 'Manager task definition changed'}}; ` + suffix);
  };

  const stopRecovery = createLaunchdStopRecovery({ executor: { execute: async (file, args) => {
    if (file === "launchctl" && args[0] === "print" && args[1] === target) return macLoaded();
    return executor.execute(file, args);
  } }, target, mode: host.mode, manifestPath, filesystem: {
    read: async path => { guard(); if (await host.filesystem.stat(path) === undefined) { guard(); return undefined; } guard(); await host.trustedTreePath(path, "file", host.path.dirname(manifestPath)); guard(); const result = await host.filesystem.read(path); guard(); return result; },
    create: async (path, text) => { guard(); if (host.filesystem.createFile === undefined) throw new Error("Manager stop requires durable recovery-record support."); await host.filesystem.createFile(path, text); guard(); },
    sync: async path => { guard(); if (host.filesystem.syncFile === undefined) throw new Error("Manager stop requires durable recovery-record support."); await host.filesystem.syncFile(path); guard(); },
    remove: async path => { guard(); await host.filesystem.remove(path); guard(); },
  } });
  const snapshot = async (): Promise<ManagerRefreshNativeState> => {
    const state = platform === "linux" ? await linux() : platform === "darwin" ? await macSnapshot() : (await windows()).state;
    if (!validManagerRefreshNativeState(state, platform)) throw new Error("Manager native state is unsettled.");
    return state;
  };
  const transitionSnapshot = async (): Promise<ManagerRefreshNativeState> => {
    const state = platform === "linux" ? await linux(true) : platform === "darwin" ? await macSnapshot(true) : (await windows(true)).state;
    if (!validManagerRefreshNativeState(state, platform)) throw new Error("Manager native state is unsettled.");
    return state;
  };
  return {
    snapshot,
    async stop() {
      if (platform === "darwin") { await macLoaded(); await stopRecovery.stop({ disable: true }); guard(); return; }
      const state = await snapshot();
      if (platform === "linux") {
        await linux(); await command("systemctl", [...prefix, ...(state.enablement === "enabled-runtime" ? ["--runtime"] : []), "disable", "runmesh-manager.service"]);
        await linux(); await command("systemctl", [...prefix, "stop", "runmesh-manager.service"]);
      } else { await windowsChange("$t.Enabled=$false;"); await windowsChange("$t.Stop(0);"); }
      await wait(async () => { const current = await transitionSnapshot(); return !current.active && !current.enabled; });
    },
    async restore(state) {
      if (!validManagerRefreshNativeState(state, platform)) throw new Error("Manager native recovery state is invalid.");
      if (platform === "linux") {
        const current = await linux();
        if (!state.active && current.active) {
          await command("systemctl", [...prefix, "stop", "runmesh-manager.service"]);
          await wait(async () => !(await transitionSnapshot()).active);
        }
        await linux(); await command("systemctl", [...prefix, ...(state.enablement === "enabled-runtime" ? ["--runtime"] : []), state.enabled ? "enable" : "disable", "runmesh-manager.service"]);
        if (state.active) { await linux(); await command("systemctl", [...prefix, "start", "runmesh-manager.service"]); }
      } else if (platform === "darwin") {
        await macLoaded(); await stopRecovery.recover();
        const loaded = await macLoaded(), current = await macSnapshot();
        if (loaded.exitCode === 0 && (!state.registered || (!state.active && current.active))) await stopRecovery.stop();
        if (state.registered) {
          // Load disabled first so bootstrap of an inactive, RunAtLoad job
          // cannot start a process that the recorded state did not contain.
          await macLoaded(); await command("launchctl", ["disable", target]);
          if ((await macLoaded()).exitCode !== 0) await command("launchctl", ["bootstrap", domain, manifestPath]);
          if (state.active) {
            await macLoaded(); await command("launchctl", ["enable", target]);
            await macLoaded(); await command("launchctl", ["kickstart", target]);
            if (!state.enabled) { await macLoaded(); await command("launchctl", ["disable", target]); }
          } else if (state.enabled) {
            await macLoaded(); await command("launchctl", ["enable", target]);
          }
        }
      } else {
        if (state.active) {
          await windowsChange("$t.Enabled=$true;");
          await windowsChange("$t.Run($null) | Out-Null;");
          await wait(async () => (await transitionSnapshot()).active);
        } else if ((await windows()).state.active) {
          await windowsChange("$t.Enabled=$false;");
          await windowsChange("$t.Stop(0) | Out-Null;");
          await wait(async () => !(await transitionSnapshot()).active);
        }
        await windowsChange(`$t.Enabled=${state.enabled ? "$true" : "$false"};`);
      }
      await wait(async () => { const current = await transitionSnapshot(); return current.registered === state.registered && current.active === state.active && current.enabled === state.enabled && current.enablement === state.enablement; });
    },
  };
}
