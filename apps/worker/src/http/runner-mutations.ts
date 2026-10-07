import type { RunnerLifecyclePorts, RunnerWriteResult } from "../contracts/runner-mutations.js";
import { cancelRunnerPolicyMutation, revokeRunnerTransport } from "../platform/runner-mutations.js";
import { runnerMutationState } from "../platform/runner-state.js";
import type { WorkerEnv } from "../platform/env.js";

/** Status-only adapters own the upstream body, while application ports own no
 * transport. Cleanup cannot delay a receipt or cause a mutation to be replayed. */
export function runnerStatusReceipt(response: Response): { readonly ok: boolean; readonly status: number } {
  void response.body?.cancel().catch(() => undefined);
  return { ok: response.ok, status: response.status };
}

export function runnerLifecyclePorts(env: WorkerEnv): RunnerLifecyclePorts {
  return {
    observe: (id, mutation) => runnerMutationState(env, id, mutation),
    cancel: async (id, mutation, evidence) => {
      return runnerStatusReceipt(await cancelRunnerPolicyMutation(env, id, mutation, evidence)).ok;
    },
    finalize: (id, mutation, changed) => revokeRunnerTransport(env, id, mutation, changed)
  };
}
export function registryWriteResult(response: Response): RunnerWriteResult<Response> {
  return response.ok ? {
    state: "accepted",
    value: response
  } : [400, 403, 404, 409].includes(response.status) ? {
    state: "rejected",
    value: response
  } : {
    state: "unknown"
  };
}
