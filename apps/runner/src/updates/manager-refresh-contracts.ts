import type { MaintenanceManagerOptions } from "./manager-install.js";

/** Public CLI contracts stay independent of release-verification test ports. */
export interface ManagerRefreshOptions extends MaintenanceManagerOptions {
  readonly releaseDirectory: string;
}

export interface ManagerRefreshResult {
  readonly action: "manager-refresh";
  readonly manager_version: string;
  readonly previous_manager_version: string;
  readonly runner_unchanged: true;
  readonly restarted: boolean;
  /** A completed refresh may retain its private old bundle if cleanup is delayed. */
  readonly backup_retained?: true;
}
