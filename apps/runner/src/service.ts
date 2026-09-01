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
  /** Operator-selected dedicated identity, when present in a managed unit. */
  readonly serviceUser?: string;
  readonly serviceGroup?: string;
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
  /**
   * Whether a native registration/unit exists, independent from its enabled
   * or active state. `undefined` means the adapter could not prove either
   * answer (or is a legacy injected adapter); callers must fail closed when
   * replacing an unmanaged registration.
   */
  readonly registered?: boolean;
  /** Identity reported by the host service manager, when its native query exposes it. */
  readonly identity?: string;
  readonly detail?: string;
  /**
   * False means the native probe could not distinguish an absent service from
   * a query/tool/permission failure.  Omitted is retained for injected legacy
   * adapters and is treated as reliable by callers for compatibility.
   */
  readonly reliable?: boolean;
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
  /**
   * Disable a native registration without deleting its managed definition.
   * This is optional for injected/legacy adapters; rollback uses it when a
   * pre-existing unit was registered but deliberately disabled.
   */
  readonly disable?: (manifest: ServiceManifest) => Promise<void>;
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
  const configuredHome = options.home ?? homedir();
  // Rendering a target platform is also used by cross-platform release and
  // migration tests.  Do not splice a Windows host home (or a POSIX host home)
  // into the other platform's path grammar and then emit a relative service
  // executable.  An explicit `home` always wins; otherwise use a harmless,
  // target-shaped placeholder when the host spelling is incompatible; a
  // compatible explicit home is preserved verbatim.
  const home = platform === "win32"
    ? isWindowsAbsolute(configuredHome) ? configuredHome : "C:\\Users\\runmesh"
    : configuredHome.startsWith("/") ? configuredHome : platform === "darwin" ? "/Users/runmesh" : "/home/runmesh";
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
  return { platform, mode, executionMode, path: layout.manifestPath, content, hash, serviceUser: identity.user, serviceGroup: identity.group };
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
  // The marker is an ownership boundary, not merely an annotation.  Require
  // it to be the first line so an arbitrary preamble cannot be smuggled in
  // front of a valid hash and then be treated as a native definition we own.
  const match = /^(?:#\s*|<!--\s*)runmesh-runner-managed:([0-9a-f]{8})\s*(?:-->)?\r?\n/u.exec(content);
  if (match === null || match[1] === undefined) return false;
  return hashContent(content.slice(match[0].length)) === match[1];
}

/**
 * Attach the metadata of a rendered manifest to an already validated managed
 * definition without re-rendering its body.  This is used for idempotent
 * installs and rollback so operator-supplied executable paths and service
 * options remain byte-for-byte intact.
 */
