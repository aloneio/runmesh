export interface JobHistorySettings {
  readonly mode: "off" | "batched" | "immediate";
  readonly interval_seconds: number;
  readonly retention_days: number;
  readonly local_retention_days: number;
}
export const DEFAULT_JOB_HISTORY: JobHistorySettings = { mode: "batched", interval_seconds: 300, retention_days: 7, local_retention_days: 0 };
export const HISTORY_INTERVALS = [60, 300, 900, 3600] as const;
export const HISTORY_DAYS = [1, 3, 7, 14, 30, 90] as const;
export const HISTORY_LIMITS = [10, 20, 50, 100] as const;

export function parseJobHistorySettings(value: unknown): JobHistorySettings | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => !["mode", "interval_seconds", "retention_days", "local_retention_days"].includes(k))) return undefined;
  if (v.mode !== "off" && v.mode !== "batched" && v.mode !== "immediate") return undefined;
  if (!HISTORY_INTERVALS.some((n) => n === v.interval_seconds) || !HISTORY_DAYS.some((n) => n === v.retention_days)
    || (v.local_retention_days !== 0 && !HISTORY_DAYS.some((n) => n === v.local_retention_days))) return undefined;
  return { mode: v.mode, interval_seconds: v.interval_seconds as number, retention_days: v.retention_days as number, local_retention_days: v.local_retention_days as number };
}

export function ensureJobHistorySettings(sql: SqlStorage): void {
  if (sql.exec("SELECT 1 FROM runmesh_data_migrations WHERE id = 'job-history-settings-v1'").toArray().length) return;
  sql.exec("CREATE TABLE job_history_settings (runner_id TEXT PRIMARY KEY, lifecycle_id TEXT NOT NULL, settings_json TEXT NOT NULL)");
  sql.exec("INSERT INTO runmesh_data_migrations VALUES ('job-history-settings-v1')");
}
