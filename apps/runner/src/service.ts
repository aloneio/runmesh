import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, win32 } from "node:path";

export type ServicePlatform = "linux" | "darwin" | "win32";
export type ServiceMode = "user" | "system";
export interface ServiceManifest {
  readonly platform: ServicePlatform;
  readonly mode: ServiceMode;
  readonly path: string;
  readonly content: string;
  readonly hash: string;
}
export interface ServiceLayout {
  readonly installRoot: string;
  readonly configRoot: string;
  readonly stateRoot: string;
  readonly manifestPath: string;
  readonly executablePath: string;
}
export interface ServiceAdapterOptions {
  readonly platform?: ServicePlatform;
  readonly mode?: ServiceMode;
  /** @deprecated Prefer mode: "system" or mode: "user". */
  readonly system?: boolean;
  readonly home?: string;
  /** Absolute Runner executable. Defaults to the selected installation layout. */
  readonly executablePath?: string;
  /** @deprecated An absolute command is retained for callers from the prior adapter. */
  readonly command?: string;
  readonly profilePath?: string;
  readonly stateDir?: string;
  readonly installRoot?: string;
  readonly configRoot?: string;
  readonly dataRoot?: string;
  /** Test/operator override for the directory containing the manifest. */
  readonly manifestDir?: string;
}
export interface ServiceManifestFilesystem {
  readonly read: (path: string) => Promise<string | undefined>;
  readonly write: (path: string, content: string) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
}
export interface ServiceCommandResult { readonly exitCode: number; readonly stdout?: string; readonly stderr?: string; }
export interface ServiceCommandExecutor {
  readonly execute: (file: string, args: readonly string[]) => Promise<ServiceCommandResult>;
}
export interface ServiceManagerAdapter {
  readonly platform: ServicePlatform;
  readonly mode: ServiceMode;
  readonly install: (manifest: ServiceManifest) => Promise<void>;
  readonly stop: (manifest: ServiceManifest) => Promise<void>;
  readonly restart: (manifest: ServiceManifest) => Promise<void>;
  readonly uninstall: (manifest: ServiceManifest) => Promise<void>;
}
export interface ServiceManagerOptions {
  readonly platform?: ServicePlatform;
  readonly mode?: ServiceMode;
  readonly executor?: ServiceCommandExecutor;
}

const MARKER = "remote-coding-runner-managed";
const LINUX_SERVICE_NAME = "remote-coding-runner.service";
const MACOS_LABEL = "com.remote-coding.runner";
const WINDOWS_TASK_NAME = "RemoteCodingRunner";

export function currentServicePlatform(platform: NodeJS.Platform = process.platform): ServicePlatform { return platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : "win32"; }
export function serviceMode(options: ServiceAdapterOptions = {}): ServiceMode { return options.mode ?? (options.system === false ? "user" : "system"); }

