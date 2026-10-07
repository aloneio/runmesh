import { parseHistoryLifecycles, validHistoryRunnerIds, type HistoryLifecycleReader } from "../contracts/history-lifecycle.js";
import { boundedJsonResponse } from "../bounded-json.js";
import { registryRequest } from "./control-plane.js";
import type { WorkerEnv } from "./env.js";

/** Cleanup reads only the identities in its bounded D1 batch; no mutation nonce. */
export function historyLifecycleReader(env: WorkerEnv): HistoryLifecycleReader {
  return async runnerIds => {
    if (!validHistoryRunnerIds(runnerIds)) throw new Error("invalid history lifecycle batch");
    const query = new URLSearchParams(runnerIds.map(id => ["runner_id", id]));
    const response = await boundedJsonResponse(signal => registryRequest(env, `/history/lifecycles?${query}`, "GET", "", signal));
    const result = response?.status === 200 ? parseHistoryLifecycles(response.value, runnerIds) : undefined;
    if (result === undefined) throw new Error("history lifecycle snapshot unavailable");
    return result;
  };
}
