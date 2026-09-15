

export interface ApplyPatchOptions {
  /** Test-only seam, invoked after durable temporary files and before baseline recheck. */
  readonly beforeCommit?: () => void | Promise<void>;
  /** Test-only seam, invoked before each filesystem install. */
  readonly beforeInstall?: (path: string, action: "write" | "delete") => void | Promise<void>;
  /** Test-only seam invoked after baseline/parent checks and immediately before install. */
  readonly beforeInstallCommit?: (path: string, action: "write" | "delete") => void | Promise<void>;
  /** Test-only seam for exercising retained-backup recovery reporting. */
  readonly beforeBackupCleanup?: (backupPath: string) => void | Promise<void>;
}
