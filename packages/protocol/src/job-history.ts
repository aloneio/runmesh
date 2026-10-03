/** Optional runner.welcome extension shared by the control plane and Runner. */
export interface JobHistorySettings {
  readonly mode: "off" | "batched" | "immediate";
  readonly interval_seconds: number;
  readonly retention_days: number;
  readonly local_retention_days: number;
}

export const HISTORY_INTERVALS = [60, 300, 900, 3600] as const;
export const HISTORY_DAYS = [1, 3, 7, 14, 30, 90] as const;

/** Reject unsupported settings before either peer applies retention or upload behavior. */
export function parseJobHistorySettings(value: unknown): JobHistorySettings | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["mode", "interval_seconds", "retention_days", "local_retention_days"].includes(key))) return undefined;
  if (input.mode !== "off" && input.mode !== "batched" && input.mode !== "immediate") return undefined;
  if (!HISTORY_INTERVALS.some((seconds) => seconds === input.interval_seconds)
    || !HISTORY_DAYS.some((days) => days === input.retention_days)
    || (input.local_retention_days !== 0 && !HISTORY_DAYS.some((days) => days === input.local_retention_days))) return undefined;
  return {
    mode: input.mode,
    interval_seconds: input.interval_seconds as number,
    retention_days: input.retention_days as number,
    local_retention_days: input.local_retention_days as number,
  };
}
