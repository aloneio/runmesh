import { boundedJsonResponse } from "./bounded-json.js";
import { record } from "../values.js";
import { registryRequest } from "./control-plane.js";
import type { WorkerEnv } from "./env.js";

export async function runnerMutationState(env: WorkerEnv, runnerId: string, mutationId: string): Promise<Record<string, unknown> | undefined> {
  const path = `/runners/${encodeURIComponent(runnerId)}/mutation-state?mutation_id=${encodeURIComponent(mutationId)}`;
  const response = await boundedJsonResponse(signal => registryRequest(env, path, "GET", "", signal));
  return response?.status === 200 ? record(response.value) : undefined;
}
