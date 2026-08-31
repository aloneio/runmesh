import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep, win32 } from "node:path";
import type { WorkspaceConfig } from "./config.js";

export type PathOperation = "read" | "list" | "search" | "write" | "cwd";
export type PolicyPermission = "read" | "edit";

export class PathPolicyError extends Error {
  public constructor(public readonly code: string, message: string) { super(message); this.name = "PathPolicyError"; }
}

/**
 * Point-in-time identity for a path that passed the workspace boundary.
 * Consumers must compare it after opening a handle: a canonical path string
 * alone is not atomic while another local process can replace an ancestor.
 */
export interface PathSnapshot {
  readonly canonicalPath: string;
  /** Identity of the configured workspace root at snapshot time. Optional so
   * callers compiled against the pre-snapshot shape remain source-compatible;
   * snapshots returned by this module always populate these fields. */
  readonly rootCanonicalPath?: string;
  readonly rootDevice?: number;
  readonly rootInode?: number;
  readonly device: number;
  readonly inode: number;
  readonly type: "file" | "directory" | "other";
  readonly size: number;
  readonly modifiedAtMs: number;
}

/** Resolves all user paths from an allowlisted workspace id, never from a caller root. */
export class PathPolicy {
  private workspaces: ReadonlyMap<string, WorkspaceConfig>;
  public constructor(workspaces: readonly WorkspaceConfig[]) {
    this.workspaces = new Map(workspaces.map((workspace) => [workspace.workspaceId, workspace]));
  }
  public list(): readonly WorkspaceConfig[] { return [...this.workspaces.values()]; }
  public replace(workspaces: readonly WorkspaceConfig[]): void {
    // Keep denied managed workspaces in the local map so every operation fails
    // explicitly with permission_denied rather than falling back to an
    // indistinguishable unknown workspace. Public listing code filters them.
    this.workspaces = new Map(workspaces.map((workspace) => [workspace.workspaceId, workspace]));
  }
  public assertPermission(workspaceId: unknown, permission: PolicyPermission): WorkspaceConfig {
    const workspace = this.getWorkspace(workspaceId);
    if (workspace.permissions !== undefined && !workspace.permissions[permission]) throw new PathPolicyError(permission === "edit" ? "readonly_workspace" : "permission_denied", `workspace does not permit ${permission}`);
    return workspace;
  }
  public getWorkspace(workspaceId: unknown): WorkspaceConfig {
    if (typeof workspaceId !== "string") throw new PathPolicyError("invalid_workspace", "workspace_id is required");
    const workspace = this.workspaces.get(workspaceId);
    if (workspace === undefined) throw new PathPolicyError("invalid_workspace", "unknown workspace_id");
    return workspace;
  }
  public assertWritable(workspaceId: unknown): WorkspaceConfig {
    const workspace = this.assertPermission(workspaceId, "edit");
    if (workspace.readonly) throw new PathPolicyError("readonly_workspace", "workspace is readonly");
    return workspace;
  }
  public async resolve(workspaceId: unknown, userPath: unknown, operation: PathOperation): Promise<{ workspace: WorkspaceConfig; path: string }> {
    const workspace = this.assertPermission(workspaceId, operation === "write" ? "edit" : "read");
    if (typeof userPath !== "string" || userPath.length === 0) throw new PathPolicyError("invalid_path", "path is required");
    if (userPath.includes("\0")) throw new PathPolicyError("invalid_path", "path contains NUL");
    if (isAbsolute(userPath) || win32.isAbsolute(userPath)) throw new PathPolicyError("invalid_path", "absolute paths are not allowed");
    const pieces = userPath.split(/[\\/]+/);
    if (pieces.some((piece) => piece === "..")) throw new PathPolicyError("invalid_path", "path traversal is not allowed");
    if (process.platform === "win32" && pieces.some(windowsUnsafeComponent)) throw new PathPolicyError("invalid_path", "device and alternate-stream paths are not allowed");
    const candidate = normalize(join(workspace.rootPath, userPath));
    const rel = relative(workspace.rootPath, candidate);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new PathPolicyError("invalid_path", "path escapes workspace");
    if (operation === "write") this.assertWritable(workspaceId);
    await this.checkAncestors(workspace.rootPath, rel, operation === "write");
    return { workspace, path: candidate };
  }

