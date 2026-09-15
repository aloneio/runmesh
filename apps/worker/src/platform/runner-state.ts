import { json } from "./control-plane.js";
import { record } from "../values.js";
import { registryGet } from "./control-plane.js";
import type { WorkerEnv } from "./env.js";

export async function runnerMutationState(env: WorkerEnv, runnerId: string, mutationId: string): Promise<Record<string, unknown> | undefined> {
  const response = await registryGet(env, `/runners/${encodeURIComponent(runnerId)}/mutation-state?mutation_id=${encodeURIComponent(mutationId)}`);
  return response.ok ? record(await json(response)) : undefined;
}
