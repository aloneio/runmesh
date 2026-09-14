export interface RunnerJobHistory {
  readonly mode: "off" | "batched" | "immediate";
  readonly interval_seconds: number;
  readonly retention_days: number;
  readonly local_retention_days: number;
}
/** Optional welcome extension, not a policy or an authorization cache. */
export function parseRunnerJobHistory(value: unknown): RunnerJobHistory | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const v = value as Record<string,unknown>;
  if (Object.keys(v).some((k) => !["mode","interval_seconds","retention_days","local_retention_days"].includes(k))) return undefined;
  if (v.mode !== "off" && v.mode !== "batched" && v.mode !== "immediate") return undefined;
  if (![60,300,900,3600].includes(Number(v.interval_seconds)) || typeof v.interval_seconds !== "number"
    || ![1,3,7,14,30,90].includes(Number(v.retention_days)) || typeof v.retention_days !== "number"
    || ![0,1,3,7,14,30,90].includes(Number(v.local_retention_days)) || typeof v.local_retention_days !== "number") return undefined;
  return {mode:v.mode,interval_seconds:v.interval_seconds,retention_days:v.retention_days,local_retention_days:v.local_retention_days};
}
