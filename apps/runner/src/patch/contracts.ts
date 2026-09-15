import { PathPolicy } from "../path-policy.js";
import type { PathSnapshot } from "../path-policy.js";

type PatchLineKind = "add" | "delete" | "context";

export type PatchLine = { readonly kind: PatchLineKind; readonly text: string; readonly noNewline: boolean };

export type Hunk = { readonly lines: readonly PatchLine[] };

export type PatchOperation = {
  readonly kind: "add" | "update" | "delete" | "move";
  readonly path: string;
  readonly destination?: string;
  readonly lines: readonly PatchLine[];
  readonly hunks: readonly Hunk[];
};

export type ResolvedOperation = PatchOperation & {
  readonly source?: ResolvedPath;
  readonly target?: ResolvedPath;
};

export type ResolvedPath = {
  readonly path: string;
  readonly relativePath: string;
  readonly workspaceId: string;
};

export type ResolvedPolicyPath = Awaited<ReturnType<PathPolicy["resolve"]>>;

export type ParentBoundary = {
  readonly resolved: ResolvedPolicyPath;
  readonly snapshot: PathSnapshot;
};

export type TargetBoundary = ParentBoundary;

export type Baseline = {
  readonly path: ResolvedPath;
  readonly exists: boolean;
  readonly hash: string | null;
  readonly mode: number | null;
  readonly size: number | null;
  readonly bytes?: Buffer;
  /** Identity of the target's parent directory captured with the baseline. */
  readonly parentBoundary?: ParentBoundary;
  /** Identity of an existing target, preventing a Windows leaf swap from
   * being followed between lstat and open (where O_NOFOLLOW is unavailable). */
  readonly targetBoundary?: TargetBoundary;
};

export type TextFile = {
  readonly bom: boolean;
  readonly newline: "\n" | "\r\n";
  readonly endsWithNewline: boolean;
  readonly lines: readonly string[];
};

export type PlannedChange = {
  readonly path: ResolvedPath;
  readonly baseline: Baseline;
  readonly action: "write" | "delete";
  readonly bytes?: Buffer;
  readonly mode?: number;
};

export type PreparedChange = PlannedChange & { readonly temporaryPath?: string };

export type InstallState = {
  readonly change: PreparedChange;
  readonly backupPath?: string;
  backupMoved: boolean;
  installed: boolean;
  readonly installedHash?: string;
};

export type RecoveryWarning = {
  readonly path: string;
  readonly backup_path?: string;
  readonly temporary_path?: string;
  readonly error: string;
};

export type { ApplyPatchOptions } from "./public-contracts.js";
