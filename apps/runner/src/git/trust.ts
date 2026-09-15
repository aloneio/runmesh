import { dirname } from "node:path";
import { join } from "node:path";
import { lstatSync } from "node:fs";
import { normalize } from "node:path";
import { realpathSync } from "node:fs";
import { trustedWindowsEnvironment } from "../windows-tools.js";
import { trustedWindowsRoot } from "../windows-tools.js";

export function isolatedGitEnvironment(directory: string, worktree: string): NodeJS.ProcessEnv {
  const pathEntries = trustedGitPathEntries(worktree);
  const path = pathEntries.join(process.platform === "win32" ? ";" : ":");
  // Start from an allow-list rather than inheriting the Runner's environment:
  // credentials, NODE_OPTIONS, custom Git helpers, and user config locations
  // must not reach a read-only inspection subprocess.
  let environment: NodeJS.ProcessEnv;
  if (process.platform === "win32") {
    const root = trustedWindowsRoot();
    environment = { ...trustedWindowsEnvironment(root), TEMP: `${root}\\Temp`, TMP: `${root}\\Temp` };
  } else {
    environment = { LANG: "C", LC_ALL: "C" };
  }
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  environment.GIT_DIR = directory;
  environment.GIT_WORK_TREE = worktree;
  environment.GIT_INDEX_FILE = join(directory, "index");
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = nullDevice;
  environment.GIT_CONFIG_SYSTEM = nullDevice;
  environment.GIT_ATTR_NOSYSTEM = "1";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_PAGER = "cat";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_EXTERNAL_DIFF = "";
  environment.GIT_DIFF_OPTS = "";
  environment.PATH = path;
  environment.Path = path;
  if (process.platform !== "win32") {
    environment.LANG = "C";
    environment.LC_ALL = "C";
  }
  return environment;
}

export function trustedGitCwd(): string {
  return process.platform === "win32" ? `${trustedWindowsRoot()}\\System32` : "/";
}

/**
 * Keep only conventional system/runtime Git locations.  In particular, do
 * not pass the caller's arbitrary PATH through to a read-only inspection;
 * the child starts in a trusted directory as an additional defense against
 * Windows current-directory executable search.  A Git installation in a
 * conventional `git/cmd` or `git/bin` directory is retained so portable
 * developer runtimes continue to work.
 */
export function trustedGitPathEntries(worktree: string): string[] {
  const entries: string[] = [];
  const add = (value: string | undefined, allowMissing = false, windowsRoots: readonly string[] = []): void => {
    if (value === undefined || value.trim() === "") return;
    const normalized = value.replace(/[\\/]+$/u, "");
    if (entries.some((item) => item.toLowerCase() === normalized.toLowerCase())) return;
    if (!trustedGitDirectory(normalized, worktree, allowMissing, windowsRoots)) return;
    if (process.platform !== "win32" && !trustedPosixGitExecutable(normalized)) return;
    entries.push(normalized);
  };
  // Never add dirname(process.execPath) implicitly. Portable Node installs
  // are often unpacked in a user/workspace-writable directory; putting that
  // directory ahead of the system Git locations would let a sibling `git`
  // binary execute with Runner/service privileges. The explicit inbox and
  // conventional Git install directories below form the allow-list instead.
  if (process.platform === "win32") {
    const root = trustedWindowsRoot();
    const drive = root.slice(0, 2);
    const windowsRoots = [root, drive + "\\Program Files", drive + "\\Program Files (x86)"];
    // Do not consult PATH on Windows at all. Even a PATH entry named
    // Git\\cmd may live under a user profile or be a reparse point. The
    // inbox and literal machine-wide Program Files locations are the only
    // accepted roots (missing optional locations remain harmless entries).
    add(root + "\\System32", true, windowsRoots);
    add(root + "\\System32\\Wbem", true, windowsRoots);
    add(root + "\\System32\\WindowsPowerShell\\v1.0", true, windowsRoots);
    add(drive + "\\Program Files\\Git\\cmd", true, windowsRoots);
    add(drive + "\\Program Files\\Git\\bin", true, windowsRoots);
    add(drive + "\\Program Files (x86)\\Git\\cmd", true, windowsRoots);
    add(drive + "\\Program Files (x86)\\Git\\bin", true, windowsRoots);
  } else {
    // Keep standard prefixes even on minimal images where they do not yet
    // exist. A later root-managed installation can then be discovered.
    add("/usr/bin", true); add("/bin", true); add("/usr/local/bin", true);
  }
  if (process.platform === "win32") return entries;
  const source = process.env.PATH ?? process.env.Path ?? "";
  for (const entry of source.split(":")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    if (!trimmed.startsWith("/")) continue;
    const conventionalGit = /(?:^|\/)git(?:\/|$)/u.test(trimmed);
    if (!conventionalGit) continue;
    if (isLexicallyWithin(trimmed, worktree)) continue;
    // PATH-derived locations must exist now and pass the full ownership /
    // symlink check. Unlike fixed standard prefixes, admitting a missing
    // user-controlled directory would make a later mkdir an executable
    // injection point.
    add(trimmed, false);
  }
  return entries;
}

