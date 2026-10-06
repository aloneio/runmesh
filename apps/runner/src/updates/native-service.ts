import type { ServiceCommandExecutor, ServiceLayout, ServiceManifestFilesystem, ServiceMode, ServicePlatform } from "../service.js";
import { currentServicePlatform, hostServiceCommandExecutor, hostServiceManifestFilesystem, isManagedService, serviceLayout, serviceProfilePath } from "../service.js";
import { nativeProbeReliable, systemdEnablementState } from "../services/probes.js";
import { stopWindowsTask, windowsTaskMissingCatch } from "../services/task-scheduler.js";
import { LINUX_SERVICE_NAME, MACOS_LABEL } from "../services/values.js";
import { posix, win32 } from "node:path";

/** JSON-only native state, retained in the update journal before stopping a Runner. */
export interface NativeServiceSnapshot {
  readonly schema_version: 1;
  readonly platform: ServicePlatform;
  readonly mode: ServiceMode;
  readonly registered: boolean;
  readonly active: boolean;
  readonly enabled: boolean;
  readonly enablement: string;
  readonly pid?: number;
}

export interface NativeServiceMaintenancePort {
  snapshot(): Promise<NativeServiceSnapshot>;
  stop(): Promise<void>;
  start(): Promise<void>;
  restoreEnabled(snapshot: NativeServiceSnapshot): Promise<void>;
}

export interface NativeServiceMaintenanceOptions {
  readonly platform?: ServicePlatform;
  readonly mode?: ServiceMode;
  readonly profilePath: string;
  readonly installRoot: string;
  readonly home?: string;
  readonly executor?: ServiceCommandExecutor;
  readonly filesystem?: Pick<ServiceManifestFilesystem, "read">;
  readonly uid?: number;
  readonly now?: () => number;
  readonly delay?: (ms: number) => Promise<void>;
}

export interface MaintenanceLayout {
  readonly platform: ServicePlatform;
  readonly mode: ServiceMode;
  readonly path: MaintenancePathPort;
  readonly layout: ServiceLayout;
}

/** The declaration graph stays usable without Node ambient types. */
export interface MaintenancePathPort {
  readonly sep: string;
  join(...paths: string[]): string;
  normalize(path: string): string;
  dirname(path: string): string;
  basename(path: string): string;
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
}

/** Resolve the standard service layout before applying native operations. */
export function maintenanceLayout(options: Pick<NativeServiceMaintenanceOptions, "platform" | "mode" | "profilePath" | "installRoot" | "home">): MaintenanceLayout {
  const platform = options.platform ?? currentServicePlatform();
  const mode = options.mode ?? "system";
  const path = platform === "win32" ? win32 : posix;
  const layout = serviceLayout({ platform, mode, ...(options.home === undefined ? {} : { home: options.home }) });
  const normalize = (value: string) => platform === "win32" ? path.normalize(value).toLowerCase() : path.normalize(value);
  if (!path.isAbsolute(options.installRoot) || normalize(options.installRoot) !== normalize(layout.installRoot)) throw new Error("maintenance requires the standard managed installation root");
  if (!path.isAbsolute(options.profilePath) || /[\0\r\n]/u.test(options.profilePath)) throw new Error("maintenance requires an absolute profile path");
  if (mode === "system" && normalize(options.profilePath) !== normalize(serviceProfilePath(layout))) throw new Error("system maintenance requires the canonical Runner profile");
  return { platform, mode, path, layout };
}

function decodeXml(value: string): string {
  return value.replace(/&([^;]+);/gu, (_match, entity: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (named[entity] !== undefined) return named[entity];
    const numeric = /^#x([0-9a-f]+)$/iu.exec(entity) ?? /^#(\d+)$/u.exec(entity);
    if (numeric === null) throw new Error("unsupported service XML entity");
    return String.fromCodePoint(Number.parseInt(numeric[1]!, entity.startsWith("#x") ? 16 : 10));
  });
}

function systemdArgument(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "%") {
      if (value[++index] !== "%") throw new Error("dynamic systemd service argument");
      result += "%";
    } else if (character === "\\") {
      const escaped = value[++index];
      if (escaped === "x" && /^[0-9a-f]{2}$/iu.test(value.slice(index + 1, index + 3))) { result += String.fromCharCode(Number.parseInt(value.slice(index + 1, index + 3), 16)); index += 2; }
      else if (escaped === "\\" || escaped === '"' || escaped === "'") result += escaped;
      else throw new Error("unsupported systemd service argument");
    } else if (character === '"' || character === "'") throw new Error("unsupported quoted systemd service argument");
    else result += character;
  }
  return result;
}

