/**
 * Public protocol shapes used by the Runner API.
 *
 * The executable bundles the protocol implementation, and the published
 * Runner package intentionally has no runtime dependencies. Keeping these
 * declaration-only shapes local prevents generated consumer declarations
 * from requiring a separately installed (and currently unpublished) protocol
 * package. They mirror the corresponding types in packages/protocol/src.
 */
export interface CapabilityMetadata {
  filesystem: boolean;
  process_execution: boolean;
  workspace_sync: boolean;
  pty: boolean;
  network_access: boolean;
  max_concurrent_jobs: number;
  supported_rpc_methods: string[];
  labels: Record<string, string>;
}
export type JobStatus = "queued" | "running" | "cancelling" | "cancelled" | "succeeded" | "failed" | "unknown" | "interrupted";
export interface JobMetadata {
  job_id: string;
  workspace_id: string;
  status: JobStatus;
  created_at_ms: number;
  updated_at_ms: number;
  display_name?: string | undefined;
  created_by_client_id?: string | undefined;
  runner_id?: string | undefined;
}
export interface PermissionSet {
  read: boolean;
  edit: boolean;
  shell: boolean;
  job_control: boolean;
}
export interface RunnerPolicyWorkspace {
  workspace_id: string;
  root_path: string;
  enabled: boolean;
  permissions: PermissionSet;
}
export interface RunnerPolicy {
  schema_version: 1;
  runner_id: string;
  revision: number;
  checksum: string;
  runner_permissions: PermissionSet;
  workspaces: RunnerPolicyWorkspace[];
}
