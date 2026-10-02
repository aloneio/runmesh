import type { RunnerLifecyclePorts, RunnerWriteResult } from "../contracts/runner-mutations.js";
import { cancelRunnerPolicyMutation, revokeRunnerTransport } from "../platform/runner-mutations.js";
import { runnerMutationState } from "../platform/runner-state.js";
import type { WorkerEnv } from "../platform/env.js";
export function runnerLifecyclePorts(env: WorkerEnv): RunnerLifecyclePorts {
  return {
    observe: (id, mutation) => runnerMutationState(env, id, mutation),
    cancel: async (id, mutation) => {
      const response = await cancelRunnerPolicyMutation(env, id, mutation);
      void response.body?.cancel().catch(() => undefined);
      return response.ok;
    },
    finalize: (id, mutation, changed) => revokeRunnerTransport(env, id, mutation, changed)
  };
}
export function registryWriteResult(response: Response): RunnerWriteResult<Response> {
  return response.ok ? {
    state: "accepted",
    value: response
  } : [400, 404, 409].includes(response.status) ? {
    state: "rejected",
    value: response
  } : {
    state: "unknown"
  };
}
