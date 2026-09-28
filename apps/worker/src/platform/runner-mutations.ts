import { controlPlaneUnavailable } from "./control-plane.js";
import { signedInternalHeaders } from "./control-plane.js";
import type { WorkerEnv } from "./env.js";
export async function pushRunnerPolicy(env: WorkerEnv, runnerId: string, mutationId?: string): Promise<Response> {
  const body = JSON.stringify(mutationId === undefined ? {} : {
    mutation_id: mutationId
  });
  const headers = await signedInternalHeaders(env, "POST", "/policy", body);
  if (headers === undefined) return controlPlaneUnavailable();
  try {
    return completedMutationResponse(await env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/policy", {
      method: "POST",
      headers,
      body
    })));
  } catch {
    return new Response("runner unavailable", {
      status: 503
    });
  }
}
export async function beginRunnerPolicyMutation(env: WorkerEnv, runnerId: string, mutationId: string): Promise<Response> {
  const body = JSON.stringify({
    mutation_id: mutationId,
    runner_id: runnerId
  });
  const headers = await signedInternalHeaders(env, "POST", "/begin-policy-mutation", body);
  if (headers === undefined) return controlPlaneUnavailable();
  try {
    return completedMutationResponse(await env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/begin-policy-mutation", {
      method: "POST",
      headers,
      body
    })));
  } catch {
    return new Response("runner unavailable", {
      status: 503
    });
  }
}
export async function markRunnerPolicyCommitted(env: WorkerEnv, runnerId: string, mutationId: string, phase: "committed_pending" | "offline_pending", desiredRevision: number, desiredChecksum: string): Promise<Response> {
  const body = JSON.stringify({
    mutation_id: mutationId,
    phase,
    desired_revision: desiredRevision,
    desired_checksum: desiredChecksum
  });
  const headers = await signedInternalHeaders(env, "POST", "/mark-policy-committed", body);
  if (headers === undefined) return controlPlaneUnavailable();
  try {
    return completedMutationResponse(await env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/mark-policy-committed", {
      method: "POST",
      headers,
      body
    })));
  } catch {
    return new Response("runner unavailable", {
      status: 503
    });
  }
}
export async function cancelRunnerPolicyMutation(env: WorkerEnv, runnerId: string, mutationId: string): Promise<Response> {
  const body = JSON.stringify({
    mutation_id: mutationId
  });
  const headers = await signedInternalHeaders(env, "POST", "/cancel-policy-mutation", body);
  if (headers === undefined) return controlPlaneUnavailable();
  try {
    return completedMutationResponse(await env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/cancel-policy-mutation", {
      method: "POST",
      headers,
      body
    })));
  } catch {
    return new Response("runner unavailable", {
      status: 503
    });
  }
}

/** RunnerDO commits these transport mutations synchronously with 204. The
 * policy orchestrator's later 202 describes a committed desired policy; it
 * cannot serve as evidence that a fence or transport transition completed. */
function completedMutationResponse(response: Response): Response {
  if (response.status === 204 || !response.ok) return response;
  void response.body?.cancel().catch(() => undefined);
  return new Response("runner mutation outcome is uncertain", {
    status: 503
  });
}
export function fenceRunnerTransport(env: WorkerEnv, runnerId: string, mutationId: string): Promise<Response> {
  return beginRunnerPolicyMutation(env, runnerId, mutationId);
}
export async function revokeRunnerTransport(env: WorkerEnv, runnerId: string, mutationId: string, allowLifecycleChange = false): Promise<void> {
  const body = JSON.stringify({
    mutation_id: mutationId,
    ...(allowLifecycleChange ? {
      allow_lifecycle_change: true
    } : {})
  });
  const headers = await signedInternalHeaders(env, "POST", "/revoke", body);
  if (headers === undefined) throw new Error("control plane is not configured");
  let response: Response;
  try {
    response = await env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/revoke", {
      method: "POST",
      headers,
      body
    }));
  } catch (error) {
    throw error;
  }
  if (response.status !== 204) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(`RunnerDO revoke did not confirm completion (${response.status})`);
  }
}
export async function deleteRunnerTransport(env: WorkerEnv, runnerId: string, mutationId: string): Promise<void> {
  const body = JSON.stringify({
    mutation_id: mutationId
  });
  const headers = await signedInternalHeaders(env, "POST", "/delete", body);
  if (headers === undefined) throw new Error("control plane is not configured");
  const response = await env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/delete", {
    method: "POST",
    headers,
    body
  }));
  if (response.status !== 204) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(`RunnerDO delete did not confirm completion (${response.status})`);
  }
}
