import type { JobHistorySettings } from "@aloneio/runmesh-protocol";

export const DEFAULT_JOB_HISTORY: JobHistorySettings = { mode: "batched", interval_seconds: 300, retention_days: 7, local_retention_days: 0 };
export const HISTORY_LIMITS = [10, 20, 50, 100] as const;
