import { runnerSummary, clientSummary } from "../application/admin-projections.js";
import type { AdminData } from "../admin/view-models.js";
import type { AdminNotice } from "../admin/view-models.js";
import { arrayField } from "../values.js";
import { json } from "../platform/control-plane.js";
import type { ClientViewModel } from "../contracts/admin-views.js";
import { record } from "../values.js";
import type { RegistryFeatureHealth } from "../contracts/feature-health.js";
import { registryGet } from "../platform/control-plane.js";
import type { RunnerSummaryViewModel } from "../contracts/admin-views.js";
import type { WorkerEnv } from "../platform/env.js";

const FEATURE_LABELS: Record<RegistryFeatureHealth["feature"], string> = {
  job_recording: "Job recording",
  mcp_audit: "MCP call audit",
  mcp_usage_tracking: "MCP usage tracking",
  auth_throttle: "Login protection",
  maintenance_alarm: "Maintenance alarm",
};

const FEATURE_NOTICE_TEXT: Record<RegistryFeatureHealth["feature"], AdminNotice> = {
  job_recording: {
    title: "Job recording paused",
    message: "Job history and MCP call recording are temporarily disabled.",
  },
  mcp_audit: {
    title: "MCP call audit paused",
    message: "MCP call recording is temporarily disabled.",
  },
  mcp_usage_tracking: {
    title: "MCP usage tracking paused",
    message: "MCP authentication remains available; last-used telemetry is temporarily disabled.",
  },
  auth_throttle: {
    title: "Login protection paused",
    message: "Administrator login remains available; persistent login throttling is temporarily disabled.",
  },
  maintenance_alarm: {
    title: "Maintenance alarm paused",
    message: "Background cleanup and stale-runner checks are temporarily disabled.",
  },
};

const FEATURE_STATUS_UNAVAILABLE_NOTICE: AdminNotice = {
  title: "Feature health status unavailable",
  message: "Core Runner and MCP paths remain available; retry the console shortly.",
};

export async function loadDashboardData(env: WorkerEnv, includeJobs = true): Promise<AdminData> {
  // The dashboard includes persisted job summaries. Other top-level pages do
  // not need job queries, and no page load performs a live Runner job scan.
  const [clientsResponse, snapshotResponse, notices] = await Promise.all([
    registryGet(env, "/auth/clients"), registryGet(env, includeJobs ? "/dashboard" : "/runners"), loadFeatureNotices(env),
  ]);
  let clients: ClientViewModel[] = [];
  try { clients = clientsResponse.ok ? ((record(await json(clientsResponse))?.clients ?? []) as ClientViewModel[]) : []; } catch { clients = []; }
  let snapshotBody: Record<string, unknown> | undefined;
  try { snapshotBody = snapshotResponse.ok ? record(await json(snapshotResponse)) : undefined; } catch { snapshotBody = undefined; }
  const runners = Array.isArray(snapshotBody?.runners) ? snapshotBody.runners as RunnerSummaryViewModel[] : [];
  const jobs = includeJobs && Array.isArray(snapshotBody?.jobs) ? snapshotBody.jobs.filter(record) as Record<string, unknown>[] : [];
  const snapshotUnavailable = includeJobs && !Array.isArray(snapshotBody?.jobs);
  return { clients: clients.map(clientSummary), runners: runners.map(runnerSummary), jobs, snapshot: { ...(Array.isArray(snapshotBody?.runners) ? { runners: runners.map(runnerSummary) } : {}), ...(Array.isArray(snapshotBody?.jobs) ? { jobs } : {}) }, notices: snapshotUnavailable ? [...notices, { title: "Job snapshot unavailable", message: "Job metadata is temporarily unavailable." }] : notices };
}

export async function loadFeatureNotices(env: WorkerEnv): Promise<readonly AdminNotice[]> {
  const response = await registryGet(env, "/status/features");
  if (!response.ok) return [FEATURE_STATUS_UNAVAILABLE_NOTICE];
  try { return registryFeatureNotices(record(await json(response))); } catch { return [FEATURE_STATUS_UNAVAILABLE_NOTICE]; }
}

function registryFeatureNotices(value: Record<string, unknown> | undefined): readonly AdminNotice[] {
  const features = arrayField(value?.features).map(record).filter((feature): feature is Record<string, unknown> => feature !== undefined);
  const now = Date.now();
  return features.flatMap((feature) => {
    const key = typeof feature.feature === "string" && keyIsFeature(feature.feature) ? feature.feature : undefined;
    const disabledUntilMs = typeof feature.disabled_until_ms === "number" && Number.isSafeInteger(feature.disabled_until_ms) ? feature.disabled_until_ms : null;
    if (key === undefined || disabledUntilMs === null || disabledUntilMs <= now) return [];
    const label = FEATURE_LABELS[key];
    const lastError = typeof feature.last_error === "string" && feature.last_error.length > 0 ? feature.last_error : undefined;
    return [lastError === undefined ? FEATURE_NOTICE_TEXT[key] : { ...FEATURE_NOTICE_TEXT[key], code: `${label}: ${lastError}` }];
  });
}

function keyIsFeature(value: string): value is RegistryFeatureHealth["feature"] {
  return value === "job_recording" || value === "mcp_audit" || value === "mcp_usage_tracking" || value === "auth_throttle" || value === "maintenance_alarm";
}
