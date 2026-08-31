import { lstatSync, realpathSync } from "node:fs";
import { win32 } from "node:path";

const WINDOWS_ROOT_PATTERN = /^([A-Za-z]):[\\/](Windows|WinNT)[\\/]?$/iu;

/**
 * Resolve the inbox taskkill executable without consulting PATH. The scripts
 * run as release/CI gates, so a bare `taskkill.exe` could otherwise be
 * replaced by a checkout-local executable or another PATH entry.
 *
 * A caller can pass a synthetic environment for deterministic tests. The
 * process environment (the production path) is additionally checked against
 * the real System32 directory and the executable's file identity.
 */
export function resolveTrustedTaskkillPath(environment = process.env) {
  const candidates = [environment.SystemRoot, environment.WINDIR];
  for (const candidate of candidates) {
    const match = typeof candidate === "string" ? WINDOWS_ROOT_PATTERN.exec(candidate) : null;
    if (match?.[1] === undefined || match[2] === undefined) continue;
    const root = `${match[1]}:\\${match[2]}`;
    if (environment !== process.env || isVerifiedSystemRoot(root, environment)) {
      return win32.join(root, "System32", "taskkill.exe");
    }
  }
  if (environment !== process.env) throw new Error("invalid synthetic Windows system root");
  const fallback = "C:\\Windows";
  if (isVerifiedSystemRoot(fallback, environment)) return `${fallback}\\System32\\taskkill.exe`;
  throw new Error("unable to verify the Windows taskkill executable");
}

function isVerifiedSystemRoot(root, environment) {
  try {
    const drive = /^([A-Za-z]):\\/u.exec(root)?.[1]?.toUpperCase();
    const systemDrive = typeof environment.SystemDrive === "string"
      ? /^([A-Za-z]):/u.exec(environment.SystemDrive)?.[1]?.toUpperCase()
      : undefined;
    if (drive === undefined || (systemDrive !== undefined && drive !== systemDrive)) return false;
    const canonicalRoot = realpathSync.native(root).replace(/[\\/]+$/u, "").toLowerCase();
    if (canonicalRoot !== root.replace(/[\\/]+$/u, "").toLowerCase()) return false;
    const system32 = `${root}\\System32`;
    const directory = lstatSync(system32);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return false;
    const taskkill = lstatSync(`${system32}\\taskkill.exe`);
    if (!taskkill.isFile() || taskkill.isSymbolicLink()) return false;
    return true;
  } catch {
    return false;
  }
}
