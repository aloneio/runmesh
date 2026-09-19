import { controlPlaneUnavailable } from "../platform/control-plane.js";
import { registryRequest } from "../platform/control-plane.js";
import { runnerMutationState } from "../platform/runner-state.js";
import { signedInternalHeaders } from "../platform/control-plane.js";
import type { WorkerEnv } from "../platform/env.js";

export async function pushRunnerPolicy(env: WorkerEnv, runnerId: string, mutationId?: string): Promise<Response> {
  const body = JSON.stringify(mutationId === undefined ? {} : { mutation_id: mutationId });
  const headers = await signedInternalHeaders(env, "POST", "/policy", body);
  if (headers === undefined) return controlPlaneUnavailable();
  try { return completedMutationResponse(await env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/policy", { method: "POST", headers, body }))); }
  catch { return new Response("runner unavailable", { status: 503 }); }
}

export async function beginRunnerPolicyMutation(env: WorkerEnv, runnerId: string, mutationId: string): Promise<Response> {
  const body = JSON.stringify({ mutation_id: mutationId, runner_id: runnerId });
  const headers = await signedInternalHeaders(env, "POST", "/begin-policy-mutation", body);
  if (headers === undefined) return controlPlaneUnavailable();
  try { return completedMutationResponse(await env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/begin-policy-mutation", { method: "POST", headers, body }))); }
  catch { return new Response("runner unavailable", { status: 503 }); }
}

async function markRunnerPolicyCommitted(env: WorkerEnv, runnerId: string, mutationId: string, phase: "committed_pending" | "offline_pending", desiredRevision: number, desiredChecksum: string): Promise<Response> {
  const body = JSON.stringify({ mutation_id: mutationId, phase, desired_revision: desiredRevision, desired_checksum: desiredChecksum });
  const headers = await signedInternalHeaders(env, "POST", "/mark-policy-committed", body);
  if (headers === undefined) return controlPlaneUnavailable();
  try { return completedMutationResponse(await env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/mark-policy-committed", { method: "POST", headers, body }))); }
  catch { return new Response("runner unavailable", { status: 503 }); }
}

export async function cancelRunnerPolicyMutation(env: WorkerEnv, runnerId: string, mutationId: string): Promise<Response> {
  const body = JSON.stringify({ mutation_id: mutationId });
  const headers = await signedInternalHeaders(env, "POST", "/cancel-policy-mutation", body);
  if (headers === undefined) return controlPlaneUnavailable();
  try { return completedMutationResponse(await env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/cancel-policy-mutation", { method: "POST", headers, body }))); }
  catch { return new Response("runner unavailable", { status: 503 }); }
}

/** RunnerDO commits these transport mutations synchronously with 204. The
 * policy orchestrator's later 202 describes a committed desired policy; it
 * cannot serve as evidence that a fence or transport transition completed. */
function completedMutationResponse(response: Response): Response {
  if (response.status === 204 || !response.ok) return response;
  void response.body?.cancel().catch(() => undefined);
  return new Response("runner mutation outcome is uncertain", { status: 503 });
}

export async function mutateRunnerPolicy(env: WorkerEnv, runnerId: string, mutation: { readonly path: string; readonly method: "POST" | "PUT" | "DELETE"; readonly payload: Record<string, unknown> }): Promise<Response> {
  const mutationId = `mutation-${crypto.randomUUID()}`;
  let fenced: Response;
  try { fenced = await beginRunnerPolicyMutation(env, runnerId, mutationId); } catch { return new Response("runner policy fence unavailable", { status: 503 }); }
  if (!fenced.ok) return fenced;
  let changed: Response;
  try { changed = await registryRequest(env, mutation.path, mutation.method, JSON.stringify({ mutation_id: mutationId, ...mutation.payload })); } catch { return new Response("registry unavailable after policy fence", { status: 503 }); }
  if (!changed.ok) {
    // A Registry 5xx response is not evidence that no write committed. Do not
    // attempt to treat it as a safe client rejection; leave the transport
    // fenced and hide the uncertain upstream response behind 503.
    if (![400, 404, 409].includes(changed.status)) return new Response("registry mutation outcome is uncertain; Runner remains safely fenced", { status: 503 });
    try {
      const cancelled = await cancelRunnerPolicyMutation(env, runnerId, mutationId);
      if (!cancelled.ok) return new Response("policy mutation failed; Runner remains safely fenced", { status: 503 });
    } catch { return new Response("policy mutation state is uncertain; Runner remains safely fenced", { status: 503 }); }
    return changed;
  }
  const mutationState = await runnerMutationState(env, runnerId, mutationId).catch(() => undefined);
  if (mutationState?.mutation_committed !== true) return new Response("policy mutation outcome is uncertain; Runner remains safely fenced", { status: 503 });
  const phase = mutationState.policy_status === "offline_pending" ? "offline_pending" : "committed_pending";
  try {
    const committed = await markRunnerPolicyCommitted(env, runnerId, mutationId, phase, typeof mutationState.desired_revision === "number" ? mutationState.desired_revision : 0, typeof mutationState.desired_checksum === "string" ? mutationState.desired_checksum : "");
    if (!committed.ok) return new Response("policy mutation outcome is uncertain; Runner remains safely fenced", { status: 503 });
  } catch { return new Response("policy mutation outcome is uncertain; Runner remains safely fenced", { status: 503 }); }
  try {
    const pushed = await pushRunnerPolicy(env, runnerId, mutationId);
    if (!pushed.ok && pushed.status !== 204 && pushed.status !== 503) return pushed;
  } catch { /* desired policy remains pending for reconnect */ }
  // A committed desired policy is successful even while its Runner is offline
  // or validating it. Browser requests redirect normally; token API callers get
  // an explicit accepted response rather than a false transient failure.
  return new Response(changed.body, { status: 202, headers: changed.headers });
}