function windowsArgumentList(value: string): string[] {
  const args: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (/\s/u.test(value[index] ?? "") && index < value.length) index += 1;
    if (index === value.length) break;
    let argument = "", quoted = false;
    while (index < value.length && (quoted || !/\s/u.test(value[index]!))) {
      if (value[index] === "\\") {
        let count = 0;
        while (value[index] === "\\") { count += 1; index += 1; }
        if (value[index] === '"') {
          argument += "\\".repeat(Math.floor(count / 2));
          if (count % 2 !== 0) argument += '"'; else quoted = !quoted;
          index += 1;
        } else argument += "\\".repeat(count);
      } else if (value[index] === '"') { quoted = !quoted; index += 1; }
      else { argument += value[index]!; index += 1; }
    }
    if (quoted) throw new Error("unterminated Windows service argument");
    args.push(argument);
  }
  return args;
}

/** Only the exact profile/state roots inspected by the coordinator may be maintained. */
export function hasStandardMaintenanceLaunch(content: string, options: NativeServiceMaintenanceOptions): boolean {
  const { platform, mode, path, layout } = maintenanceLayout(options);
  if (!isManagedService(content)) return false;
  try {
    let args: string[];
    if (platform === "linux") {
      const starts = [...content.matchAll(/^ExecStart=([^\r\n]+)\r?$/gmu)];
      if (starts.length !== 1 || [...content.matchAll(/^\s*ExecStart\s*=/gmu)].length !== 1) return false;
      args = starts[0]![1]!.split(/[ \t]+/u).map(systemdArgument);
    } else if (platform === "darwin") {
      const launches = [...content.matchAll(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/gu)];
      if (launches.length !== 1 || [...content.matchAll(/<key>ProgramArguments<\/key>/gu)].length !== 1) return false;
      const source = launches[0]![1]!;
      const strings = [...source.matchAll(/<string>([^<]*)<\/string>/gu)];
      if (source.replace(/<string>[^<]*<\/string>/gu, "").trim() !== "") return false;
      args = strings.map(match => decodeXml(match[1]!));
    } else {
      const commands = [...content.matchAll(/<Command>([^<]*)<\/Command>/gu)];
      const argumentsList = [...content.matchAll(/<Arguments>([^<]*)<\/Arguments>/gu)];
      if (commands.length !== 1 || argumentsList.length !== 1) return false;
      args = [decodeXml(commands[0]![1]!), ...windowsArgumentList(decodeXml(argumentsList[0]![1]!))];
    }
    const same = (left: string, right: string) => platform === "win32" ? path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase() : path.normalize(left) === path.normalize(right);
    if (args.some(argument => /[\0\r\n]/u.test(argument)) || args[0] === undefined || !same(args[0], layout.executablePath) || args[1] !== "start") return false;
    for (const [flag, expected] of [["--profile", options.profilePath], ["--state-dir", layout.stateRoot]] as const) {
      const indices = args.flatMap((argument, index) => argument === flag ? [index] : []);
      if (indices.length !== 1 || args.some(argument => argument.startsWith(`${flag}=`))) return false;
      const value = args[indices[0]! + 1];
      if (value === undefined || !path.isAbsolute(value) || !same(value, expected)) return false;
    }
    return args.filter(argument => argument === "--user").length === (mode === "user" ? 1 : 0) && !args.some(argument => argument.startsWith("--user="));
  } catch { return false; }
}

const windowsTask = "$ErrorActionPreference='Stop'; $s=New-Object -ComObject Schedule.Service; $s.Connect(); $t=$s.GetFolder('\\').GetTask('RunmeshRunner'); ";

