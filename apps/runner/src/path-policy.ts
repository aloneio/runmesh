import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep, win32 } from "node:path";
import type { WorkspaceConfig } from "./config.js";

export type PathOperation = "read" | "list" | "search" | "write" | "cwd";
export type PolicyPermission = "read" | "edit";

export class PathPolicyError extends Error {
  public constructor(public readonly code: string, message: string) { super(message); this.name = "PathPolicyError"; }
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
    const candidate = normalize(join(workspace.rootPath, userPath));
    const rel = relative(workspace.rootPath, candidate);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new PathPolicyError("invalid_path", "path escapes workspace");
    if (operation === "write") this.assertWritable(workspaceId);
    await this.checkAncestors(workspace.rootPath, rel, operation === "write");
    return { workspace, path: candidate };
  }
  private async checkAncestors(root: string, rel: string, writing: boolean): Promise<void> {
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
