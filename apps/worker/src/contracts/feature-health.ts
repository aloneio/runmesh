

export type RegistryFeatureKey = "job_recording" | "mcp_audit" | "mcp_usage_tracking" | "auth_throttle" | "maintenance_alarm";

export interface RegistryFeatureHealth {
  readonly feature: RegistryFeatureKey;
  readonly disabled_until_ms: number | null;
  readonly failure_count: number;
  readonly last_failure_at_ms: number | null;
  readonly last_error: string | null;
}
