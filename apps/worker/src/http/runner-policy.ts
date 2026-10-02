import { mutateRunnerPolicy as mutatePolicy } from "../application/runner-policy.js";
import { beginRunnerPolicyMutation, markRunnerPolicyCommitted, pushRunnerPolicy } from "../platform/runner-mutations.js";
import { registryRequest } from "../platform/control-plane.js";
import type { WorkerEnv } from "../platform/env.js";
import { registryWriteResult, runnerLifecyclePorts } from "./runner-mutations.js";
export async function mutateRunnerPolicy(env: WorkerEnv, runnerId: string, mutation: {
  readonly path: string;
  readonly method: "POST" | "PUT" | "DELETE";
  readonly payload: Record<string, unknown>;
}): Promise<Response> {
  // The HTTP adapter owns transport responses; the use case only orders effects.
  const responses = new Set<Response>();
  const track = (response: Response) => { responses.add(response); return response; };
  let forwarded: Response | undefined;
  try {
    const result = await mutatePolicy({
      ...runnerLifecyclePorts(env),
      mutationId: () => "mutation-" + crypto.randomUUID(),
      fence: async (id, token) => {
        const response = track(await beginRunnerPolicyMutation(env, id, token));
        return response.ok ? {
          ok: true
        } : {
          ok: false,
          value: response
        };
      },
      change: async token => registryWriteResult(track(await registryRequest(env, mutation.path, mutation.method, JSON.stringify({
        mutation_id: token,
        ...mutation.payload
      })))),
      mark: async (id, token, phase, revision, checksum) => track(await markRunnerPolicyCommitted(env, id, token, phase, revision, checksum)).ok,
      push: async (id, token) => {
        const response = track(await pushRunnerPolicy(env, id, token));
        return !response.ok && response.status !== 503 ? {
          state: "rejected",
          value: response
        } : {
          state: "pending"
        };
      }
    }, runnerId);
    if (result.state === "accepted") {
      const response = new Response(result.value.body, {
        status: 202,
        headers: result.value.headers
      });
      forwarded = result.value;
      return response;
    }
    if (result.state === "rejected") { forwarded = result.value; return result.value; }
    const messages = {
      fence: "runner policy fence unavailable",
      write: "registry unavailable after policy fence",
      commit: "registry mutation outcome is uncertain; Runner remains safely fenced",
      cancel: "policy mutation failed; Runner remains safely fenced",
      recovery: "policy mutation state is uncertain; Runner remains safely fenced",
      evidence: "policy mutation outcome is uncertain; Runner remains safely fenced"
    };
    return new Response(messages[result.reason], {
      status: 503
    });
  } finally {
    for (const response of responses) {
      if (response !== forwarded) void response.body?.cancel().catch(() => undefined);
    }
  }
}
