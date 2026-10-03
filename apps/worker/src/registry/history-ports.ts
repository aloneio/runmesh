import type { JobMetadata } from "@aloneio/runmesh-protocol";
import type { JobHistorySettings } from "@aloneio/runmesh-protocol";

/** Optional history sinks; these operations never own Registry authority. */
export interface PackedHistoryPort {
  merge(runnerId: string, lifecycleId: string, jobs: readonly JobMetadata[], settings: JobHistorySettings): Promise<{
    recorded: boolean;
    updated_at_ms: number | null;
    deferred?: boolean;
  }>;
  list(runnerId: string, lifecycleId: string, settings: JobHistorySettings, filters: {
    workspace_id?: string;
    status?: string;
    limit?: number;
  }): Promise<{
    jobs: JobMetadata[];
    updated_at_ms: number | null;
    retained_limit: number;
  }>;
  get(runnerId: string, lifecycleId: string, jobId: string, settings: JobHistorySettings): Promise<JobMetadata | undefined>;
  setRetention(runnerId: string, lifecycleId: string, days: number): Promise<void>;
}
export interface AuditHistoryPort {
  list(runnerId: string, lifecycleId: string, limit?: number): Promise<Record<string, unknown>[]>;
  append(metadata: Record<string, unknown>): Promise<boolean>;
}
