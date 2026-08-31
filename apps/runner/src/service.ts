import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, posix, win32 } from "node:path";
import type { HostPlatform } from "./platform-types.js";
import { resolveTrustedWindowsTool, trustedWindowsEnvironment, trustedWindowsRoot } from "./windows-tools.js";

export type ServicePlatform = "linux" | "darwin" | "win32";
export type ServiceMode = "user" | "system";
/** The OS identity used by a machine service. */
export type ExecutionMode = "dedicated_user" | "privileged_host";
export interface ServiceManifest {
  readonly platform: ServicePlatform;
  readonly mode: ServiceMode;
  readonly executionMode: ExecutionMode;
  readonly path: string;
  readonly content: string;
  readonly hash: string;
}
export interface ServiceLayout {
  readonly installRoot: string;
  readonly configRoot: string;
  readonly stateRoot: string;
  readonly logRoot: string;
  readonly manifestPath: string;
  readonly executablePath: string;
}
export interface ServiceAdapterOptions {
  readonly platform?: ServicePlatform;
  readonly mode?: ServiceMode;
  /** Machine services default to a dedicated, non-privileged Runmesh account. */
  readonly executionMode?: ExecutionMode;
  /** Linux/macOS dedicated service account. Defaults to runmesh. */
  readonly serviceUser?: string;
  /** Linux dedicated service group. Defaults to the service user. */
  readonly serviceGroup?: string;
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
  readonly logRoot?: string;
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
export interface ServiceRuntimeStatus {
  readonly installed: boolean;
  readonly active: boolean;
  /** Identity reported by the host service manager, when its native query exposes it. */
  readonly identity?: string;
  readonly detail?: string;
}
export interface ServiceProvisioningStatus {
  readonly identity: string;
  readonly profileSecured: boolean;
  readonly detail?: string;
}
export interface ServiceProvisioner {
  readonly platform: ServicePlatform;
  /** Creates only Runmesh-owned account/directories/ACLs; it never changes Workspace ownership or modes. */
  readonly provision: (manifest: ServiceManifest, profilePath: string) => Promise<ServiceProvisioningStatus>;
}
export interface InstallServiceManifestOptions {
  /** Explicit acknowledgement required before writing a privileged machine service. */
  readonly confirmPrivilegedHost?: boolean;
}
export interface ServiceManagerAdapter {
  readonly platform: ServicePlatform;
  readonly mode: ServiceMode;
  readonly install: (manifest: ServiceManifest) => Promise<void>;
  readonly stop: (manifest: ServiceManifest) => Promise<void>;
  readonly restart: (manifest: ServiceManifest) => Promise<void>;
  readonly uninstall: (manifest: ServiceManifest) => Promise<void>;
  /** Optional injectable status probe; custom managers may omit it. */
  readonly status?: (manifest: ServiceManifest) => Promise<ServiceRuntimeStatus>;
}
export interface ServiceManagerOptions {
  readonly platform?: ServicePlatform;
  readonly mode?: ServiceMode;
  readonly executor?: ServiceCommandExecutor;
}
export interface ServiceProvisionerOptions {
  readonly platform?: ServicePlatform;
  readonly executor?: ServiceCommandExecutor;
}

const MARKER = "runmesh-runner-managed";
const LINUX_SERVICE_NAME = "runmesh-runner.service";
const MACOS_LABEL = "io.alone.runmesh.runner";
const WINDOWS_TASK_NAME = "RunmeshRunner";
const DEDICATED_SERVICE_USER = "runmesh";

export function currentServicePlatform(platform: HostPlatform = process.platform): ServicePlatform { return platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : "win32"; }
export function serviceMode(options: ServiceAdapterOptions = {}): ServiceMode { return options.mode ?? (options.system === false ? "user" : "system"); }
export function serviceExecutionMode(options: Pick<ServiceAdapterOptions, "executionMode"> = {}): ExecutionMode {
  const mode = options.executionMode ?? "dedicated_user";
  if (mode !== "dedicated_user" && mode !== "privileged_host") throw new Error("execution mode must be dedicated_user or privileged_host");
  return mode;
}
export function dedicatedServiceIdentity(options: Pick<ServiceAdapterOptions, "serviceUser" | "serviceGroup"> = {}): { readonly user: string; readonly group: string } {
  const user = options.serviceUser ?? DEDICATED_SERVICE_USER;
  const group = options.serviceGroup ?? user;
  if (!safeServiceIdentity(user) || !safeServiceIdentity(group)) throw new Error("service user and group must be safe account names");
  return { user, group };
}

/** Centralized layouts make a machine Runner independent of the invoking shell or workspace. */
export function serviceLayout(options: ServiceAdapterOptions = {}): ServiceLayout {
  const platform = options.platform ?? currentServicePlatform();
  const mode = serviceMode(options);
  const home = options.home ?? homedir();
  // Render a target platform's paths even when the CLI is being exercised on a
  // different host (for example, release tests render Linux manifests on
  // Windows). Using the host `join` here would produce backslashes in POSIX
  // paths and make otherwise valid manifests unusable.
  const path = platform === "win32" ? win32 : posix;
  if (mode === "system") {
    if (platform === "linux") {
      const installRoot = options.installRoot ?? "/opt/runmesh";
      const configRoot = options.configRoot ?? "/etc/runmesh";
      const stateRoot = options.dataRoot ?? "/var/lib/runmesh";
      const logRoot = options.logRoot ?? "/var/log/runmesh";
      const manifestPath = path.join(options.manifestDir ?? "/etc/systemd/system", LINUX_SERVICE_NAME);
      // npm's POSIX global layout places package bin shims under `<prefix>/bin`.
      // Keep the generated system unit pointed at the executable that the
      // portable installation procedure actually stages.
      return { installRoot, configRoot, stateRoot, logRoot, manifestPath, executablePath: options.executablePath ?? path.join(installRoot, "current", "bin", "coding-runner") };
    }
    if (platform === "darwin") {
      const installRoot = options.installRoot ?? "/opt/runmesh";
      const configRoot = options.configRoot ?? "/Library/Application Support/Runmesh";
      const stateRoot = options.dataRoot ?? path.join(configRoot, "state");
      const logRoot = options.logRoot ?? path.join(configRoot, "logs");
      const manifestPath = path.join(options.manifestDir ?? "/Library/LaunchDaemons", `${MACOS_LABEL}.plist`);
      // npm's POSIX global layout places package bin shims under `<prefix>/bin`.
      // Keep the generated launchd daemon pointed at the executable staged by
      // the portable installation procedure.
      return { installRoot, configRoot, stateRoot, logRoot, manifestPath, executablePath: options.executablePath ?? path.join(installRoot, "current", "bin", "coding-runner") };
    }
    const installRoot = options.installRoot ?? "C:\\Program Files\\Runmesh";
    const configRoot = options.configRoot ?? "C:\\ProgramData\\Runmesh";
    const stateRoot = options.dataRoot ?? path.join(configRoot, "state");
    const logRoot = options.logRoot ?? path.join(configRoot, "logs");
    const manifestPath = path.join(options.manifestDir ?? configRoot, "RunmeshRunner.xml");
    return { installRoot, configRoot, stateRoot, logRoot, manifestPath, executablePath: options.executablePath ?? path.join(installRoot, "current", "coding-runner.cmd") };
  }
  if (platform === "linux") {
    const installRoot = options.installRoot ?? path.join(home, ".local", "share", "runmesh");
    const configRoot = options.configRoot ?? path.join(home, ".config", "runmesh");
    const stateRoot = options.dataRoot ?? path.join(home, ".local", "state", "runmesh");
    const logRoot = options.logRoot ?? path.join(stateRoot, "logs");
      return { installRoot, configRoot, stateRoot, logRoot, manifestPath: path.join(options.manifestDir ?? path.join(home, ".config", "systemd", "user"), LINUX_SERVICE_NAME), executablePath: options.executablePath ?? path.join(installRoot, "current", "bin", "coding-runner") };
  }
  if (platform === "darwin") {
    const installRoot = options.installRoot ?? path.join(home, ".local", "share", "runmesh");
    const configRoot = options.configRoot ?? path.join(home, "Library", "Application Support", "Runmesh");
    const stateRoot = options.dataRoot ?? path.join(configRoot, "state");
    const logRoot = options.logRoot ?? path.join(configRoot, "logs");
      return { installRoot, configRoot, stateRoot, logRoot, manifestPath: path.join(options.manifestDir ?? path.join(home, "Library", "LaunchAgents"), `${MACOS_LABEL}.plist`), executablePath: options.executablePath ?? path.join(installRoot, "current", "bin", "coding-runner") };
  }
  const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
  const installRoot = options.installRoot ?? path.join(local, "Runmesh");
  const configRoot = options.configRoot ?? path.join(local, "Runmesh");
  const stateRoot = options.dataRoot ?? path.join(configRoot, "state");
  const logRoot = options.logRoot ?? path.join(configRoot, "logs");
  return { installRoot, configRoot, stateRoot, logRoot, manifestPath: path.join(options.manifestDir ?? configRoot, "RunmeshRunner.xml"), executablePath: options.executablePath ?? path.join(installRoot, "current", "coding-runner.cmd") };
}

export function servicePath(options: ServiceAdapterOptions = {}): string { return serviceLayout(options).manifestPath; }
export function serviceProfilePath(layout: ServiceLayout): string {
  // `win32.isAbsolute('/etc/runmesh')` is also true on Node, so detect a
  // Windows drive/UNC root explicitly instead of using the host semantics.
  const path = /^[A-Za-z]:[\\/]/u.test(layout.configRoot) || layout.configRoot.startsWith("\\\\") ? win32 : posix;
  return path.join(layout.configRoot, "profile.json");
}
export function isDefaultSystemProfile(layout: ServiceLayout, profilePath: string): boolean {
  const expected = serviceProfilePath(layout);
  // Windows paths are case-insensitive and callers may provide either slash
  // convention. Compare normalized absolute paths so an equivalent spelling
  // cannot accidentally disable the dedicated-service profile guard.
  if (/^[A-Za-z]:[\\/]/u.test(expected) || expected.startsWith("\\\\")) {
    return win32.isAbsolute(profilePath) && win32.normalize(profilePath).replace(/[\\/]+$/u, "").toLowerCase()
      === win32.normalize(expected).replace(/[\\/]+$/u, "").toLowerCase();
  }
  return posix.normalize(profilePath) === posix.normalize(expected);
}
export function renderService(options: ServiceAdapterOptions = {}): ServiceManifest {
  const platform = options.platform ?? currentServicePlatform();
  const mode = serviceMode(options);
  const executionMode = mode === "user" ? "dedicated_user" : serviceExecutionMode(options);
  const layout = serviceLayout(options);
  const profile = absoluteServicePath(options.profilePath ?? serviceProfilePath(layout), platform);
  const stateDir = absoluteServicePath(options.stateDir ?? layout.stateRoot, platform);
  const invocation = serviceInvocation(options, layout, profile, stateDir, platform);
  const identity = dedicatedServiceIdentity(options);
  const body = platform === "linux"
    ? renderSystemd(mode, executionMode, invocation, profile, identity)
    : platform === "darwin"
      ? renderLaunchd(mode, executionMode, invocation, identity.user)
      : renderWindowsTask(mode, executionMode, invocation);
  const hash = hashContent(body);
  const marker = `${MARKER}:${hash}`;
  const content = platform === "linux" ? `# ${marker}\n${body}` : `<!-- ${marker} -->\n${body}`;
  return { platform, mode, executionMode, path: layout.manifestPath, content, hash };
}

function serviceInvocation(options: ServiceAdapterOptions, layout: ServiceLayout, profile: string, stateDir: string, platform: ServicePlatform): readonly string[] {
  const legacy = options.command === undefined ? undefined : options.command.trim().split(/\s+/).filter(Boolean);
  // `command` is retained only for source compatibility with the pre-product
  // adapter.  Profile/state arguments are security-critical: allowing a
  // caller-supplied value here could make a privileged service load credentials
  // or job state from an attacker-controlled path.  Reject both `--flag value`
  // and `--flag=value` spellings rather than trying to strip an unknown quoted
  // command grammar; callers should use the explicit profile/state options.
  if (legacy?.some((part) => part === "--profile" || part === "--state-dir" || part.startsWith("--profile=") || part.startsWith("--state-dir="))) {
    throw new Error("service command cannot override --profile or --state-dir");
  }
  const executable = options.executablePath ?? legacy?.[0] ?? layout.executablePath;
  if (!isAbsoluteForPlatform(executable, platform)) throw new Error("service executable path must be absolute");
  const command = legacy === undefined ? [executable, "start"] : [executable, ...legacy.slice(1)];
  if (!command.includes("start")) command.push("start");
  // Always append the canonical paths. The legacy command may carry unrelated
  // compatibility flags, but it can never replace these two boundaries.
  // Normalize again at the final command boundary so future callers that use
  // this helper cannot accidentally reintroduce cwd-relative credential or
  // state paths.
  command.push("--profile", absoluteServicePath(profile, platform), "--state-dir", absoluteServicePath(stateDir, platform));
  return command;
}
function renderSystemd(mode: ServiceMode, executionMode: ExecutionMode, invocation: readonly string[], profile: string, identity: { readonly user: string; readonly group: string }): string {
  const wantedBy = mode === "system" ? "multi-user.target" : "default.target";
  const dedicatedIdentity = mode === "system" && executionMode === "dedicated_user" ? `User=${identity.user}\nGroup=${identity.group}\n` : "";
  return `[Unit]\nDescription=Runmesh Runner\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\n${dedicatedIdentity}Environment="RUNMESH_RUNNER_PROFILE=${escapeSystemdEnvironment(profile)}"\nExecStart=${invocation.map(escapeSystemdArgument).join(" ")}\nRestart=on-failure\n\n[Install]\nWantedBy=${wantedBy}\n`;
}
function renderLaunchd(mode: ServiceMode, executionMode: ExecutionMode, invocation: readonly string[], serviceUser: string): string {
  const userName = mode === "system" && executionMode === "dedicated_user" ? `<key>UserName</key><string>${escapeXml(serviceUser)}</string>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${MACOS_LABEL}</string>${userName}<key>ProgramArguments</key><array>${invocation.map((part) => `<string>${escapeXml(part)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>\n`;
}
function renderWindowsTask(mode: ServiceMode, executionMode: ExecutionMode, invocation: readonly string[]): string {
  const principal = mode === "system"
    ? executionMode === "privileged_host"
      ? `<Principal id="Author"><UserId>SYSTEM</UserId><LogonType>ServiceAccount</LogonType><RunLevel>HighestAvailable</RunLevel></Principal>`
      : `<Principal id="Author"><UserId>NT AUTHORITY\\LOCAL SERVICE</UserId><LogonType>ServiceAccount</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>`
    : `<Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>`;
  const trigger = mode === "system" ? "<BootTrigger><Enabled>true</Enabled></BootTrigger>" : "<LogonTrigger><Enabled>true</Enabled></LogonTrigger>";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>Runmesh Runner</Description></RegistrationInfo><Triggers>${trigger}</Triggers><Principals>${principal}</Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context="Author"><Exec><Command>${escapeXml(invocation[0] ?? "")}</Command><Arguments>${escapeXml(windowsArguments(invocation.slice(1)))}</Arguments></Exec></Actions></Task>\n`;
}

/** Only manifests with an intact marker and content hash are considered ours. */
export function isManagedService(content: string): boolean {
  const match = /(?:#|<!--)\s*runmesh-runner-managed:([0-9a-f]{8})\s*(?:-->)?\n/.exec(content);
  if (match === null || match[1] === undefined) return false;
  return hashContent(content.slice(match[0].length)) === match[1];
}

export const hostServiceManifestFilesystem: ServiceManifestFilesystem = {
  read: async (path) => readFile(path, "utf8").catch((error: unknown) => isErrno(error, "ENOENT") ? undefined : Promise.reject(error)),
  write: async (path, content) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // Use a unique, exclusive temporary file. A PID-derived name can collide
    // with a concurrent install (or be pre-created as a symlink), causing
    // cross-write corruption or redirecting privileged manifest content.
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, path);
    } finally {
      // A failed write/rename must not leave a privileged manifest snapshot or
      // a reusable temp pathname behind.
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  },
  remove: async (path) => { await rm(path); },
};
export async function installServiceManifest(manifest: ServiceManifest, filesystem: ServiceManifestFilesystem = hostServiceManifestFilesystem, options: InstallServiceManifestOptions = {}): Promise<void> {
  if (manifest.mode === "system" && manifest.executionMode === "privileged_host" && options.confirmPrivilegedHost !== true) {
    throw new Error("privileged_host service installation requires --confirm-privileged-host");
  }
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
    // Service installation and lifecycle commands can run as root/SYSTEM.
    // Never resolve their bare command names through an operator-controlled
    // PATH (or inherit loader/runtime injection variables such as
    // LD_PRELOAD/PYTHONPATH).  The native service tools used below live in
    // these platform directories; a missing tool fails closed instead of
    // executing an arbitrary same-name binary from the caller's environment.
    const executable = process.platform === "win32" ? resolveTrustedWindowsTool(file) : file;
    const child = spawn(executable, [...args], {
      // Keep the cwd and environment in the inbox system directory as a
      // defense in depth. The executable itself has already been resolved to
      // an allow-listed absolute System32 path on Windows.
      cwd: trustedServiceWorkingDirectory(),
      env: trustedServiceEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = ""; let stderr = "";
    child.stdout?.on("data", (value: Buffer) => { stdout = `${stdout}${value.toString("utf8")}`.slice(0, 4_096); });
    child.stderr?.on("data", (value: Buffer) => { stderr = `${stderr}${value.toString("utf8")}`.slice(0, 4_096); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  }),
};

function trustedServiceEnvironment(): NodeJS.ProcessEnv {
  if (process.platform === "win32") {
    const systemRoot = trustedWindowsRoot();
    return trustedWindowsEnvironment(systemRoot);
  }
  return { PATH: process.platform === "darwin" ? "/usr/bin:/bin:/usr/sbin:/sbin" : "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" };
}
function trustedServiceWorkingDirectory(): string {
  if (process.platform !== "win32") return "/";
  return `${trustedWindowsRoot()}\\System32`;
}

/**
 * Idempotent, platform-native setup for Runmesh-owned service state only.
 * It deliberately never changes ownership or permissions of caller Workspace roots.
 */
export function createServiceProvisioner(options: ServiceProvisionerOptions = {}): ServiceProvisioner {
  const platform = options.platform ?? currentServicePlatform();
  const executor = options.executor ?? hostServiceCommandExecutor;
  const execute = async (file: string, args: readonly string[]): Promise<ServiceCommandResult> => executor.execute(file, args);
  const required = async (file: string, args: readonly string[]): Promise<void> => {
    const result = await execute(file, args);
    if (result.exitCode !== 0) throw new Error(`service provisioning command failed: ${[file, ...args].join(" ")}${result.stderr === undefined || result.stderr.trim() === "" ? "" : ` (${result.stderr.trim().slice(0, 512)})`}`);
  };
  return {
    platform,
    provision: async (manifest, profilePath) => {
      if (manifest.mode !== "system" || manifest.executionMode !== "dedicated_user") return { identity: manifest.executionMode === "privileged_host" ? privilegedIdentity(platform) : "interactive", profileSecured: false };
      const layout = serviceLayout({ platform, mode: "system" });
      if (!isDefaultSystemProfile(layout, profilePath)) throw new Error(`dedicated system Runner profiles must be stored at ${serviceProfilePath(layout)}`);
      if (platform === "linux") {
        const identity = dedicatedServiceIdentity();
        if ((await execute("getent", ["group", identity.group])).exitCode !== 0) await required("groupadd", ["--system", identity.group]);
        if ((await execute("id", ["-u", identity.user])).exitCode !== 0) await required("useradd", ["--system", "--gid", identity.group, "--no-create-home", "--shell", "/usr/sbin/nologin", identity.user]);
        await required("mkdir", ["-p", layout.installRoot, layout.configRoot, layout.stateRoot, layout.logRoot]);
        await required("chown", ["root:root", layout.installRoot]); await required("chmod", ["0755", layout.installRoot]);
        await required("chown", [`root:${identity.group}`, layout.configRoot]); await required("chmod", ["0750", layout.configRoot]);
        await required("chown", [`${identity.user}:${identity.group}`, layout.stateRoot, layout.logRoot]); await required("chmod", ["0750", layout.stateRoot, layout.logRoot]);
        if ((await execute("test", ["-f", profilePath])).exitCode === 0) {
          await required("chown", [`root:${identity.group}`, profilePath]); await required("chmod", ["0640", profilePath]);
          return { identity: identity.user, profileSecured: true };
        }
        return { identity: identity.user, profileSecured: false, detail: "profile is not present yet; enroll before installing the service" };
      }
      if (platform === "darwin") {
        const identity = dedicatedServiceIdentity();
        await provisionMacIdentity(execute, required, identity.user, identity.group);
        await required("mkdir", ["-p", layout.installRoot, layout.configRoot, layout.stateRoot, layout.logRoot]);
        await required("chown", ["root:wheel", layout.installRoot]); await required("chmod", ["0755", layout.installRoot]);
        await required("chown", [`root:${identity.group}`, layout.configRoot]); await required("chmod", ["0750", layout.configRoot]);
        await required("chown", [`${identity.user}:${identity.group}`, layout.stateRoot, layout.logRoot]); await required("chmod", ["0750", layout.stateRoot, layout.logRoot]);
        if ((await execute("test", ["-f", profilePath])).exitCode === 0) {
          await required("chown", [`root:${identity.group}`, profilePath]); await required("chmod", ["0640", profilePath]);
          return { identity: identity.user, profileSecured: true };
        }
        return { identity: identity.user, profileSecured: false, detail: "profile is not present yet; enroll before installing the service" };
      }
      const script = windowsProvisionScript(layout, profilePath);
      await required("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]);
      return { identity: "NT AUTHORITY\\LOCAL SERVICE", profileSecured: true };
    },
  };
}

async function provisionMacIdentity(execute: (file: string, args: readonly string[]) => Promise<ServiceCommandResult>, required: (file: string, args: readonly string[]) => Promise<void>, user: string, group: string): Promise<void> {
  let groupId: string;
  if ((await execute("dscl", [".", "-read", `/Groups/${group}`])).exitCode !== 0) {
    groupId = nextDarwinId((await execute("dscl", [".", "-list", "/Groups", "PrimaryGroupID"])).stdout);
    await required("dscl", [".", "-create", `/Groups/${group}`]);
    await required("dscl", [".", "-create", `/Groups/${group}`, "PrimaryGroupID", groupId]);
  } else {
    groupId = parseDarwinId((await execute("dscl", [".", "-read", `/Groups/${group}`, "PrimaryGroupID"])).stdout) ?? "500";
  }
  if ((await execute("dscl", [".", "-read", `/Users/${user}`])).exitCode === 0) return;
  const userId = nextDarwinId((await execute("dscl", [".", "-list", "/Users", "UniqueID"])).stdout);
  await required("dscl", [".", "-create", `/Users/${user}`]);
  await required("dscl", [".", "-create", `/Users/${user}`, "UserShell", "/usr/bin/false"]);
  await required("dscl", [".", "-create", `/Users/${user}`, "RealName", "Runmesh Runner"]);
  await required("dscl", [".", "-create", `/Users/${user}`, "UniqueID", userId]);
  await required("dscl", [".", "-create", `/Users/${user}`, "PrimaryGroupID", groupId]);
  await required("dscl", [".", "-create", `/Users/${user}`, "NFSHomeDirectory", "/var/empty"]);
}
function nextDarwinId(value: string | undefined): string {
  const used = new Set((value ?? "").split(/\s+/).map((part) => Number(part)).filter((part) => Number.isSafeInteger(part) && part >= 500));
  for (let candidate = 500; candidate < 60_000; candidate += 1) if (!used.has(candidate)) return String(candidate);
  throw new Error("could not allocate a macOS service identity ID");
}
function parseDarwinId(value: string | undefined): string | undefined { const match = /\b(\d+)\b/u.exec(value ?? ""); return match?.[1]; }
function windowsProvisionScript(layout: ServiceLayout, profilePath: string): string {
  const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
  const acl = (path: string, grants: readonly string[]): string =>
    // Reset first so a pre-existing install cannot retain an explicit
    // Users/Everyone ACE that /grant:r alone would leave in place. Then turn
    // inheritance off and grant only the service identities we require.
    `& icacls ${quote(path)} /reset | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'icacls reset failed' }; & icacls ${quote(path)} /inheritance:r /grant:r ${grants.map(quote).join(" ")} | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'icacls failed' }; `;
  const roots = [layout.installRoot, layout.configRoot, layout.stateRoot, layout.logRoot].map(quote).join(", ");
  const readGrants = ["BUILTIN\\Administrators:(OI)(CI)F", "NT AUTHORITY\\SYSTEM:(OI)(CI)F", "NT AUTHORITY\\LOCAL SERVICE:(OI)(CI)RX"];
  const modifyGrants = ["BUILTIN\\Administrators:(OI)(CI)F", "NT AUTHORITY\\SYSTEM:(OI)(CI)F", "NT AUTHORITY\\LOCAL SERVICE:(OI)(CI)M"];
  const profileGrants = ["BUILTIN\\Administrators:F", "NT AUTHORITY\\SYSTEM:F", "NT AUTHORITY\\LOCAL SERVICE:R"];
  return `$ErrorActionPreference = 'Stop'; Set-StrictMode -Version Latest; $paths = @(${roots}); foreach ($path in $paths) { New-Item -ItemType Directory -Force -LiteralPath $path | Out-Null }; `
    + acl(layout.installRoot, readGrants)
    + acl(layout.configRoot, readGrants)
    + acl(layout.stateRoot, modifyGrants)
    + acl(layout.logRoot, modifyGrants)
    + `if (-not (Test-Path -LiteralPath ${quote(profilePath)} -PathType Leaf)) { throw 'runner profile is not present' }; `
    + acl(profilePath, profileGrants);
}

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
    return {
      platform, mode,
      install: async () => { await execute("systemctl", [...prefix, "daemon-reload"]); await execute("systemctl", [...prefix, "enable", "--now", LINUX_SERVICE_NAME]); await execute("systemctl", [...prefix, "is-active", "--quiet", LINUX_SERVICE_NAME]); },
      stop: async () => execute("systemctl", [...prefix, "stop", LINUX_SERVICE_NAME]),
      restart: async () => execute("systemctl", [...prefix, "restart", LINUX_SERVICE_NAME]),
      uninstall: async () => execute("systemctl", [...prefix, "disable", "--now", LINUX_SERVICE_NAME]),
      status: async () => {
        const installed = await executor.execute("systemctl", [...prefix, "is-enabled", LINUX_SERVICE_NAME]);
        const active = await executor.execute("systemctl", [...prefix, "is-active", "--quiet", LINUX_SERVICE_NAME]);
        const user = await executor.execute("systemctl", [...prefix, "show", LINUX_SERVICE_NAME, "--property=User", "--value"]);
        const reported = user.exitCode === 0 ? (user.stdout ?? "").trim() : "";
        const identity = reported === "" ? "root" : reported;
        return { installed: installed.exitCode === 0, active: active.exitCode === 0, identity, ...(active.stderr === undefined || active.stderr.trim() === "" ? {} : { detail: active.stderr.trim().slice(0, 512) }) };
      },
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
      status: async () => {
        const result = await executor.execute("launchctl", ["print", target]);
        const match = /(?:user|UserName)\s*=\s*([^\s]+)/u.exec(result.stdout ?? "");
        return { installed: result.exitCode === 0, active: result.exitCode === 0, ...(match?.[1] === undefined ? {} : { identity: match[1] }), ...(result.stderr === undefined || result.stderr.trim() === "" ? {} : { detail: result.stderr.trim().slice(0, 512) }) };
      },
    };
  }
  return {
    platform, mode,
    install: async (manifest) => { await execute("schtasks", ["/Create", "/TN", WINDOWS_TASK_NAME, "/XML", manifest.path, "/F"]); await execute("schtasks", ["/Run", "/TN", WINDOWS_TASK_NAME]); await execute("schtasks", ["/Query", "/TN", WINDOWS_TASK_NAME]); },
    stop: async () => execute("schtasks", ["/End", "/TN", WINDOWS_TASK_NAME]),
    restart: async () => { await execute("schtasks", ["/End", "/TN", WINDOWS_TASK_NAME]); await execute("schtasks", ["/Run", "/TN", WINDOWS_TASK_NAME]); },
    uninstall: async () => {
      // `/Delete` does not terminate an already-running task. Best-effort
      // termination prevents an old Runner from retaining a credential after
      // uninstall; a not-running task is harmless and should not block delete.
      await executor.execute("schtasks", ["/End", "/TN", WINDOWS_TASK_NAME]);
      await execute("schtasks", ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"]);
    },
      status: async () => {
        const installed = await executor.execute("schtasks", ["/Query", "/TN", WINDOWS_TASK_NAME]);
        // `schtasks /FO LIST /V` localizes both field names and state values.
        // Query the Task Scheduler API through PowerShell first and serialize
        // the numeric enum (Running = 4), which is locale-independent. Keep a
        // conservative text fallback for hosts without the ScheduledTasks
        // module and for injected legacy executors.
        const invariant = await executor.execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$task=Get-ScheduledTask -TaskName 'RunmeshRunner' -ErrorAction Stop; $info=Get-ScheduledTaskInfo -TaskName 'RunmeshRunner' -ErrorAction Stop; [pscustomobject]@{ state=[int]$task.State; identity=[string]$task.Principal.UserId } | ConvertTo-Json -Compress"]);
        let invariantState: { readonly state?: unknown; readonly identity?: unknown } | undefined;
        try {
          const parsed = JSON.parse((invariant.stdout ?? "").trim()) as unknown;
          if (typeof parsed === "object" && parsed !== null) invariantState = parsed as { readonly state?: unknown; readonly identity?: unknown };
        } catch { /* use the text fallback below */ }
        if (invariant.exitCode === 0 && invariantState !== undefined && (typeof invariantState.state === "number" || typeof invariantState.state === "string")) {
          const state = typeof invariantState.state === "number" ? invariantState.state : Number(invariantState.state);
          const identity = typeof invariantState.identity === "string" ? invariantState.identity.trim() : "";
          return { installed: installed.exitCode === 0, active: state === 4, ...(identity === "" ? {} : { identity }), ...(invariant.stderr === undefined || invariant.stderr.trim() === "" ? {} : { detail: invariant.stderr.trim().slice(0, 512) }) };
        }
        const detail = await executor.execute("schtasks", ["/Query", "/TN", WINDOWS_TASK_NAME, "/FO", "LIST", "/V"]);
      // Task Scheduler reports `Ready` for an installed task that is not
      // currently executing. Treat only `Running` as active; conflating the
      // two makes `doctor` report a stopped/crashed Runner as healthy.
      const active = detail.exitCode === 0 && /Status:\s*Running/iu.test(detail.stdout ?? "");
      const identity = /Run As User:\s*(.+)/iu.exec(detail.stdout ?? "")?.[1]?.trim();
      return { installed: installed.exitCode === 0, active, ...(identity === undefined || identity === "" ? {} : { identity }), ...(detail.stderr === undefined || detail.stderr.trim() === "" ? {} : { detail: detail.stderr.trim().slice(0, 512) }) };
    },
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

function privilegedIdentity(platform: ServicePlatform): string { return platform === "win32" ? "SYSTEM" : "root"; }
function isAbsoluteForPlatform(value: string, platform: ServicePlatform): boolean { return platform === "win32" ? win32.isAbsolute(value) : value.startsWith("/"); }
/** Service managers may choose an arbitrary cwd; never emit relative state paths. */
function absoluteServicePath(value: string, platform: ServicePlatform): string {
  const path = platform === "win32" ? win32 : posix;
  return path.normalize(path.isAbsolute(value) ? value : path.resolve(value));
}
function safeServiceIdentity(value: string): boolean { return /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(value); }
function escapeSystemdArgument(value: string): string { return escapeSystemdValue(value, true); }
function escapeSystemdEnvironment(value: string): string { return escapeSystemdValue(value, false); }
/** Escape systemd unit-file values without allowing specifier or line injection. */
function escapeSystemdValue(value: string, escapeSpaces: boolean): string {
  let escaped = "";
  for (const character of value) {
    const code = character.codePointAt(0) as number;
    if (character === "%") escaped += "%%";
    else if (character === "\\") escaped += "\\\\";
    else if (character === '"') escaped += "\\\"";
    else if (character === " " && escapeSpaces) escaped += "\\x20";
    else if (code < 0x20 || code === 0x7f) escaped += `\\x${code.toString(16).padStart(2, "0")}`;
    else escaped += character;
  }
  return escaped;
}
function escapeXml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }
/**
 * Quote one argument for the command-line string consumed by a Windows
 * scheduled task.  Backslashes immediately before a quote (including the
 * closing quote) must be doubled according to CommandLineToArgvW rules;
 * otherwise a path such as `C:\\Program Files\\Runmesh\\` loses its final
 * separator or absorbs the closing quote. Empty arguments are quoted too.
 */
function quoteWindowsArgument(value: string): string {
  if (value.length > 0 && !/[\s"]/u.test(value)) return value;
  let result = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      result += "\\".repeat(backslashes * 2 + 1);
      result += '"';
      backslashes = 0;
      continue;
    }
    result += "\\".repeat(backslashes);
    result += character;
    backslashes = 0;
  }
  // Escape backslashes before the terminating quote, which is itself
  // syntactically significant to the Windows command-line parser.
  result += "\\".repeat(backslashes * 2);
  return `${result}"`;
}
function windowsArguments(values: readonly string[]): string { return values.map(quoteWindowsArgument).join(" "); }
function isErrno(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code; }