export function createNativeServiceMaintenance(options: NativeServiceMaintenanceOptions): NativeServiceMaintenancePort {
  const { platform, mode, layout } = maintenanceLayout(options);
  const executor = options.executor ?? hostServiceCommandExecutor;
  const filesystem = options.filesystem ?? hostServiceManifestFilesystem;
  const prefix = mode === "user" ? ["--user"] : [];
  const uid = options.uid ?? process.getuid?.();
  if (platform === "darwin" && mode === "user" && uid === undefined) throw new Error("user maintenance requires the owning session UID");
  const domain = mode === "system" ? "system" : `gui/${uid}`;
  const target = `${domain}/${MACOS_LABEL}`;
  const now = options.now ?? Date.now;
  const delay = options.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const execute = async (file: string, args: readonly string[]) => {
    const result = await executor.execute(file, args);
    if (result.exitCode !== 0) throw new Error(`Runner maintenance command failed: ${file} ${args[0] ?? ""}`);
    return result;
  };
  const powershell = (script: string) => execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  const owned = async () => {
    const content = await filesystem.read(layout.manifestPath);
    if (content === undefined || !isManagedService(content)) throw new Error("Runner maintenance requires an intact managed service manifest");
    if (!hasStandardMaintenanceLaunch(content, options)) throw new Error("Runner maintenance requires the standard current executable path and matching profile/state directories");
  };
  const linuxState = async () => {
    const result = await execute("systemctl", [...prefix, "show", LINUX_SERVICE_NAME, "--property=LoadState,ActiveState,MainPID,UnitFileState"]);
    const fields = new Map((result.stdout ?? "").split(/\r?\n/u).filter(line => line.includes("=")).map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    const enablement = systemdEnablementState({ exitCode: 0, stdout: fields.get("UnitFileState") ?? "" });
    const active = fields.get("ActiveState");
    const rawPid = fields.get("MainPID");
    if (fields.get("LoadState") !== "loaded" || enablement === undefined || active === undefined || rawPid === undefined || !/^\d+$/u.test(rawPid)) throw new Error("Runner systemd state is unavailable or unsupported");
    return { enablement, active, pid: Number(rawPid) };
  };
  const macLoaded = async () => {
    const result = await executor.execute("launchctl", ["print", target]);
    if (!nativeProbeReliable(result, "query")) throw new Error("Runner launchd state is unavailable");
    return result;
  };
  const windowsState = async () => {
    const result = await powershell("$ErrorActionPreference='Stop'; $s=New-Object -ComObject Schedule.Service; $s.Connect(); try { $t=$s.GetFolder('\\').GetTask('RunmeshRunner'); [pscustomobject]@{found=$true; enabled=[bool]$t.Enabled; state=[int]$t.State; instances=[int]($t.GetInstances(0)).Count} | ConvertTo-Json -Compress } " + windowsTaskMissingCatch("json"));
    const state = JSON.parse(result.stdout ?? "") as { found?: unknown; enabled?: unknown; state?: unknown; instances?: unknown };
    if (state.found !== true || typeof state.enabled !== "boolean" || !Number.isInteger(state.state) || !Number.isInteger(state.instances)) throw new Error("Runner task state is unavailable");
    return state as { found: true; enabled: boolean; state: number; instances: number };
  };
  const waitStopped = async (check: () => Promise<boolean>) => {
    const deadline = now() + 5_000;
    do { if (await check()) return; if (now() >= deadline) break; await delay(100); } while (true);
    throw new Error("Runner did not stop before the maintenance deadline");
  };
  const snapshot = async (): Promise<NativeServiceSnapshot> => {
    await owned();
    const base = { schema_version: 1 as const, platform, mode };
    let result: NativeServiceSnapshot;
    if (platform === "linux") {
      const state = await linuxState();
      const enabled = state.enablement === "enabled" || state.enablement === "enabled-runtime";
      result = { ...base, registered: true, active: state.active === "active" || state.active === "activating" || state.pid !== 0, enabled, enablement: state.enablement, ...(state.pid === 0 ? {} : { pid: state.pid }) };
    } else if (platform === "darwin") {
      const loaded = await macLoaded();
      const disabled = await execute("launchctl", ["print-disabled", domain]);
      if (!(disabled.stdout ?? "").includes("{")) throw new Error("Runner launchd enablement is unavailable");
      const entry = new RegExp(`"${MACOS_LABEL.replaceAll(".", "\\.")}"\\s*=>\\s*(true|false)`, "u").exec(disabled.stdout ?? "");
      const enabled = entry?.[1] !== "true";
      const pid = /\bpid\s*=\s*(\d+)/u.exec(loaded.stdout ?? "")?.[1];
      const active = loaded.exitCode === 0 && /\bstate\s*=\s*running\b/u.test(loaded.stdout ?? "");
      if (active && pid === undefined) throw new Error("Runner launchd process identity is unavailable");
      result = { ...base, registered: loaded.exitCode === 0, active, enabled, enablement: enabled ? "enabled" : "disabled", ...(pid === undefined || Number(pid) === 0 ? {} : { pid: Number(pid) }) };
    } else {
      const state = await windowsState();
      result = { ...base, registered: true, active: state.state === 2 || state.state === 4 || state.instances > 0, enabled: state.enabled, enablement: state.enabled ? "enabled" : "disabled" };
    }
    return result;
  };
  return {
    snapshot,
    stop: async () => {
      await owned();
      // Rollback can stop a newly started candidate. Observe its current PID,
      // never reuse the pre-upgrade process identity retained in the journal.
      const previous = await snapshot();
      if (platform === "linux") {
        if (previous.enabled) await execute("systemctl", [...prefix, ...(previous.enablement === "enabled-runtime" ? ["--runtime"] : []), "disable", LINUX_SERVICE_NAME]);
        await execute("systemctl", [...prefix, "stop", LINUX_SERVICE_NAME]);
        await waitStopped(async () => { const state = await linuxState(); return (state.active === "inactive" || state.active === "failed") && state.pid === 0; });
      } else if (platform === "darwin") {
        await execute("launchctl", ["disable", target]);
        if ((await macLoaded()).exitCode === 0) await execute("launchctl", ["bootout", target]);
        await waitStopped(async () => {
          if ((await macLoaded()).exitCode === 0) return false;
          if (previous.pid === undefined || previous.pid === 0) return true;
          const processState = await executor.execute("ps", ["-p", String(previous.pid), "-o", "pid="]);
          if (processState.exitCode === 1 && !(processState.stdout ?? "").trim() && !(processState.stderr ?? "").trim()) return true;
          if (processState.exitCode !== 0) throw new Error("Runner process exit could not be confirmed");
          return false;
        });
      } else {
        await powershell(windowsTask + "$t.Enabled=$false;");
        await stopWindowsTask(executor);
        const stopped = await windowsState();
        if (stopped.enabled || stopped.instances !== 0 || (stopped.state !== 1 && stopped.state !== 3)) throw new Error("Runner task did not remain disabled and stopped");
      }
    },
    start: async () => {
      await owned();
      if (platform === "linux") await execute("systemctl", [...prefix, "start", LINUX_SERVICE_NAME]);
      else if (platform === "darwin") {
        await execute("launchctl", ["enable", target]);
        if ((await macLoaded()).exitCode === 0) await execute("launchctl", ["kickstart", "-k", target]);
        else await execute("launchctl", ["bootstrap", domain, layout.manifestPath]);
      } else {
        await powershell(windowsTask + "$t.Enabled=$true;");
        await execute("schtasks", ["/Run", "/TN", "RunmeshRunner"]);
      }
    },
    restoreEnabled: async state => {
      if (state.schema_version !== 1 || state.platform !== platform || state.mode !== mode || typeof state.enabled !== "boolean"
        || typeof state.active !== "boolean" || typeof state.registered !== "boolean" || typeof state.enablement !== "string") throw new Error("native service snapshot does not match this installation");
      if (platform !== "linux" && state.enablement !== (state.enabled ? "enabled" : "disabled")) throw new Error("native service snapshot has invalid enablement");
      if (platform === "linux" && (systemdEnablementState({ exitCode: 0, stdout: state.enablement }) !== state.enablement || state.enabled !== (state.enablement === "enabled" || state.enablement === "enabled-runtime"))) throw new Error("native service snapshot has invalid enablement");
      await owned();
      if (platform === "linux") {
        if (state.enablement === "enabled" || state.enablement === "enabled-runtime") await execute("systemctl", [...prefix, ...(state.enablement === "enabled-runtime" ? ["--runtime"] : []), "enable", LINUX_SERVICE_NAME]);
        else if (state.enablement === "disabled") await execute("systemctl", [...prefix, "disable", LINUX_SERVICE_NAME]);
        const restored = await linuxState();
        if (restored.enablement !== state.enablement) throw new Error("Runner systemd enablement was not restored");
      } else if (platform === "darwin") {
        await execute("launchctl", [state.enabled ? "enable" : "disable", target]);
        const disabled = await execute("launchctl", ["print-disabled", domain]);
        if (!(disabled.stdout ?? "").includes("{")) throw new Error("Runner launchd enablement is unavailable");
        const entry = new RegExp(`"${MACOS_LABEL.replaceAll(".", "\\.")}"\\s*=>\\s*(true|false)`, "u").exec(disabled.stdout ?? "");
        if ((entry?.[1] !== "true") !== state.enabled) throw new Error("Runner launchd enablement was not restored");
      } else {
        await powershell(windowsTask + `$t.Enabled=${state.enabled ? "$true" : "$false"};`);
        if ((await windowsState()).enabled !== state.enabled) throw new Error("Runner task enablement was not restored");
      }
    },
  };
}
