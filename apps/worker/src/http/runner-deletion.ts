import { deleteRunner } from "../application/delete-runner.js";
import { fenceRunnerTransport } from "../platform/runner-mutations.js";
import { deleteRunnerTransport } from "../platform/runner-mutations.js";
import { cancelRunnerPolicyMutation } from "../platform/runner-mutations.js";
import { runnerMutationState } from "../platform/runner-state.js";
import { runnerRegistryRequest } from "../platform/control-plane.js";
import type { WorkerEnv } from "../platform/env.js";
import type { RunnerDeletionResult } from "../contracts/runner-deletion.js";
import { runnerStatusReceipt } from "./runner-mutations.js";

/** Request-local wiring. Construction does not read or mutate remote state. */
export function deleteRunnerFromControlPlane(env: WorkerEnv, runnerId: string, confirmation: unknown): Promise<RunnerDeletionResult> {
  return deleteRunner({
    mutationId: () => `runner-delete-${crypto.randomUUID()}`,
    fence: async (id, mutation) => runnerStatusReceipt(await fenceRunnerTransport(env, id, mutation)),
    remove: async (id, mutation) => runnerStatusReceipt(await runnerRegistryRequest(env, id, "", "DELETE", JSON.stringify({ confirmation: id, mutation_id: mutation }))),
    observe: (id, mutation) => runnerMutationState(env, id, mutation),
    cancel: async (id, mutation) => runnerStatusReceipt(await cancelRunnerPolicyMutation(env, id, mutation)),
    finalize: (id, mutation) => deleteRunnerTransport(env, id, mutation),
  }, runnerId, confirmation);
}
