import { lstatSync, realpathSync } from "node:fs";
import { win32 } from "node:path";

/** The small set of Windows inbox tools used by service lifecycle code. */
const WINDOWS_SERVICE_TOOLS = new Map<string, string>([
  ["schtasks", "schtasks.exe"],
  ["schtasks.exe", "schtasks.exe"],
  ["powershell", "WindowsPowerShell\\v1.0\\powershell.exe"],
  ["powershell.exe", "WindowsPowerShell\\v1.0\\powershell.exe"],
  ["icacls", "icacls.exe"],
  ["icacls.exe", "icacls.exe"],
  ["net", "net.exe"],
  ["net.exe", "net.exe"],
  ["taskkill", "taskkill.exe"],
  ["taskkill.exe", "taskkill.exe"],
]);

const WINDOWS_ROOT_PATTERN = /^([A-Za-z]):[\\/](Windows|WinNT)[\\/]?$/iu;
const WINDOWS_ABSOLUTE_PATTERN = /^[A-Za-z]:[\\/]|^\\\\/u;

/**
 * Resolve a conventional Windows system root. Synthetic environments used by
 * unit tests may use a deterministic path; the real process environment is
 * additionally checked against the actual System32 directory and inbox tools.
 */
export function trustedWindowsRoot(environment: NodeJS.ProcessEnv = process.env): string {
  for (const candidate of [environment.SystemRoot, environment.WINDIR]) {
    const match = typeof candidate === "string" ? WINDOWS_ROOT_PATTERN.exec(candidate) : null;
    if (match?.[1] !== undefined && match[2] !== undefined) {
      const root = `${match[1]}:\\${match[2]}`;
      if (environment !== process.env || isVerifiedSystemRoot(root, environment)) return root;
    }
  }
  if (environment !== process.env) return "C:\\Windows";
  const fallback = "C:\\Windows";
  if (isVerifiedSystemRoot(fallback, environment)) return fallback;
  throw new Error("unable to verify the Windows system root");
}

function isVerifiedSystemRoot(root: string, environment: NodeJS.ProcessEnv): boolean {
  try {
    const drive = /^([A-Za-z]):\\/u.exec(root)?.[1]?.toUpperCase();
    const systemDrive = typeof environment.SystemDrive === "string"
      ? /^([A-Za-z]):/u.exec(environment.SystemDrive)?.[1]?.toUpperCase()
      : undefined;
    if (drive === undefined || (systemDrive !== undefined && drive !== systemDrive)) return false;
    const canonical = realpathSync.native(root).replace(/[\\/]+$/u, "").toLowerCase();
    if (canonical !== root.replace(/[\\/]+$/u, "").toLowerCase()) return false;
    const system32 = `${root}\\System32`;
    const directory = lstatSync(system32);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return false;
    for (const name of ["cmd.exe", "net.exe", "taskkill.exe"]) {
      const file = lstatSync(`${system32}\\${name}`);
      if (!file.isFile() || file.isSymbolicLink()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function trustedWindowsEnvironment(systemRoot: string): NodeJS.ProcessEnv {
  return {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    Path: `${systemRoot}\\System32;${systemRoot}\\System32\\Wbem;${systemRoot}\\System32\\WindowsPowerShell\\v1.0`,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    ComSpec: `${systemRoot}\\System32\\cmd.exe`,
  };
}

export function resolveTrustedWindowsTool(file: string, systemRoot = trustedWindowsRoot()): string {
  const absolute = WINDOWS_ABSOLUTE_PATTERN.test(file);
  const bare = !absolute && !/[\\/]/u.test(file);
  const basename = absolute ? win32.basename(file).toLowerCase() : file.toLowerCase();
  const canonical = WINDOWS_SERVICE_TOOLS.get(basename);
  if (canonical === undefined || (!absolute && !bare)) throw new Error(`unsupported Windows service command: ${file}`);
  const expected = `${systemRoot}\\System32\\${canonical}`;
  if (!absolute) return expected;
  const normalizedInput = win32.normalize(file).replace(/[\\/]+$/u, "").toLowerCase();
  const normalizedExpected = win32.normalize(expected).replace(/[\\/]+$/u, "").toLowerCase();
  const normalizedExpectedWithoutExtension = normalizedExpected.endsWith(".exe") ? normalizedExpected.slice(0, -4) : normalizedExpected;
  if (normalizedInput !== normalizedExpected && normalizedInput !== normalizedExpectedWithoutExtension) throw new Error(`unsupported Windows service command path: ${file}`);
  return expected;
}