  /**
   * Capture a validated path identity immediately before a filesystem
   * operation. This leaves the public resolved-path shape unchanged while
   * allowing consumers to perform a post-open identity check.
   */
  public async snapshot(resolved: { readonly workspace: WorkspaceConfig; readonly path: string }): Promise<PathSnapshot> {
    const { workspace, path } = resolved;
    const rel = relative(workspace.rootPath, path);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new PathPolicyError("invalid_path", "path escapes workspace");
    // Bind the configured root as well as the leaf. If the root itself is
    // replaced by a junction/reparse point (or by another ordinary directory)
    // while this snapshot is being assembled, canonicalizing both sides at
    // that instant could otherwise make an outside target appear to be the new
    // workspace. A second identity/canonical check below detects that swap.
    const rootBefore = await checkedRoot(workspace.rootPath);
    await this.checkAncestors(workspace.rootPath, rel, false);
    const canonicalRoot = await realpath(workspace.rootPath);
    const canonicalPath = await realpath(path);
    assertInside(canonicalRoot, canonicalPath);
    const linkInfo = await lstat(path);
    if (linkInfo.isSymbolicLink()) throw new PathPolicyError("symlink_escape", "symlink paths are not allowed");
    const info = await stat(path);
    if (!sameIdentity(linkInfo, info)) throw new PathPolicyError("path_changed", "path changed during validation");
    const rootAfter = await checkedRoot(workspace.rootPath);
    const canonicalRootAfter = await realpath(workspace.rootPath);
    if (!sameIdentity(rootBefore, rootAfter) || !sameCanonical(canonicalRoot, canonicalRootAfter)) {
      throw new PathPolicyError("path_changed", "workspace root changed during validation");
    }
    return {
      canonicalPath,
      rootCanonicalPath: canonicalRoot,
      rootDevice: rootBefore.dev,
      rootInode: rootBefore.ino,
      device: info.dev,
      inode: info.ino,
      type: info.isFile() ? "file" : info.isDirectory() ? "directory" : "other",
      size: info.size,
      modifiedAtMs: info.mtimeMs,
    };
  }

  /** Re-check the path boundary and identity after a handle has been opened. */
  public async verifySnapshot(resolved: { readonly workspace: WorkspaceConfig; readonly path: string }, snapshot: PathSnapshot): Promise<void> {
    const current = await this.snapshot(resolved);
    if (!sameCanonical(current.canonicalPath, snapshot.canonicalPath)
      || (snapshot.rootCanonicalPath !== undefined && !sameCanonical(current.rootCanonicalPath ?? "", snapshot.rootCanonicalPath))
      || (snapshot.rootDevice !== undefined && current.rootDevice !== snapshot.rootDevice)
      || (snapshot.rootInode !== undefined && current.rootInode !== snapshot.rootInode)
      || current.device !== snapshot.device || current.inode !== snapshot.inode) {
      throw new PathPolicyError("path_changed", "path changed during filesystem operation");
    }
  }
  private async checkAncestors(root: string, rel: string, writing: boolean): Promise<void> {
    // The configured root is canonicalized at enrollment/policy admission, but
    // a local process can replace that directory with a symlink before a later
    // request. Never re-canonicalize a substituted root and then treat its
    // target as the new workspace boundary.
    let rootInfo;
    try { rootInfo = await lstat(root); } catch (error) { throw error; }
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new PathPolicyError("symlink_escape", "workspace root is no longer a regular directory");
    const parts = rel === "" ? [] : rel.split(sep);
    let current = root;
    for (const part of parts) {
      current = join(current, part);
      let stat;
      try { stat = await lstat(current); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
      if (stat.isSymbolicLink()) throw new PathPolicyError(writing ? "symlink_write" : "symlink_escape", "symlink paths are not allowed");
      if (stat.isDirectory()) continue;
      if (current !== join(root, ...parts)) throw new PathPolicyError("invalid_path", "path traverses a file");
    }
    try {
      const canonical = await realpath(join(root, rel));
      const rootCanonical = await realpath(root);
      const inside = relative(rootCanonical, canonical);
      if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new PathPolicyError("symlink_escape", "path escapes workspace");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function checkedRoot(root: string): Promise<{ readonly dev: number; readonly ino: number }> {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new PathPolicyError("symlink_escape", "workspace root is no longer a regular directory");
  }
  return info;
}

function sameIdentity(left: { readonly dev: number; readonly ino: number }, right: { readonly dev: number; readonly ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function sameCanonical(left: string, right: string): boolean {
  if (process.platform === "win32") return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
  return left === right;
}
function assertInside(root: string, candidate: string): void {
  const inside = relative(root, candidate);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new PathPolicyError("symlink_escape", "path escapes workspace");
}

function windowsUnsafeComponent(component: string): boolean {
  // Relative NTFS ADS (`name:stream`) and DOS device names are not ordinary
  // workspace files. Node accepts several of these spellings as relative paths
  // on Windows, so reject them before any filesystem call.
  if (component.includes(":")) return true;
  // Win32 silently strips trailing dots/spaces from ordinary components. That
  // aliasing can make an expected-hash or multi-operation path refer to a
  // different spelling than the caller reviewed. `.` itself is the supported
  // current-directory marker and remains valid.
  if (component !== "." && /[ .]$/u.test(component)) return true;
  const trimmed = component.replace(/[ .]+$/u, "");
  const base = (trimmed.split(".", 1)[0] ?? "").toUpperCase();
  return base === "CON" || base === "PRN" || base === "AUX" || base === "NUL" || base === "CLOCK$"
    || /^COM[0-9¹²³]$/u.test(base) || /^LPT[0-9¹²³]$/u.test(base);
}