export function managedServiceManifestFromContent(manifest: ServiceManifest, content: string, executionMode: ExecutionMode = manifest.executionMode): ServiceManifest {
  if (executionMode !== "dedicated_user" && executionMode !== "privileged_host") throw new Error("execution mode must be dedicated_user or privileged_host");
  if (!isManagedService(content)) throw new Error("cannot use an unmanaged service manifest");
  const marker = /^(?:#\s*|<!--\s*)runmesh-runner-managed:[0-9a-f]{8}\s*(?:-->)?\r?\n/u.exec(content);
  if (marker === null) throw new Error("managed service manifest is malformed");
  const body = content.slice(marker[0].length);
  const identity = executionMode === "dedicated_user" ? dedicatedIdentityFromContent(manifest.platform, body) : {};
  return { ...manifest, executionMode, content, hash: hashContent(body), ...identity };
}

/**
 * Reuse an existing managed service definition while changing only its
 * execution identity.  Installers from older releases may have an explicit
 * executable path or a custom dedicated account; re-rendering from defaults
 * during migration would silently discard those operator choices.  The
 * manifest marker is checked before this transformation, and identity values
 * are restricted to the same account grammar used by the renderer.
 */
export function rewriteManagedServiceExecutionMode(manifest: ServiceManifest, existingContent: string, executionMode: ExecutionMode): ServiceManifest {
  if (manifest.mode !== "system") throw new Error("execution-mode rewrites require a system service manifest");
  if (executionMode !== "dedicated_user" && executionMode !== "privileged_host") throw new Error("execution mode must be dedicated_user or privileged_host");
  if (!isManagedService(existingContent)) throw new Error("cannot rewrite an unmanaged service manifest");
  const marker = /^(?:#\s*|<!--\s*)runmesh-runner-managed:[0-9a-f]{8}\s*(?:-->)?\r?\n/u.exec(existingContent);
  if (marker === null) throw new Error("managed service manifest is malformed");
  const body = existingContent.slice(marker[0].length);
  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  let rewritten = body;
  if (manifest.platform === "linux") rewritten = rewriteSystemdIdentity(body, executionMode, newline);
  else if (manifest.platform === "darwin") rewritten = rewriteLaunchdIdentity(body, executionMode);
  else rewritten = rewriteWindowsIdentity(body, executionMode);
  const hash = hashContent(rewritten);
  const content = manifest.platform === "linux" ? `# ${MARKER}:${hash}${newline}${rewritten}` : `<!-- ${MARKER}:${hash} -->${newline}${rewritten}`;
  const identity = executionMode === "dedicated_user" ? dedicatedIdentityFromContent(manifest.platform, rewritten) : {};
  return { ...manifest, executionMode, content, hash, ...identity };
}

function dedicatedIdentityFromContent(platform: ServicePlatform, body: string): { readonly serviceUser?: string; readonly serviceGroup?: string } {
  if (platform === "linux") {
    const lines = body.split(/\r?\n/u);
    const user = serviceIdentityFromLine(lines, "User");
    const group = serviceIdentityFromLine(lines, "Group") ?? user;
    if (user !== undefined && group !== undefined && safeServiceIdentity(user) && safeServiceIdentity(group)) return { serviceUser: user, serviceGroup: group };
    return {};
  }
  if (platform === "darwin") {
    const user = /<key>UserName<\/key><string>([^<]*)<\/string>/u.exec(body)?.[1];
    return user !== undefined && safeServiceIdentity(user) ? { serviceUser: user, serviceGroup: user } : {};
  }
  return {};
}

function rewriteSystemdIdentity(body: string, executionMode: ExecutionMode, newline: string): string {
  const lines = body.split(/\r?\n/u);
  const user = serviceIdentityFromLine(lines, "User") ?? DEDICATED_SERVICE_USER;
  const group = serviceIdentityFromLine(lines, "Group") ?? user;
  if (!safeServiceIdentity(user) || !safeServiceIdentity(group)) throw new Error("managed service manifest has an invalid dedicated service identity");
  const filtered = lines.filter((line) => !/^\s*(?:User|Group)\s*=/u.test(line));
  if (executionMode === "dedicated_user") {
    const typeIndex = filtered.findIndex((line) => /^\s*Type\s*=\s*simple\s*$/u.test(line));
    if (typeIndex < 0) throw new Error("managed systemd manifest is missing its service section");
    filtered.splice(typeIndex + 1, 0, `User=${user}`, `Group=${group}`);
  }
  return filtered.join(newline);
}

function serviceIdentityFromLine(lines: readonly string[], key: "User" | "Group"): string | undefined {
  const line = lines.find((value) => new RegExp(`^\\s*${key}\\s*=`, "u").test(value));
  if (line === undefined) return undefined;
  const value = line.replace(new RegExp(`^\\s*${key}\\s*=\\s*`, "u"), "").trim();
  return value.length === 0 ? undefined : value;
}

function rewriteLaunchdIdentity(body: string, executionMode: ExecutionMode): string {
  const match = /<key>UserName<\/key><string>([^<]*)<\/string>/u.exec(body);
  const existing = match?.[1];
  const user = existing === undefined || existing.length === 0 ? DEDICATED_SERVICE_USER : existing;
  if (!safeServiceIdentity(user)) throw new Error("managed launchd manifest has an invalid dedicated service identity");
  const withoutIdentity = body.replace(/<key>UserName<\/key><string>[^<]*<\/string>/gu, "");
  if (executionMode === "privileged_host") return withoutIdentity;
  const label = /(<key>Label<\/key><string>[^<]*<\/string>)/u;
  if (!label.test(withoutIdentity)) throw new Error("managed launchd manifest is missing its label");
  return withoutIdentity.replace(label, `$1<key>UserName</key><string>${escapeXml(user)}</string>`);
}

function rewriteWindowsIdentity(body: string, executionMode: ExecutionMode): string {
  const userId = executionMode === "privileged_host" ? "SYSTEM" : "NT AUTHORITY\\LOCAL SERVICE";
  const runLevel = executionMode === "privileged_host" ? "HighestAvailable" : "LeastPrivilege";
  if (!/<UserId>[^<]*<\/UserId>/u.test(body) || !/<RunLevel>[^<]*<\/RunLevel>/u.test(body)) throw new Error("managed Windows task manifest is missing its principal");
  return body.replace(/<UserId>[^<]*<\/UserId>/u, `<UserId>${userId}</UserId>`).replace(/<RunLevel>[^<]*<\/RunLevel>/u, `<RunLevel>${runLevel}</RunLevel>`);
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
/**
 * Install a managed manifest and report whether its bytes changed.  The
 * change bit is deliberately calculated before the atomic write so callers
 * can decide whether a running service needs a restart.  Returning a boolean
 * is backwards compatible with callers that only await the operation.
 */
export async function installServiceManifest(manifest: ServiceManifest, filesystem: ServiceManifestFilesystem = hostServiceManifestFilesystem, options: InstallServiceManifestOptions = {}): Promise<boolean> {
  if (manifest.mode === "system" && manifest.executionMode === "privileged_host" && options.confirmPrivilegedHost !== true) {
    throw new Error("privileged_host service installation requires --confirm-privileged-host");
  }
  const existing = await filesystem.read(manifest.path);
  if (existing !== undefined && !isManagedService(existing)) throw new Error(`refusing to overwrite unmanaged service manifest: ${manifest.path}`);
  const changed = existing !== manifest.content;
  if (changed) await filesystem.write(manifest.path, manifest.content);
  return changed;
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
      if (manifest.mode !== "system") return { identity: "interactive", profileSecured: true };
      const layout = serviceLayout({ platform, mode: "system" });
      // A machine service must never be pointed at an operator-selected
      // profile path.  In particular, a SYSTEM/root service loading a file
      // from a user-controlled directory would turn that directory into a
      // durable privilege-escalation boundary.  Keep the canonical profile
      // location for both execution modes; user services can still use an
      // explicit profile through the foreground CLI.
      if (!isDefaultSystemProfile(layout, profilePath)) throw new Error(`system Runner profiles must be stored at ${serviceProfilePath(layout)}`);
      if (platform === "linux") {
        if (manifest.executionMode === "privileged_host") {
          // The privileged unit intentionally has no User=/Group= directive,
          // so all Runmesh-owned service state must remain root-only.  Do not
          // create or chown anything to the restricted `runmesh` account on
          // this path; doing so would both misreport identity and strand a
          // root service from its credential.
          await required("mkdir", ["-p", layout.installRoot, layout.configRoot, layout.stateRoot, layout.logRoot]);
          await required("chown", ["root:root", layout.installRoot, layout.configRoot, layout.stateRoot, layout.logRoot]);
          // A root service must not execute a package tree writable by a
          // non-root principal. Tighten every real package directory below
          // the Runmesh install root without following symlinks or changing
          // executable bits supplied by the verified package. The portable
          // installer creates `current` as a root-owned link to a version
          // directory inside this root; refusing to follow links here keeps a
          // malformed link from redirecting chown/chmod outside Runmesh.
          await securePosixInstallTree(required, layout.installRoot, "root:root", platform);
          await required("chmod", ["0755", layout.installRoot]);
          await required("chmod", ["0700", layout.configRoot, layout.stateRoot, layout.logRoot]);
          await securePosixTree(required, layout.configRoot, "root:root", "0700", "0600", platform);
          await securePosixTree(required, layout.stateRoot, "root:root", "0700", "0600", platform);
          await securePosixTree(required, layout.logRoot, "root:root", "0700", "0600", platform);
          if ((await execute("test", ["-f", profilePath])).exitCode === 0) {
            await required("chown", ["root:root", profilePath]);
            await required("chmod", ["0600", profilePath]);
            return { identity: "root", profileSecured: true };
          }
          return { identity: "root", profileSecured: false, detail: "profile is not present yet; enroll before installing the service" };
        }
        const identity = dedicatedServiceIdentity(manifest);
        if ((await execute("getent", ["group", identity.group])).exitCode !== 0) await required("groupadd", ["--system", identity.group]);
        if ((await execute("id", ["-u", identity.user])).exitCode !== 0) await required("useradd", ["--system", "--gid", identity.group, "--no-create-home", "--shell", "/usr/sbin/nologin", identity.user]);
        await required("mkdir", ["-p", layout.installRoot, layout.configRoot, layout.stateRoot, layout.logRoot]);
        await required("chown", ["root:root", layout.installRoot]); await required("chmod", ["0755", layout.installRoot]);
        await securePosixInstallTree(required, layout.installRoot, "root:root", platform);
        await required("chown", [`root:${identity.group}`, layout.configRoot]); await required("chmod", ["0750", layout.configRoot]);
        await required("chown", [`${identity.user}:${identity.group}`, layout.stateRoot, layout.logRoot]); await required("chmod", ["0750", layout.stateRoot, layout.logRoot]);
        await securePosixTree(required, layout.configRoot, `root:${identity.group}`, "0750", "0640", platform);
        await securePosixTree(required, layout.stateRoot, `${identity.user}:${identity.group}`, "0750", "0640", platform);
        await securePosixTree(required, layout.logRoot, `${identity.user}:${identity.group}`, "0750", "0640", platform);
        if ((await execute("test", ["-f", profilePath])).exitCode === 0) {
          await required("chown", [`root:${identity.group}`, profilePath]); await required("chmod", ["0640", profilePath]);
          return { identity: identity.user, profileSecured: true };
        }
        return { identity: identity.user, profileSecured: false, detail: "profile is not present yet; enroll before installing the service" };
      }
      if (platform === "darwin") {
        if (manifest.executionMode === "privileged_host") {
          await required("mkdir", ["-p", layout.installRoot, layout.configRoot, layout.stateRoot, layout.logRoot]);
          await required("chown", ["root:wheel", layout.installRoot, layout.configRoot, layout.stateRoot, layout.logRoot]);
          await securePosixInstallTree(required, layout.installRoot, "root:wheel", platform);
          await required("chmod", ["0755", layout.installRoot]);
          await required("chmod", ["0700", layout.configRoot, layout.stateRoot, layout.logRoot]);
          await securePosixTree(required, layout.configRoot, "root:wheel", "0700", "0600", platform);
          await securePosixTree(required, layout.stateRoot, "root:wheel", "0700", "0600", platform);
          await securePosixTree(required, layout.logRoot, "root:wheel", "0700", "0600", platform);
          if ((await execute("test", ["-f", profilePath])).exitCode === 0) {
            await required("chown", ["root:wheel", profilePath]);
            await required("chmod", ["0600", profilePath]);
            return { identity: "root", profileSecured: true };
          }
          return { identity: "root", profileSecured: false, detail: "profile is not present yet; enroll before installing the service" };
        }
        const identity = dedicatedServiceIdentity(manifest);
        await provisionMacIdentity(execute, required, identity.user, identity.group);
        await required("mkdir", ["-p", layout.installRoot, layout.configRoot, layout.stateRoot, layout.logRoot]);
        await required("chown", ["root:wheel", layout.installRoot]); await required("chmod", ["0755", layout.installRoot]);
        await securePosixInstallTree(required, layout.installRoot, "root:root", platform);
        await required("chown", [`root:${identity.group}`, layout.configRoot]); await required("chmod", ["0750", layout.configRoot]);
        await required("chown", [`${identity.user}:${identity.group}`, layout.stateRoot, layout.logRoot]); await required("chmod", ["0750", layout.stateRoot, layout.logRoot]);
        await securePosixTree(required, layout.configRoot, `root:${identity.group}`, "0750", "0640", platform);
        await securePosixTree(required, layout.stateRoot, `${identity.user}:${identity.group}`, "0750", "0640", platform);
        await securePosixTree(required, layout.logRoot, `${identity.user}:${identity.group}`, "0750", "0640", platform);
        if ((await execute("test", ["-f", profilePath])).exitCode === 0) {
          await required("chown", [`root:${identity.group}`, profilePath]); await required("chmod", ["0640", profilePath]);
          return { identity: identity.user, profileSecured: true };
        }
        return { identity: identity.user, profileSecured: false, detail: "profile is not present yet; enroll before installing the service" };
      }
      const script = windowsProvisionScript(layout, profilePath, manifest.executionMode);
      await required("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]);
      return { identity: manifest.executionMode === "privileged_host" ? "NT AUTHORITY\\SYSTEM" : "NT AUTHORITY\\LOCAL SERVICE", profileSecured: true };
    },
  };
}

/**
 * Tighten existing Runmesh-owned trees without following symlinks or crossing
 * filesystem mounts. Workspace roots are never passed to this helper.
 */
async function securePosixTree(required: (file: string, args: readonly string[]) => Promise<void>, root: string, owner: string, directoryMode: string, fileMode: string, platform: ServicePlatform = currentServicePlatform()): Promise<void> {
  const noCrossDevice = platform === "darwin" ? "-x" : "-xdev";
  await required("find", ["-P", root, noCrossDevice, "-type", "d", "-exec", "chown", owner, "{}", "+"]);
  await required("find", ["-P", root, noCrossDevice, "-type", "f", "-exec", "chown", owner, "{}", "+"]);
  await required("find", ["-P", root, noCrossDevice, "-type", "d", "-exec", "chmod", directoryMode, "{}", "+"]);
  await required("find", ["-P", root, noCrossDevice, "-type", "f", "-exec", "chmod", fileMode, "{}", "+"]);
}

/** Remove group/other write access from the package tree while preserving
 * the executable/read bits selected by the verified package itself. */
async function securePosixInstallTree(required: (file: string, args: readonly string[]) => Promise<void>, root: string, owner: string, platform: ServicePlatform = currentServicePlatform()): Promise<void> {
  const noCrossDevice = platform === "darwin" ? "-x" : "-xdev";
  await required("find", ["-P", root, noCrossDevice, "-type", "d", "-exec", "chown", owner, "{}", "+"]);
  await required("find", ["-P", root, noCrossDevice, "-type", "f", "-exec", "chown", owner, "{}", "+"]);
  await required("find", ["-P", root, noCrossDevice, "-type", "d", "-exec", "chmod", "a-w", "{}", "+"]);
  await required("find", ["-P", root, noCrossDevice, "-type", "f", "-exec", "chmod", "a-w", "{}", "+"]);
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
function windowsProvisionScript(layout: ServiceLayout, profilePath: string, executionMode: ExecutionMode = "dedicated_user"): string {
  const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
  const acl = (path: string, grants: readonly string[], recursive = true): string =>
    // Reset first so a pre-existing install cannot retain an explicit
    // Users/Everyone ACE that /grant:r alone would leave in place. Then turn
    // inheritance off and grant only the service identities we require.
    `& icacls ${quote(path)} /reset${recursive ? " /T" : ""} | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'icacls reset failed' }; & icacls ${quote(path)} /inheritance:r /grant:r ${grants.map(quote).join(" ")}${recursive ? " /T" : ""} | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'icacls failed' }; `;
  const roots = [layout.installRoot, layout.configRoot, layout.stateRoot, layout.logRoot].map(quote).join(", ");
  // SYSTEM is the only service principal needed by privileged_host.  Keep
  // Local Service out of that ACL so a restricted account cannot read or
  // tamper with the privileged Runner credential.  The dedicated path keeps
  // its narrower read/modify grants for backwards compatibility.
  const privileged = executionMode === "privileged_host";
  const readGrants = privileged
    ? ["BUILTIN\\Administrators:(OI)(CI)F", "NT AUTHORITY\\SYSTEM:(OI)(CI)F"]
    : ["BUILTIN\\Administrators:(OI)(CI)F", "NT AUTHORITY\\SYSTEM:(OI)(CI)F", "NT AUTHORITY\\LOCAL SERVICE:(OI)(CI)RX"];
  const modifyGrants = privileged
    ? ["BUILTIN\\Administrators:(OI)(CI)F", "NT AUTHORITY\\SYSTEM:(OI)(CI)F"]
    : ["BUILTIN\\Administrators:(OI)(CI)F", "NT AUTHORITY\\SYSTEM:(OI)(CI)F", "NT AUTHORITY\\LOCAL SERVICE:(OI)(CI)M"];
  const profileGrants = privileged
    ? ["BUILTIN\\Administrators:F", "NT AUTHORITY\\SYSTEM:F"]
    : ["BUILTIN\\Administrators:F", "NT AUTHORITY\\SYSTEM:F", "NT AUTHORITY\\LOCAL SERVICE:R"];
  return `$ErrorActionPreference = 'Stop'; Set-StrictMode -Version Latest; $paths = @(${roots}); foreach ($path in $paths) { New-Item -ItemType Directory -Force -LiteralPath $path | Out-Null }; `
    + acl(layout.installRoot, readGrants)
    + acl(layout.configRoot, readGrants)
    + acl(layout.stateRoot, modifyGrants)
    + acl(layout.logRoot, modifyGrants)
    + `if (-not (Test-Path -LiteralPath ${quote(profilePath)} -PathType Leaf)) { throw 'runner profile is not present' }; `
    + acl(profilePath, profileGrants, false);
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
      // Rollback of a previously disabled/masked/linked unit must not call
      // install(), because install enables and starts the unit.  Probe the
      // current enablement first and disable only an explicit enabled state;
      // leaving masked/linked/static states untouched preserves the operator's
      // registration rather than deleting or rewriting its symlink.
      disable: async () => {
        // The candidate manifest may already have been daemon-reloaded before
        // its lifecycle command failed. Reload the restored bytes while the
        // unit is still stopped, without changing its enablement state.
        await execute("systemctl", [...prefix, "daemon-reload"]);
        const current = await executor.execute("systemctl", [...prefix, "is-enabled", LINUX_SERVICE_NAME]);
        const state = systemdEnablementState(current);
        if (state === "enabled" || state === "enabled-runtime") {
          await execute("systemctl", [...prefix, "disable", LINUX_SERVICE_NAME]);
          return;
        }
        if (state === undefined) throw new Error("could not determine systemd unit enablement while restoring rollback state");
      },
      restart: async () => execute("systemctl", [...prefix, "restart", LINUX_SERVICE_NAME]),
      uninstall: async () => execute("systemctl", [...prefix, "disable", "--now", LINUX_SERVICE_NAME]),
      status: async (manifest) => {
        const installed = await executor.execute("systemctl", [...prefix, "is-enabled", LINUX_SERVICE_NAME]);
        const active = await executor.execute("systemctl", [...prefix, "is-active", "--quiet", LINUX_SERVICE_NAME]);
        const user = await executor.execute("systemctl", [...prefix, "show", LINUX_SERVICE_NAME, "--property=User", "--value"]);
        const installedReliable = nativeProbeReliable(installed, "enabled");
        const userReliable = nativeProbeReliable(user, "query");
        // `systemctl is-active --quiet` returns exit 4 with no output for a
        // missing unit on several systemd versions.  That code is otherwise
        // ambiguous (for example when a D-Bus query fails), so accept it as
        // a reliable inactive result only when the companion is-enabled/show
        // probes independently report a known absent/disabled unit.
        const activeReliable = nativeProbeReliable(active, "active", knownNonActiveUnit(installed) || knownNonActiveUnit(user));
        const registered = systemdRegistrationState(installed);
        const reliable = installedReliable && activeReliable && userReliable && registered !== undefined;
        const userProbeSucceeded = user.exitCode === 0;
        const reported = userProbeSucceeded ? safeServiceReportedIdentity((user.stdout ?? "").trim()) : undefined;
        // An empty, successful `systemctl show User` means the native default
        // (root) for a privileged system unit.  A failed identity probe is
        // different from an empty value and must remain unknown so install /
        // doctor cannot claim a privilege transition was verified.
        const identity = userProbeSucceeded && reported === undefined && manifest.mode === "system" && manifest.executionMode === "privileged_host" ? "root" : reported;
        return { installed: installed.exitCode === 0, active: active.exitCode === 0, ...(registered === undefined ? {} : { registered }), reliable, ...(identity === undefined ? {} : { identity }), ...(active.stderr === undefined || active.stderr.trim() === "" ? {} : { detail: active.stderr.trim().slice(0, 512) }) };
      },
    };
  }
  if (platform === "darwin") {
    const domain = mode === "system" ? "system" : `gui/${process.getuid?.() ?? 0}`;
    const target = `${domain}/${MACOS_LABEL}`;
    return {
      platform, mode,
      install: async (manifest) => {
        // `bootstrap` rejects an already-loaded label.  Retry only this exact
        // Runmesh label after confirming it is already loaded and booting it
        // out.  A permission or malformed-plist failure must not be masked by
        // an unconditional bootout attempt.
        const bootstrapped = await executor.execute("launchctl", ["bootstrap", domain, manifest.path]);
        if (bootstrapped.exitCode !== 0) {
          const loaded = await executor.execute("launchctl", ["print", target]);
          if (loaded.exitCode !== 0) {
            const detail = bootstrapped.stderr === undefined || bootstrapped.stderr.trim() === "" ? "" : ` (${bootstrapped.stderr.trim().slice(0, 512)})`;
            throw new Error(`service command failed: launchctl bootstrap ${domain} ${manifest.path}${detail}`);
          }
          await execute("launchctl", ["bootout", target]);
          await execute("launchctl", ["bootstrap", domain, manifest.path]);
        }
        await execute("launchctl", ["enable", target]);
        await execute("launchctl", ["print", target]);
      },
      stop: async () => execute("launchctl", ["kill", "SIGTERM", target]),
      restart: async () => execute("launchctl", ["kickstart", "-k", target]),
      uninstall: async () => execute("launchctl", ["bootout", target]),
      status: async (manifest) => {
        const result = await executor.execute("launchctl", ["print", target]);
        const match = /(?:user|UserName)\s*=\s*([^\s]+)/u.exec(result.stdout ?? "");
        // A system LaunchDaemon that omits UserName is launched as root by
        // launchd. Report that native default explicitly so the status and
        // doctor layers can distinguish it from an unavailable identity.
        const state = /^\s*state\s*=\s*([^\s]+)\s*$/imu.exec(result.stdout ?? "")?.[1]?.toLowerCase();
        // launchctl can report a loaded job whose last process already
        // exited. Treat explicit non-running states as inactive; when older
        // launchctl output omits a state line, retain the successful print
        // result as the best available probe and let the identity check carry
        // the remaining safety signal.
        const active = result.exitCode === 0 && (state === undefined || state === "running" || state === "active");
        let identity = result.exitCode === 0
          ? safeServiceReportedIdentity(match?.[1]) ?? (manifest.mode === "system" && manifest.executionMode === "privileged_host" ? "root" : undefined)
          : undefined;
        // Some launchctl versions expose the configured UserName as a UID
        // (`user = 501`) rather than the account name. Resolve it when the
        // native lookup is available; servicePrivilegeState also recognizes a
        // non-zero UID as restricted for a dedicated macOS daemon.
        if (identity !== undefined && /^\d+$/u.test(identity)) {
          try {
            const resolved = await executor.execute("id", ["-un", identity]);
            const name = resolved.exitCode === 0 ? safeServiceReportedIdentity(resolved.stdout?.trim()) : undefined;
            if (name !== undefined) identity = name;
          } catch {
            // Identity resolution is an enhancement only; retain the numeric
            // UID so the privilege-state check can still classify the daemon.
          }
        }
        const reliable = nativeProbeReliable(result, "query");
        const registered = reliable ? result.exitCode === 0 : undefined;
        return { installed: result.exitCode === 0, active, ...(registered === undefined ? {} : { registered }), reliable, ...(identity === undefined ? {} : { identity }), ...(result.stderr === undefined || result.stderr.trim() === "" ? {} : { detail: result.stderr.trim().slice(0, 512) }) };
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
        // Query the Task Scheduler COM API through PowerShell first and
        // serialize the numeric enum (Running = 4), which is locale-
        // independent and available even when the ScheduledTasks module is
        // missing. Keep a conservative text fallback for injected/very old
        // executors; a localized state that cannot be proven to be Running is
        // reported inactive rather than guessed active.
        let invariant: ServiceCommandResult | undefined;
        try {
          invariant = await executor.execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$service=New-Object -ComObject 'Schedule.Service'; $service.Connect(); $task=$service.GetFolder('\\').GetTask('RunmeshRunner'); [pscustomobject]@{ state=[int]$task.State; identity=[string]$task.Definition.Principal.UserId } | ConvertTo-Json -Compress"]);
        } catch {
          // Injected/older executors may not expose PowerShell. Fall through
          // to the conservative schtasks text probe below.
          invariant = undefined;
        }
        let invariantState: { readonly state?: unknown; readonly identity?: unknown } | undefined;
        try {
          const parsed = JSON.parse((invariant?.stdout ?? "").trim()) as unknown;
          if (typeof parsed === "object" && parsed !== null) invariantState = parsed as { readonly state?: unknown; readonly identity?: unknown };
        } catch { /* use the text fallback below */ }
        if (invariant?.exitCode === 0 && invariantState !== undefined && (typeof invariantState.state === "number" || typeof invariantState.state === "string")) {
          const state = typeof invariantState.state === "number" ? invariantState.state : Number(invariantState.state);
          const identity = typeof invariantState.identity === "string" ? safeServiceReportedIdentity(invariantState.identity) ?? "" : "";
          const queryReliable = nativeProbeReliable(installed, "query") && nativeProbeReliable(invariant, "query");
          const registered = queryReliable ? true : undefined;
          return { installed: true, active: state === 4, ...(registered === undefined ? {} : { registered }), reliable: queryReliable, ...(identity === "" ? {} : { identity }), ...(invariant.stderr === undefined || invariant.stderr.trim() === "" ? {} : { detail: invariant.stderr.trim().slice(0, 512) }) };
        }
        const detail = await executor.execute("schtasks", ["/Query", "/TN", WINDOWS_TASK_NAME, "/FO", "LIST", "/V"]);
        // Task Scheduler reports `Ready` for an installed task that is not
        // currently executing. Treat only `Running` as active; conflating the
        // two makes `doctor` report a stopped/crashed Runner as healthy.
        const active = detail.exitCode === 0 && /Status:\s*Running/iu.test(detail.stdout ?? "");
        const identity = safeServiceReportedIdentity(/Run As User:\s*(.+)/iu.exec(detail.stdout ?? "")?.[1]);
        const queryReliable = nativeProbeReliable(installed, "query") && nativeProbeReliable(detail, "query");
        const registered = queryReliable ? detail.exitCode === 0 || installed.exitCode === 0 : undefined;
        return { installed: installed.exitCode === 0, active, ...(registered === undefined ? {} : { registered }), reliable: queryReliable, ...(identity === undefined || identity === "" ? {} : { identity }), ...(detail.stderr === undefined || detail.stderr.trim() === "" ? {} : { detail: detail.stderr.trim().slice(0, 512) }) };
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

export type ServicePrivilegeState = "privileged" | "restricted" | "mismatch" | "unknown";

/** The identity a manifest asks the native service manager to use. */
export function expectedServiceIdentity(manifest: Pick<ServiceManifest, "platform" | "mode" | "executionMode" | "serviceUser">): string | undefined {
  if (manifest.mode !== "system") return undefined;
  if (manifest.executionMode === "privileged_host") return privilegedIdentity(manifest.platform);
  return manifest.platform === "win32" ? "NT AUTHORITY\\LOCAL SERVICE" : manifest.serviceUser ?? "runmesh";
}

/**
 * Compare a service-manager identity with the manifest contract.  Status
 * probes are allowed to omit identity (for example an unloaded launchd
 * job); that is unknown rather than an implicit success.  The comparison is
 * intentionally conservative and never treats a privileged request as
 * satisfied by an arbitrary account name.
 */
export function servicePrivilegeState(manifest: Pick<ServiceManifest, "platform" | "mode" | "executionMode" | "serviceUser">, actualIdentity: string | undefined, active = true): ServicePrivilegeState {
  if (!active || actualIdentity === undefined || actualIdentity.trim() === "") return "unknown";
  const expected = expectedServiceIdentity(manifest);
  const normalize = (value: string): string => value.trim().replaceAll("/", "\\").toLowerCase();
  const actual = normalize(actualIdentity);
  // A user-level service must never be considered healthy when its manager
  // reports a host-wide identity.  We cannot require an exact username here
  // (the interactive account is platform-specific), but we can fail closed
  // for the identities that would constitute an unintended elevation.
  if (expected === undefined) {
    const hostPrivileged = manifest.platform === "win32"
      ? actual === "system" || actual === "nt authority\\system" || actual === "s-1-5-18"
      : actual === "root" || actual === "0" || actual === "uid=0";
    return hostPrivileged ? "mismatch" : "restricted";
  }
  // launchctl can expose a numeric UID.  Only a successful `id -un` lookup
  // proves which configured account owns that UID; accepting every non-zero
  // number would turn an arbitrary restricted account into a healthy
  // dedicated service. UID 0 is an explicit elevation mismatch, while an
  // unresolved non-zero UID remains unknown and must be re-probed.
  if (manifest.platform === "darwin" && manifest.executionMode === "dedicated_user" && /^\d+$/u.test(actual)) {
    return actual === "0" ? "mismatch" : "unknown";
  }
  const wanted = normalize(expected);
  const matches = actual === wanted
    || (manifest.platform === "win32" && manifest.executionMode === "privileged_host" && (actual === "system" || actual === "nt authority\\system" || actual === "s-1-5-18"))
    || (manifest.platform !== "win32" && manifest.executionMode === "privileged_host" && (actual === "root" || actual === "0" || actual === "uid=0"))
    || (manifest.platform !== "win32" && manifest.executionMode === "dedicated_user" && actual === (manifest.serviceUser ?? "runmesh").toLowerCase())
    || (manifest.platform === "win32" && manifest.executionMode === "dedicated_user" && (actual === "local service" || actual === "nt authority\\local service" || actual === "s-1-5-19"));
  if (!matches) return "mismatch";
  return manifest.executionMode === "privileged_host" ? "privileged" : "restricted";
}

function privilegedIdentity(platform: ServicePlatform): string { return platform === "win32" ? "SYSTEM" : "root"; }
function isAbsoluteForPlatform(value: string, platform: ServicePlatform): boolean { return platform === "win32" ? win32.isAbsolute(value) : value.startsWith("/"); }
function isWindowsAbsolute(value: string): boolean { return win32.isAbsolute(value); }
/** Service managers may choose an arbitrary cwd; never emit relative state paths. */
function absoluteServicePath(value: string, platform: ServicePlatform): string {
  const path = platform === "win32" ? win32 : posix;
  return path.normalize(path.isAbsolute(value) ? value : path.resolve(value));
}
function safeServiceIdentity(value: string): boolean { return /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(value); }
function safeServiceReportedIdentity(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/u.test(trimmed) ? trimmed : undefined;
}
/**
 * Native service commands use non-zero exit codes for ordinary states such as
 * disabled, inactive, or not-found.  Classify those known states explicitly,
 * while marking silent/unknown query failures unreliable so a caller cannot
 * mistake an unavailable service probe for an absent one.
 */
type NativeProbeKind = "enabled" | "active" | "query";
type SystemdEnablementState = "enabled" | "enabled-runtime" | "disabled" | "static" | "indirect" | "generated" | "transient" | "masked" | "masked-runtime" | "alias" | "linked" | "linked-runtime" | "bad" | "not-found";
const SYSTEMD_ENABLEMENT_STATES: ReadonlySet<SystemdEnablementState> = new Set([
  "enabled", "enabled-runtime", "disabled", "static", "indirect", "generated", "transient", "masked", "masked-runtime", "alias", "linked", "linked-runtime", "bad", "not-found",
]);
function systemdEnablementState(result: ServiceCommandResult): SystemdEnablementState | undefined {
  // `systemctl is-enabled` writes one bounded state token to stdout.  Ignore
  // arbitrary stderr text here: a warning/error mixed with a stale token must
  // not authorize a destructive disable operation.
  const token = (result.stdout ?? "").trim().split(/\s+/u)[0]?.toLowerCase();
  return token !== undefined && SYSTEMD_ENABLEMENT_STATES.has(token as SystemdEnablementState)
    ? token as SystemdEnablementState
    : undefined;
}
function nativeProbeReliable(result: ServiceCommandResult, kind: NativeProbeKind, knownInactiveUnit = false): boolean {
  if (result.exitCode === 0) return true;
  if (result.exitCode === 126 || result.exitCode === 127 || result.exitCode === 255) return false;
  const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
  if (detail === "") return kind === "active" && (result.exitCode === 3 || (result.exitCode === 4 && knownInactiveUnit));
  if (/(access is denied|permission denied|not authorized|authentication is required|operation not permitted|failed to connect|could not connect|connection to (?:the )?bus|command not found|not recognized as an internal|cannot open|unknown option|invalid option)/iu.test(detail)) return false;
  // These are the normal absent-service messages emitted by systemctl,
  // launchctl, and schtasks.  `systemctl is-enabled` commonly prints the
  // hyphenated `not-found` state, so accept both spellings. Localized variants
  // without these words remain conservative (unreliable) rather than being
  // treated as a clean absence.
  if (/(not[- ]found|not loaded|does not exist|no such (?:unit|service|task|process|file)|could not find|could not be found|cannot find|cannot be found|system cannot find)/iu.test(detail)) return true;
  // `systemctl is-enabled` returns exit 1 for a known, non-enabled unit and
  // emits one of these state names. They are reliable observations (and must
  // not block a first install or re-enable), unlike a failed D-Bus/tool query.
  if (kind === "enabled" && /^(?:disabled|static|indirect|generated|transient|masked|masked-runtime|alias|enabled-runtime|linked|linked-runtime|bad)\s*$/iu.test(detail)) return true;
  // `systemctl is-active --quiet` uses exit 3 for a known inactive unit and
  // intentionally emits no text. Other no-output failures remain unknown.
  if (kind === "active" && result.exitCode === 3 && detail === "") return true;
  return false;
}
/**
 * Interpret `systemctl is-enabled` as a registration probe.  Enablement is
 * not the same thing as presence: `disabled`, `masked`, `static`, `bad`, and
 * linked states all describe a unit that occupies the native service name.
 * Only the explicit `not-found` state is an absence.  Unknown/error output is
 * kept separate so callers can fail closed instead of overwriting it.
 */
function systemdRegistrationState(result: ServiceCommandResult): boolean | undefined {
  const output = (result.stdout ?? "").trim().toLowerCase();
  const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
  // A diagnostic that mixes an ordinary state token with a transport or
  // permission failure is still an unknown probe.  Never let stale stdout
  // such as `not-found` turn a failed D-Bus query into permission to take over
  // a native registration.
  if (/(access is denied|permission denied|not authorized|authentication is required|operation not permitted|failed to connect|could not connect|connection to (?:the )?bus|command not found|not recognized as an internal|cannot open|unknown option|invalid option)/iu.test(detail)) return undefined;
  const state = systemdEnablementState(result);
  if (state === "not-found" || /(?:^|\s)not[- ]found(?:\s|$)/iu.test(output) || /(?:^|\s)not[- ]found(?:\s|$)/iu.test(detail)) return false;
  if (result.exitCode === 0) return true;
  if (state !== undefined) return true;
  if (/(?:^|\s)(?:disabled|static|indirect|generated|transient|masked|masked-runtime|alias|enabled-runtime|linked|linked-runtime|bad)(?:\s|$)/iu.test(output)) return true;
  // A few systemd versions put the ordinary state in stderr. Keep the same
  // bounded token check there, but never classify permission/tool diagnostics
  // as a registration.
  if (/(?:^|\s)(?:disabled|static|indirect|generated|transient|masked|masked-runtime|alias|enabled-runtime|linked|linked-runtime|bad)(?:\s|$)/iu.test(detail)) return true;
  if (nativeProbeReliable(result, "enabled")) return false;
  return undefined;
}
/** Whether a non-zero systemd probe gives an explicit ordinary state. */
function knownNonActiveUnit(result: ServiceCommandResult): boolean {
  if (result.exitCode === 0) return false;
  const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
  if (detail === "") return false;
  if (/(access is denied|permission denied|not authorized|authentication is required|operation not permitted|failed to connect|could not connect|connection to (?:the )?bus|command not found|not recognized as an internal|cannot open|unknown option|invalid option)/iu.test(detail)) return false;
  return /(not[- ]found|not loaded|does not exist|no such (?:unit|service|task|process|file)|could not find|could not be found|cannot find|cannot be found|system cannot find|^(?:disabled|static|indirect|generated|transient|masked|masked-runtime|alias|enabled-runtime|linked|linked-runtime|bad)\s*$)/iu.test(detail);
}
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