/** Centralized layouts make a machine Runner independent of the invoking shell or workspace. */
export function serviceLayout(options: ServiceAdapterOptions = {}): ServiceLayout {
  const platform = options.platform ?? currentServicePlatform();
  const mode = serviceMode(options);
  const home = options.home ?? homedir();
  const path = platform === "win32" ? win32 : { join };
  if (mode === "system") {
    if (platform === "linux") {
      const installRoot = options.installRoot ?? "/opt/remote-coding-runtime";
      const configRoot = options.configRoot ?? "/etc/remote-coding-runtime";
      const stateRoot = options.dataRoot ?? "/var/lib/remote-coding-runtime";
      const manifestPath = join(options.manifestDir ?? "/etc/systemd/system", LINUX_SERVICE_NAME);
      return { installRoot, configRoot, stateRoot, manifestPath, executablePath: options.executablePath ?? join(installRoot, "bin", "coding-runner") };
    }
    if (platform === "darwin") {
      const installRoot = options.installRoot ?? "/opt/remote-coding-runtime";
      const configRoot = options.configRoot ?? "/Library/Application Support/RemoteCodingRunner";
      const stateRoot = options.dataRoot ?? join(configRoot, "state");
      const manifestPath = join(options.manifestDir ?? "/Library/LaunchDaemons", `${MACOS_LABEL}.plist`);
      return { installRoot, configRoot, stateRoot, manifestPath, executablePath: options.executablePath ?? join(installRoot, "bin", "coding-runner") };
    }
    const installRoot = options.installRoot ?? "C:\\Program Files\\RemoteCodingRunner";
    const configRoot = options.configRoot ?? "C:\\ProgramData\\RemoteCodingRunner";
    const stateRoot = options.dataRoot ?? path.join(configRoot, "state");
    const manifestPath = path.join(options.manifestDir ?? configRoot, "coding-runner-task.xml");
    return { installRoot, configRoot, stateRoot, manifestPath, executablePath: options.executablePath ?? path.join(installRoot, "coding-runner.cmd") };
  }
  if (platform === "linux") {
    const installRoot = options.installRoot ?? join(home, ".local", "share", "remote-coding-runner", "npm");
    const configRoot = options.configRoot ?? join(home, ".remote-coding-runner");
    const stateRoot = options.dataRoot ?? join(configRoot, "state");
    return { installRoot, configRoot, stateRoot, manifestPath: join(options.manifestDir ?? join(home, ".config", "systemd", "user"), LINUX_SERVICE_NAME), executablePath: options.executablePath ?? join(installRoot, "bin", "coding-runner") };
  }
  if (platform === "darwin") {
    const installRoot = options.installRoot ?? join(home, ".local", "share", "remote-coding-runner", "npm");
    const configRoot = options.configRoot ?? join(home, "Library", "Application Support", "RemoteCodingRunner");
    const stateRoot = options.dataRoot ?? join(configRoot, "state");
    return { installRoot, configRoot, stateRoot, manifestPath: join(options.manifestDir ?? join(home, "Library", "LaunchAgents"), `${MACOS_LABEL}.plist`), executablePath: options.executablePath ?? join(installRoot, "bin", "coding-runner") };
  }
  const installRoot = options.installRoot ?? path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "RemoteCodingRunner", "npm");
  const configRoot = options.configRoot ?? path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "RemoteCodingRunner");
  const stateRoot = options.dataRoot ?? path.join(configRoot, "state");
  return { installRoot, configRoot, stateRoot, manifestPath: path.join(options.manifestDir ?? configRoot, "coding-runner-task.xml"), executablePath: options.executablePath ?? path.join(installRoot, "coding-runner.cmd") };
}

export function servicePath(options: ServiceAdapterOptions = {}): string { return serviceLayout(options).manifestPath; }
export function renderService(options: ServiceAdapterOptions = {}): ServiceManifest {
  const platform = options.platform ?? currentServicePlatform();
  const mode = serviceMode(options);
  const layout = serviceLayout(options);
  const profile = options.profilePath ?? join(layout.configRoot, "profile.json");
  const invocation = serviceInvocation(options, layout, profile, options.stateDir ?? layout.stateRoot, platform);
  const body = platform === "linux" ? renderSystemd(mode, invocation, profile) : platform === "darwin" ? renderLaunchd(mode, invocation) : renderWindowsTask(mode, invocation);
  const hash = hashContent(body);
  const marker = `${MARKER}:${hash}`;
  const content = platform === "linux" ? `# ${marker}\n${body}` : `<!-- ${marker} -->\n${body}`;
  return { platform, mode, path: layout.manifestPath, content, hash };
}

