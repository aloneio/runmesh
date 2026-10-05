import { runnerSummary, clientSummary } from "../application/admin-projections.js";
import type { AdminData, AdminNotice, ClientViewModel, RunnerSummaryViewModel } from "../contracts/admin-views.js";
import { arrayField, record } from "../values.js";
import { json, registryGet } from "../platform/control-plane.js";
import type { RegistryFeatureHealth } from "../contracts/feature-health.js";
import type { WorkerEnv } from "../platform/env.js";
import { recordArray, registryArray, registryRecord } from "./admin-read.js";

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

export async function loadAdminPageData(env: WorkerEnv, section: "dashboard" | "runners" | "clients"): Promise<AdminData | undefined> {
  // The dashboard includes persisted job summaries. Other top-level pages do
  // not need job queries, and no page load performs a live Runner job scan.
  const includeJobs = section === "dashboard" && env.RUNMESH_JOB_HISTORY_BACKEND !== "d1";
  try {
    const [clients, snapshotBody, notices] = await Promise.all([
      section === "runners" ? Promise.resolve([]) : registryGet(env, "/auth/clients").then(response => registryArray(response, "clients")),
      registryGet(env, includeJobs ? "/dashboard" : "/runners").then(registryRecord),
      loadFeatureNotices(env),
    ]);
    if (clients === undefined) return undefined;
    // History can fail independently; the Runner list remains authoritative.
    const runners = recordArray(snapshotBody?.runners) ?? (includeJobs ? await registryGet(env, "/runners").then(response => registryArray(response, "runners")) : undefined);
    if (runners === undefined) return undefined;
    const jobs = includeJobs ? recordArray(snapshotBody?.jobs) : undefined;
    const projectedRunners = runners.map(runnerSummary);
    return { clients: clients.map(clientSummary), runners: projectedRunners, jobs: jobs ?? [], snapshot: { runners: projectedRunners, ...(jobs === undefined ? {} : { jobs }) }, notices: includeJobs && jobs === undefined ? [...notices, { title: "Job snapshot unavailable", message: "Job metadata is temporarily unavailable." }] : notices };
  } catch { return undefined; }
}

type ClientDetailData =
  | { state: "missing" }
  | { state: "unavailable" }
  | { state: "loaded"; client: ClientViewModel; runners: RunnerSummaryViewModel[]; overrides: Record<string, unknown>[]; notices: readonly AdminNotice[] };

/** A failed permission read cannot be rendered as an empty, editable list. */
export async function loadClientDetailData(env: WorkerEnv, clientId: string): Promise<ClientDetailData> {
  try {
    const [clients, runners, overrides, notices] = await Promise.all([
      registryGet(env, "/auth/clients").then(response => registryArray(response, "clients")),
      registryGet(env, "/runners").then(response => registryArray(response, "runners")),
      registryGet(env, "/auth/clients/" + encodeURIComponent(clientId) + "/runner-overrides").then(response => registryArray(response, "overrides")),
      loadFeatureNotices(env),
    ]);
    if (clients === undefined) return { state: "unavailable" };
    const client = clients.map(clientSummary).find(value => value.client_id === clientId);
    if (client === undefined) return { state: "missing" };
    if (runners === undefined || overrides === undefined) return { state: "unavailable" };
    return { state: "loaded", client, runners: runners.map(runnerSummary), overrides, notices };
  } catch { return { state: "unavailable" }; }
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
