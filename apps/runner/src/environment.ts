import { spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import type { HostPlatform } from "./platform-types.js";
import { trustedWindowsEnvironment, trustedWindowsRoot, resolveTrustedWindowsTool } from "./windows-tools.js";
import type { EnvironmentReader, EnvironmentWorkspace, ShellRuntime } from "./environment-contracts.js";

export interface ShellRuntimeOptions {
  readonly platform?: HostPlatform;
  readonly probe?: (command: string, args: readonly string[]) => Promise<string | undefined>;
}

// PowerShell cold-starts are materially slower than the other local probes on
// Windows (especially on CI or a freshly provisioned host). Keep generic tool
// discovery fast, but give shell discovery enough time to avoid reporting a
// false `shell_unavailable` result while the executable is still starting.
const GENERAL_PROBE_TIMEOUT_MS = 1_000;
const SHELL_PROBE_TIMEOUT_MS = 5_000;

export async function discoverShellRuntime(options: ShellRuntimeOptions = {}): Promise<ShellRuntime | undefined> {
  const platform = options.platform ?? process.platform;
  const probe = options.probe ?? ((command, args) => probeVersion(command, args, SHELL_PROBE_TIMEOUT_MS));
  const candidates = platform === "win32"
    // The injectable probe is retained for deterministic tests and trusted
    // embedders.  Production discovery uses the absolute inbox PowerShell
    // path; a bare `powershell.exe` would search a caller-controlled cwd/PATH
    // before the system directory during Runner startup.
    ? (options.probe === undefined
      ? [[resolveTrustedWindowsTool("powershell", trustedWindowsRoot()), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"]] as const]
      : [["pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"]] as const, ["powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"]] as const])
    : [["/bin/bash", ["--version"]] as const, ["/usr/bin/bash", ["--version"]] as const];
  for (const [executable, args] of candidates) {
    const version = await probe(executable, args);
    if (version === undefined) continue;
    if (platform === "win32") return { kind: "powershell", executable, ...(version === undefined ? {} : { version: version.trim().slice(0, 512) }), buildInvocation: (command) => ({ file: executable, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] }) };
    return { kind: "bash", executable, ...(version === undefined ? {} : { version: version.trim().split("\n", 1)[0]?.slice(0, 512) }), buildInvocation: (command) => ({ file: executable, args: ["-lc", command] }) };
  }
  return undefined;
}

export interface EnvironmentToolInfo { readonly available: boolean; readonly version?: string; }
export interface EnvironmentInfoOptions { readonly probe?: (command: string, args: readonly string[]) => Promise<string | undefined>; }

/** Cached, bounded local executable discovery. */
export class EnvironmentInfoService implements EnvironmentReader {
  // Executable discovery is expensive and stable for the process lifetime,
  // but workspace metadata follows the active policy and may change after a
  // central policy update. Cache only the host/tool probe so env.info never
  // reports a stale workspace list.
  private cachedTools: Promise<{ readonly platform: string; readonly architecture: string; readonly hostname: string; readonly tools: Record<string, EnvironmentToolInfo> }> | undefined;
  public constructor(private readonly options: EnvironmentInfoOptions = {}) {}
  public get(workspaces: readonly EnvironmentWorkspace[]): Promise<Record<string, unknown>> {
    this.cachedTools ??= this.discoverTools();
    return this.cachedTools.then((info) => ({ ...info, workspaces: workspaces.map((workspace) => ({ workspace_id: workspace.workspaceId, readonly: workspace.readonly, shell: workspace.shell })) }));
  }
  private async discoverTools(): Promise<{ readonly platform: string; readonly architecture: string; readonly hostname: string; readonly tools: Record<string, EnvironmentToolInfo> }> {
    const probe = this.options.probe ?? probeVersion;
    const entries = await Promise.all([
      discoveredTool(probe, "npm", ["--version"]),
      discoveredTool(probe, "pnpm", ["--version"]),
      firstDiscoveredTool(probe, [["python3", ["--version"]], ["python", ["--version"]]]),
      discoveredTool(probe, "git", ["--version"]),
      discoveredTool(probe, "go", ["version"]),
      discoveredTool(probe, "rustc", ["--version"]),
      discoveredTool(probe, "cargo", ["--version"]),
      discoveredTool(probe, "docker", ["--version"]),
    ] as const);
    const [npm, pnpm, python, git, go, rustc, cargo, docker] = entries;
    const tools: Record<string, EnvironmentToolInfo> = {
      node: { available: true, version: process.version }, npm, pnpm, python, git, go, rustc, cargo, docker,
    };
    return { platform: process.platform, architecture: process.arch, hostname: hostname(), tools };
  }
}
async function discoveredTool(probe: (command: string, args: readonly string[]) => Promise<string | undefined>, command: string, args: readonly string[]): Promise<EnvironmentToolInfo> { const version = await probe(command, args); return version === undefined ? { available: false } : { available: true, version }; }
async function firstDiscoveredTool(probe: (command: string, args: readonly string[]) => Promise<string | undefined>, candidates: readonly (readonly [string, readonly string[]])[]): Promise<EnvironmentToolInfo> { for (const [command, args] of candidates) { const result = await discoveredTool(probe, command, args); if (result.available) return result; } return { available: false }; }
function probeVersion(command: string, args: readonly string[], timeoutMs = GENERAL_PROBE_TIMEOUT_MS): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    // Environment discovery is a diagnostic operation, but it still starts
    // processes.  Never inherit Runner credentials, NODE_OPTIONS, or a
    // workspace-controlled PATH/cwd into these probes.  The fixed PATH keeps
    // bare tool names useful for standard installations while preventing a
    // same-name executable in the workspace from running during startup or
    // `env.info`.
    const child = spawn(command, [...args], {
      cwd: trustedProbeCwd(),
      env: trustedProbeEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const finish = (value: string | undefined): void => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already exited */ } finish(undefined); }, timeoutMs);
    const collect = (chunk: Buffer): void => { output = `${output}${chunk.toString()}`.slice(0, 1_024); };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("error", () => finish(undefined));
    child.once("close", (code) => finish(code === 0 ? output.trim().slice(0, 512) || undefined : undefined));
  });
}