function serviceInvocation(options: ServiceAdapterOptions, layout: ServiceLayout, profile: string, stateDir: string, platform: ServicePlatform): readonly string[] {
  const legacy = options.command === undefined ? undefined : options.command.trim().split(/\s+/).filter(Boolean);
  const executable = options.executablePath ?? legacy?.[0] ?? layout.executablePath;
  if (!isAbsoluteForPlatform(executable, platform)) throw new Error("service executable path must be absolute");
  const command = legacy === undefined ? [executable, "start"] : [executable, ...legacy.slice(1)];
  if (!command.includes("start")) command.push("start");
  if (!command.includes("--profile")) command.push("--profile", profile);
  if (!command.includes("--state-dir")) command.push("--state-dir", stateDir);
  return command;
}
function renderSystemd(mode: ServiceMode, invocation: readonly string[], profile: string): string {
  const wantedBy = mode === "system" ? "multi-user.target" : "default.target";
  return `[Unit]\nDescription=Remote Coding Runner\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nEnvironment="CODING_RUNNER_PROFILE=${escapeSystemdEnvironment(profile)}"\nExecStart=${invocation.map(escapeSystemdArgument).join(" ")}\nRestart=on-failure\n\n[Install]\nWantedBy=${wantedBy}\n`;
}
function renderLaunchd(mode: ServiceMode, invocation: readonly string[]): string {
  const keepAlive = mode === "system" ? "<true/>" : "<true/>";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${MACOS_LABEL}</string><key>ProgramArguments</key><array>${invocation.map((part) => `<string>${escapeXml(part)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key>${keepAlive}</dict></plist>\n`;
}
function renderWindowsTask(mode: ServiceMode, invocation: readonly string[]): string {
  const principal = mode === "system"
    ? `<Principal id="Author"><UserId>SYSTEM</UserId><LogonType>ServiceAccount</LogonType><RunLevel>HighestAvailable</RunLevel></Principal>`
    : `<Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>`;
  const trigger = mode === "system" ? "<BootTrigger><Enabled>true</Enabled></BootTrigger>" : "<LogonTrigger><Enabled>true</Enabled></LogonTrigger>";
  // installServiceManifest writes JavaScript strings as UTF-8, so the declaration must match.
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>Remote Coding Runner</Description></RegistrationInfo><Triggers>${trigger}</Triggers><Principals>${principal}</Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context="Author"><Exec><Command>${escapeXml(invocation[0] ?? "")}</Command><Arguments>${escapeXml(windowsArguments(invocation.slice(1)))}</Arguments></Exec></Actions></Task>\n`;
}

/** Only manifests with an intact marker and content hash are considered ours. */
export function isManagedService(content: string): boolean {
  const match = /(?:#|<!--)\s*remote-coding-runner-managed:([0-9a-f]{8})\s*(?:-->)?\n/.exec(content);
  if (match === null || match[1] === undefined) return false;
  return hashContent(content.slice(match[0].length)) === match[1];
}

export const hostServiceManifestFilesystem: ServiceManifestFilesystem = {
  read: async (path) => readFile(path, "utf8").catch((error: unknown) => isErrno(error, "ENOENT") ? undefined : Promise.reject(error)),
  write: async (path, content) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  },
  remove: async (path) => { await rm(path); },
};
export async function installServiceManifest(manifest: ServiceManifest, filesystem: ServiceManifestFilesystem = hostServiceManifestFilesystem): Promise<void> {
  const existing = await filesystem.read(manifest.path);
  if (existing !== undefined && !isManagedService(existing)) throw new Error(`refusing to overwrite unmanaged service manifest: ${manifest.path}`);
  await filesystem.write(manifest.path, manifest.content);
}
export async function removeServiceManifest(manifest: ServiceManifest, filesystem: ServiceManifestFilesystem = hostServiceManifestFilesystem): Promise<boolean> {
  const existing = await filesystem.read(manifest.path);
  if (existing === undefined) return false;
  if (!isManagedService(existing)) throw new Error(`refusing to remove unmanaged service manifest: ${manifest.path}`);
  await filesystem.remove(manifest.path);
  return true;
}
export async function assertManagedServiceManifest(manifest: ServiceManifest, filesystem: ServiceManifestFilesystem = hostServiceManifestFilesystem): Promise<boolean> {
  const existing = await filesystem.read(manifest.path);
  if (existing === undefined) return false;
  if (!isManagedService(existing)) throw new Error(`refusing to manage unmanaged service manifest: ${manifest.path}`);
  return true;
}

/** Host-command executor used only outside tests; tests provide a recording executor. */
export const hostServiceCommandExecutor: ServiceCommandExecutor = {
  execute: (file, args) => new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = ""; let stderr = "";
    child.stdout?.on("data", (value: Buffer) => { stdout = `${stdout}${value.toString("utf8")}`.slice(0, 4_096); });
    child.stderr?.on("data", (value: Buffer) => { stderr = `${stderr}${value.toString("utf8")}`.slice(0, 4_096); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  }),
};

/** Explicit, injectable machine service adapters. No adapter falls back to a user service. */
export function createServiceManager(options: ServiceManagerOptions = {}): ServiceManagerAdapter {
  const platform = options.platform ?? currentServicePlatform();
  const mode = options.mode ?? "system";
  const executor = options.executor ?? hostServiceCommandExecutor;
  const execute = async (file: string, args: readonly string[]): Promise<void> => {
    const result = await executor.execute(file, args);
    if (result.exitCode !== 0) throw new Error(`service command failed: ${[file, ...args].join(" ")}${result.stderr === undefined || result.stderr.length === 0 ? "" : ` (${result.stderr.trim().slice(0, 512)})`}`);
  };
  if (platform === "linux") {
    const prefix = mode === "user" ? ["--user"] : [];
    const name = LINUX_SERVICE_NAME;
    return {
      platform, mode,
      install: async () => { await execute("systemctl", [...prefix, "daemon-reload"]); await execute("systemctl", [...prefix, "enable", "--now", name]); await execute("systemctl", [...prefix, "is-active", "--quiet", name]); },
      stop: async () => execute("systemctl", [...prefix, "stop", name]),
      restart: async () => execute("systemctl", [...prefix, "restart", name]),
      uninstall: async () => execute("systemctl", [...prefix, "disable", "--now", name]),
    };
  }
  if (platform === "darwin") {
    const domain = mode === "system" ? "system" : `gui/${process.getuid?.() ?? 0}`;
    const target = `${domain}/${MACOS_LABEL}`;
    return {
      platform, mode,
      install: async (manifest) => { await execute("launchctl", ["bootstrap", domain, manifest.path]); await execute("launchctl", ["enable", target]); await execute("launchctl", ["print", target]); },
      stop: async () => execute("launchctl", ["kill", "SIGTERM", target]),
      restart: async () => execute("launchctl", ["kickstart", "-k", target]),
      uninstall: async () => execute("launchctl", ["bootout", target]),
    };
  }
  return {
    platform, mode,
    install: async (manifest) => { await execute("schtasks", ["/Create", "/TN", WINDOWS_TASK_NAME, "/XML", manifest.path, "/F"]); await execute("schtasks", ["/Run", "/TN", WINDOWS_TASK_NAME]); await execute("schtasks", ["/Query", "/TN", WINDOWS_TASK_NAME]); },
    stop: async () => execute("schtasks", ["/End", "/TN", WINDOWS_TASK_NAME]),
    restart: async () => { await execute("schtasks", ["/End", "/TN", WINDOWS_TASK_NAME]); await execute("schtasks", ["/Run", "/TN", WINDOWS_TASK_NAME]); },
    uninstall: async () => execute("schtasks", ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"]),
  };
}

export function hashContent(content: string): string { let hash = 2166136261; for (const byte of Buffer.from(content, "utf8")) { hash ^= byte; hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(16).padStart(8, "0"); }
export function serviceCommands(action: "install" | "start" | "stop" | "restart" | "uninstall", platform: ServicePlatform = currentServicePlatform(), mode: ServiceMode = "system"): readonly string[] {
  if (platform === "linux") {
    const prefix = mode === "user" ? "systemctl --user" : "systemctl";
    if (action === "install") return [`${prefix} daemon-reload`, `${prefix} enable --now ${LINUX_SERVICE_NAME}`, `${prefix} is-active --quiet ${LINUX_SERVICE_NAME}`];
    return [`${prefix} ${action === "uninstall" ? "disable --now" : action} ${LINUX_SERVICE_NAME}`];
  }
  if (platform === "darwin") {
    const domain = mode === "system" ? "system" : "gui/$(id -u)";
    if (action === "install") return [`launchctl bootstrap ${domain} <manifest>`, `launchctl enable ${domain}/${MACOS_LABEL}`, `launchctl print ${domain}/${MACOS_LABEL}`];
    return [`launchctl ${action === "uninstall" ? "bootout" : action === "restart" ? "kickstart -k" : "kill SIGTERM"} ${domain}/${MACOS_LABEL}`];
  }
  if (action === "install") return [`schtasks /Create /TN ${WINDOWS_TASK_NAME} /XML <manifest> /F`, `schtasks /Run /TN ${WINDOWS_TASK_NAME}`, `schtasks /Query /TN ${WINDOWS_TASK_NAME}`];
  return [`schtasks /${action === "start" ? "Run" : action === "stop" ? "End" : action === "uninstall" ? "Delete" : "Run"} /TN ${WINDOWS_TASK_NAME}`];
}

function isAbsoluteForPlatform(value: string, platform: ServicePlatform): boolean { return platform === "win32" ? win32.isAbsolute(value) : value.startsWith("/"); }
function escapeSystemdArgument(value: string): string { return value.replaceAll("\\", "\\\\").replaceAll("\n", "").replaceAll(" ", "\\x20").replaceAll('"', "\\\""); }
function escapeSystemdEnvironment(value: string): string { return value.replaceAll("\\", "\\\\").replaceAll('"', "\\\"").replaceAll("\n", ""); }
function escapeXml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }
function windowsArguments(values: readonly string[]): string { return values.map((value) => /[\s"]/u.test(value) ? `"${value.replaceAll('"', '\\\"')}"` : value).join(" "); }
function isErrno(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code; }
