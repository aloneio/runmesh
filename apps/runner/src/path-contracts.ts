import type { WorkspaceConfig } from "./config.js";

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

/** Data returned by the path adapter; not an authorization grant. */
export interface ResolvedPolicyPath {
  workspace: WorkspaceConfig;
  path: string;
}