function trustedGitDirectory(path: string, worktree: string, allowMissing: boolean, windowsRoots: readonly string[]): boolean {
  // Normalize before walking so `..` components cannot make a lexical path
  // appear to be below a trusted prefix while lstat() silently resolves it
  // elsewhere.
  const candidate = normalize(path);
  let current = candidate;
  let missingSuffix = false;
  let canonicalExisting: string | undefined;
  try {
    // Inspect every existing component. This rejects a symlink/junction in an
    // ancestor as well as a symlink at the final PATH entry. For optional
    // fixed prefixes, walk upward through a missing suffix and validate the
    // first existing ancestor instead of blindly admitting a path whose
    // parent is writable.
    let nearestExisting: string | undefined;
    for (;;) {
      let info;
      try {
        info = lstatSync(current);
      } catch (error) {
        if (!allowMissing || !isErrnoCode(error, "ENOENT")) return false;
        missingSuffix = true;
        const parent = dirname(current);
        if (parent === current) return false;
        current = parent;
        continue;
      }
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
      // A sticky world-writable parent such as /tmp is safe for an already
      // private child: the sticky bit prevents an unrelated user from
      // replacing or removing that child. The PATH entry itself (and any
      // non-sticky writable ancestor) must still remain private.
      if (process.platform !== "win32" && (!trustedPosixOwner(info.uid) || !trustedPosixDirectoryMode(info.mode, current !== candidate))) return false;
      nearestExisting ??= current;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    if (nearestExisting === undefined) return false;
    canonicalExisting = realpathSync.native(nearestExisting);
    const canonicalInfo = lstatSync(canonicalExisting);
    if (!canonicalInfo.isDirectory() || canonicalInfo.isSymbolicLink()) return false;
    if (process.platform !== "win32" && (!trustedPosixOwner(canonicalInfo.uid) || !trustedPosixDirectoryMode(canonicalInfo.mode, missingSuffix))) return false;
    if (process.platform !== "win32") {
      // Resolve the worktree once as well so a symlinked spelling cannot evade
      // the lexical exclusion above. A missing optional suffix is rejected if
      // either its lexical spelling or its existing ancestor is in the
      // workspace boundary; a later mkdir cannot then turn it into an escape.
      let canonicalWorktree: string;
      try { canonicalWorktree = realpathSync.native(worktree); } catch { canonicalWorktree = worktree; }
      if (isLexicallyWithin(candidate, worktree) || isPathWithin(canonicalExisting, canonicalWorktree)) return false;
      if (missingSuffix) return true;
      const canonical = realpathSync.native(candidate);
      const canonicalInfo = lstatSync(canonical);
      if (!canonicalInfo.isDirectory() || canonicalInfo.isSymbolicLink() || (canonicalInfo.mode & 0o022) !== 0) return false;
      return !isPathWithin(canonical, canonicalWorktree);
    }
    // Windows PATH entries are accepted only below the verified inbox or
    // literal Program Files roots. A missing optional suffix is safe only when
    // its lexical spelling is already confined to one of those fixed roots;
    // this preserves normal installations on hosts where Git is not installed
    // yet without admitting an arbitrary future PATH directory.
    if (!windowsRoots.some((root) => isPathWithin(candidate, root))) return false;
    if (missingSuffix) return true;
    const canonical = realpathSync.native(candidate);
    const finalInfo = lstatSync(canonical);
    if (!finalInfo.isDirectory() || finalInfo.isSymbolicLink()) return false;
    return windowsRoots.some((root) => isPathWithin(canonical, root));
  } catch {
    // EACCES, malformed/reparse paths, and all other lookup failures fail
    // closed. Missing fixed prefixes were handled above only after a safe
    // existing ancestor passed the ownership/symlink checks.
    return false;
  }
}

function trustedPosixOwner(uid: number): boolean {
  return uid === 0 || uid === (process.geteuid?.() ?? process.getuid?.());
}

function trustedPosixGitExecutable(directory: string): boolean {
  try {
    const info = lstatSync(join(directory, "git"));
    return info.isFile() && !info.isSymbolicLink() && trustedPosixOwner(info.uid)
      && (info.mode & 0o022) === 0 && (info.mode & 0o111) !== 0;
  } catch (error) {
    // A currently empty trusted directory is harmless; only its trusted owner
    // can create an executable there. All other lookup failures fail closed.
    return isErrnoCode(error, "ENOENT");
  }
}

function trustedPosixDirectoryMode(mode: number, allowStickyAncestor: boolean): boolean {
  if ((mode & 0o022) === 0) return true;
  // Only the conventional sticky world-writable directories (for example
  // /tmp, mode 01777) may be ancestors. A group-writable directory without
  // other-writable protection is not safe even when it has a sticky bit.
  return allowStickyAncestor && (mode & 0o1002) === 0o1002;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { readonly code?: unknown }).code === code;
}

function isLexicallyWithin(candidate: string, root: string): boolean {
  const child = normalizePathForComparison(candidate);
  const parent = normalizePathForComparison(root);
  return child === parent || child.startsWith(`${parent}/`);
}

export function isPathWithin(candidate: string, root: string): boolean {
  const child = normalizePathForComparison(candidate);
  const parent = normalizePathForComparison(root);
  return child === parent || child.startsWith(`${parent}/`);
}

function normalizePathForComparison(value: string): string {
  const normalized = process.platform === "win32" ? value.replaceAll("\\", "/") : value;
  const root = normalized === "/" || /^[A-Za-z]:\/$/u.test(normalized);
  const withoutTrailingSeparators = root ? normalized : normalized.replace(/\/+$/u, "");
  return process.platform === "win32" ? withoutTrailingSeparators.toLowerCase() : withoutTrailingSeparators;
}
