import { deleteRunner } from "../application/delete-runner.js";
import { fenceRunnerTransport, deleteRunnerTransport } from "../application/runner-lifecycle.js";
import { cancelRunnerPolicyMutation } from "../application/runner-policy.js";
import { runnerMutationState } from "../platform/runner-state.js";
import { runnerRegistryRequest } from "../platform/control-plane.js";
import type { WorkerEnv } from "../platform/env.js";
import type { RunnerDeletionResult } from "../contracts/runner-deletion.js";

/** Request-local wiring. Construction does not read or mutate remote state. */
export function deleteRunnerFromControlPlane(env: WorkerEnv, runnerId: string, confirmation: unknown): Promise<RunnerDeletionResult> {
  return deleteRunner({
    mutationId: () => `runner-delete-${crypto.randomUUID()}`,
    fence: (id, mutation) => fenceRunnerTransport(env, id, mutation),
    remove: (id, mutation) => runnerRegistryRequest(env, id, "", "DELETE", JSON.stringify({ confirmation: id, mutation_id: mutation })),
    observe: (id, mutation) => runnerMutationState(env, id, mutation),
    cancel: (id, mutation) => cancelRunnerPolicyMutation(env, id, mutation),
    finalize: (id, mutation) => deleteRunnerTransport(env, id, mutation),
  }, runnerId, confirmation);
}
