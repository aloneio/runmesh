import { runnerDetail } from "../application/admin-projections.js";
import { loadLiveJobs } from "../application/runner-queries.js";
import { runnerQueryPorts } from "../platform/control-plane-receipts.js";
import type { HistoryView } from "../history-ui.js";
import { parseJobHistorySettings, type JobHistorySettings } from "@aloneio/runmesh-protocol";
import { registryGet } from "../platform/control-plane.js";
import type { WorkerEnv } from "../platform/env.js";
import { record } from "../values.js";
import { registryArray, registryRecord } from "./admin-read.js";

type RunnerDetailData = { state: "missing" } | { state: "unavailable" } | {
  state: "loaded";
  runner: Record<string, unknown>;
  workspaces: Record<string, unknown>[];
  policyVersions: Record<string, unknown>[];
  enrollment: Record<string, unknown> | undefined;
  jobs: Record<string, unknown>[] | undefined;
  mcpCalls: Record<string, unknown>[] | undefined;
  settings: JobHistorySettings | undefined;
};

/** Required configuration must load before its edit forms are rendered.
 * History and diagnostics can be unavailable without blocking management. */
export async function loadRunnerDetailData(env: WorkerEnv, runnerId: string, view: HistoryView): Promise<RunnerDetailData> {
  const path = "/runners/" + encodeURIComponent(runnerId);
  try {
    const [runnerResponse, workspaces, policyVersions, enrollmentBody, settingsBody, jobs, mcpCalls] = await Promise.all([
      registryGet(env, path),
      registryGet(env, "/auth" + path + "/managed-workspaces").then(response => registryArray(response, "workspaces")),
      registryGet(env, path + "/policy-versions").then(response => registryArray(response, "versions")),
      registryGet(env, "/auth" + path + "/enrollments").then(registryRecord),
      registryGet(env, path + "/history-settings").then(registryRecord),
      view.scope === "live" ? loadLiveJobs(runnerQueryPorts(env), runnerId, view.workspace!, view.limit)
        : view.scope === "jobs" || view.scope === "all" ? registryGet(env, path + "/jobs?limit=" + view.limit).then(response => registryArray(response, "jobs")) : undefined,
      view.scope === "audit" || view.scope === "all" ? registryGet(env, path + "/mcp-calls?limit=" + view.limit).then(response => registryArray(response, "calls")) : undefined,
    ]);
    const missing = runnerResponse.status === 404;
    const runner = await registryRecord(runnerResponse);
    if (missing) return { state: "missing" };
    if (runner?.runner_id !== runnerId || workspaces === undefined || enrollmentBody === undefined
      || !Object.hasOwn(enrollmentBody, "enrollment")) return { state: "unavailable" };
    const enrollment = record(enrollmentBody.enrollment);
    if (enrollmentBody.enrollment !== null && enrollment === undefined) return { state: "unavailable" };
    // The renderer derives validation diagnostics from workspaces if policy history is unavailable.
    return { state: "loaded", runner: runnerDetail(runner), workspaces, policyVersions: policyVersions ?? [], enrollment, jobs, mcpCalls, settings: parseJobHistorySettings(settingsBody) };
  } catch { return { state: "unavailable" }; }
}