function trustedProbeCwd(): string {
  return process.platform === "win32" ? `${trustedWindowsRoot()}\\System32` : "/";
}

function trustedProbeEnvironment(): NodeJS.ProcessEnv {
  if (process.platform === "win32") {
    const root = trustedWindowsRoot();
    const base = trustedWindowsEnvironment(root);
    // Keep only inbox and conventional machine-wide Git/Node locations.  In
    // particular, never put dirname(process.execPath) here: portable Node
    // distributions are commonly unpacked below a user/workspace-writable
    // directory, where a sibling npm/git executable would run with Runner
    // privileges during an otherwise read-only diagnostic probe.
    const path = trustedProbePathEntries(root).join(";");
    return { ...base, Path: path, PATH: path, TEMP: `${root}\\Temp`, TMP: `${root}\\Temp`, NPM_CONFIG_IGNORE_SCRIPTS: "true", NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false", NPM_CONFIG_USERCONFIG: "NUL", NPM_CONFIG_GLOBALCONFIG: "NUL" };
  }
  // Standard system prefixes are root/admin managed on supported Unix hosts;
  // an nvm/portable Node directory is intentionally excluded from this
  // privileged probe PATH.  npm/git remain discoverable from the conventional
  // machine-wide prefixes below.
  const path = trustedProbePathEntries().join(":");
  return { PATH: path, Path: path, LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0", GIT_EXTERNAL_DIFF: "", NPM_CONFIG_IGNORE_SCRIPTS: "true", NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false", NPM_CONFIG_USERCONFIG: "/dev/null", NPM_CONFIG_GLOBALCONFIG: "/dev/null" };
}

/**
 * Return the fixed machine-wide executable prefixes used by diagnostic
 * subprocesses.  The list is deliberately independent of the caller's PATH,
 * current directory, and Node executable location.  Missing optional
 * directories are harmless in PATH, so they are retained to support normal
 * installations on hosts where a prefix is created after Runner startup.
 */
function trustedProbePathEntries(systemRoot?: string): string[] {
  const candidates = process.platform === "win32"
    ? (() => {
      const root = systemRoot ?? trustedWindowsRoot();
      const drive = root.slice(0, 2);
      return [
        `${root}\\System32`,
        `${root}\\System32\\Wbem`,
        `${root}\\System32\\WindowsPowerShell\\v1.0`,
        `${drive}\\Program Files\\nodejs`,
        `${drive}\\Program Files\\Git\\cmd`,
        `${drive}\\Program Files\\Git\\bin`,
        `${drive}\\Program Files (x86)\\Git\\cmd`,
        `${drive}\\Program Files (x86)\\Git\\bin`,
      ];
    })()
    : process.platform === "darwin"
      ? ["/usr/local/bin", "/opt/homebrew/bin", "/opt/local/bin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin"]
      : ["/usr/local/bin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin"];
  const result: string[] = [];
  for (const candidate of candidates) {
    const normalized = process.platform === "win32" ? candidate.replace(/[\\/]+$/u, "") : candidate.replace(/\/+$/u, "") || "/";
    if (result.some((entry) => entry.toLowerCase() === normalized.toLowerCase())) continue;
    // A static prefix can be absent on a minimal image; keep it in PATH. If it
    // exists, reject a symlink/reparse or group/other-writable directory so a
    // writable replacement cannot become trusted after this check.
    if (!trustedProbeDirectory(normalized)) continue;
    result.push(normalized);
  }
  return result;
}

function trustedProbeDirectory(path: string): boolean {
  try {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    if (process.platform !== "win32" && (info.mode & 0o022) !== 0) return false;
    // Resolve once and compare the opened directory's canonical spelling. A
    // junction/reparse point is rejected by lstat above; realpath also avoids
    // accidentally allowing a path whose parent is a symlink to a workspace.
    const canonical = realpathSync.native(path);
    const canonicalInfo = lstatSync(canonical);
    if (!canonicalInfo.isDirectory() || canonicalInfo.isSymbolicLink()) return false;
    if (process.platform !== "win32" && (canonicalInfo.mode & 0o022) !== 0) return false;
    return true;
  } catch (error) {
    // Optional standard prefixes may not exist yet. Including a missing path
    // is safe and lets a later machine-wide installation be discovered. Any
    // other lookup failure (permission, malformed/reparse path, etc.) must be
    // treated as untrusted rather than silently admitted to the allow-list.
    return typeof error === "object" && error !== null && "code" in error && (error as { readonly code?: unknown }).code === "ENOENT";
  }
}

