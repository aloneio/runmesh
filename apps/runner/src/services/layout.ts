import { absoluteServicePath } from "./values.js";
import { currentServicePlatform } from "./values.js";
import { homedir } from "node:os";
import { isAbsoluteForPlatform } from "./values.js";
import { isWindowsAbsolute } from "./values.js";
import { LINUX_SERVICE_NAME } from "./values.js";
import { MACOS_LABEL } from "./values.js";
import { posix } from "node:path";
import type { ServiceAdapterOptions } from "./contracts.js";
import type { ServiceLayout } from "./contracts.js";
import { serviceMode } from "./values.js";
import type { ServicePlatform } from "./contracts.js";
import { win32 } from "node:path";

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
      return { installRoot, configRoot, stateRoot, logRoot, manifestPath, executablePath: options.executablePath ?? path.join(installRoot, "current", "bin", "runmesh") };
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
      return { installRoot, configRoot, stateRoot, logRoot, manifestPath, executablePath: options.executablePath ?? path.join(installRoot, "current", "bin", "runmesh") };
    }
    const installRoot = options.installRoot ?? "C:\\Program Files\\Runmesh";
    const configRoot = options.configRoot ?? "C:\\ProgramData\\Runmesh";
    const stateRoot = options.dataRoot ?? path.join(configRoot, "state");
    const logRoot = options.logRoot ?? path.join(configRoot, "logs");
    const manifestPath = path.join(options.manifestDir ?? configRoot, "RunmeshRunner.xml");
    return { installRoot, configRoot, stateRoot, logRoot, manifestPath, executablePath: options.executablePath ?? path.join(installRoot, "current", "runmesh.cmd") };
  }
  if (platform === "linux") {
    const installRoot = options.installRoot ?? path.join(home, ".local", "share", "runmesh");
    const configRoot = options.configRoot ?? path.join(home, ".config", "runmesh");
    const stateRoot = options.dataRoot ?? path.join(home, ".local", "state", "runmesh");
    const logRoot = options.logRoot ?? path.join(stateRoot, "logs");
      return { installRoot, configRoot, stateRoot, logRoot, manifestPath: path.join(options.manifestDir ?? path.join(home, ".config", "systemd", "user"), LINUX_SERVICE_NAME), executablePath: options.executablePath ?? path.join(installRoot, "current", "bin", "runmesh") };
  }
  if (platform === "darwin") {
    const installRoot = options.installRoot ?? path.join(home, ".local", "share", "runmesh");
    const configRoot = options.configRoot ?? path.join(home, "Library", "Application Support", "Runmesh");
    const stateRoot = options.dataRoot ?? path.join(configRoot, "state");
    const logRoot = options.logRoot ?? path.join(configRoot, "logs");
      return { installRoot, configRoot, stateRoot, logRoot, manifestPath: path.join(options.manifestDir ?? path.join(home, "Library", "LaunchAgents"), `${MACOS_LABEL}.plist`), executablePath: options.executablePath ?? path.join(installRoot, "current", "bin", "runmesh") };
  }
  const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
  const installRoot = options.installRoot ?? path.join(local, "Runmesh");
  const configRoot = options.configRoot ?? path.join(local, "Runmesh");
  const stateRoot = options.dataRoot ?? path.join(configRoot, "state");
  const logRoot = options.logRoot ?? path.join(configRoot, "logs");
  return { installRoot, configRoot, stateRoot, logRoot, manifestPath: path.join(options.manifestDir ?? configRoot, "RunmeshRunner.xml"), executablePath: options.executablePath ?? path.join(installRoot, "current", "runmesh.cmd") };
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

export function serviceInvocation(options: ServiceAdapterOptions, layout: ServiceLayout, profile: string, stateDir: string, platform: ServicePlatform): readonly string[] {
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
