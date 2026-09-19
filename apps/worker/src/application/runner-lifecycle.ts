import { cancelRunnerPolicyMutation } from "./runner-policy.js";
import { beginRunnerPolicyMutation } from "./runner-policy.js";
import { runnerMutationState } from "../platform/runner-state.js";
import { signedInternalHeaders } from "../platform/control-plane.js";
import type { WorkerEnv } from "../platform/env.js";

/** Release a pre-commit fence when a stale action is rejected before it can
 * touch Registry credentials or enrollment state.  If cancellation cannot be
 * proven, callers deliberately keep the fence and return a safe 503. */
export async function releaseUncommittedRunnerFence(env: WorkerEnv, runnerId: string, mutationId: string): Promise<boolean> {
  try {
    const cancelled = await cancelRunnerPolicyMutation(env, runnerId, mutationId);
    return cancelled.ok;
  } catch { return false; }
}

export async function fenceRunnerTransport(env: WorkerEnv, runnerId: string, mutationId: string): Promise<Response> {
  return beginRunnerPolicyMutation(env, runnerId, mutationId);
}

export async function revokeRunnerTransport(env: WorkerEnv, runnerId: string, mutationId: string, allowLifecycleChange = false): Promise<void> {
  const body = JSON.stringify({ mutation_id: mutationId, ...(allowLifecycleChange ? { allow_lifecycle_change: true } : {}) });
  const headers = await signedInternalHeaders(env, "POST", "/revoke", body);
  if (headers === undefined) throw new Error("control plane is not configured");
  let response: Response;
  try { response = await env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/revoke", { method: "POST", headers, body })); }
  catch (error) { throw error; }
  if (response.status !== 204) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(`RunnerDO revoke did not confirm completion (${response.status})`);
  }
}

export async function deleteRunnerTransport(env: WorkerEnv, runnerId: string, mutationId: string): Promise<void> {
  const body = JSON.stringify({ mutation_id: mutationId });
  const headers = await signedInternalHeaders(env, "POST", "/delete", body);
  if (headers === undefined) throw new Error("control plane is not configured");
  const response = await env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/delete", { method: "POST", headers, body }));
  if (response.status !== 204) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(`RunnerDO delete did not confirm completion (${response.status})`);
  }
}

/** Resolve a fenced mutation after a Registry response that may have been
 * lost.  A committed mutation is finalized by closing RunnerDO sockets; an
 * uncommitted one is cancelled only after the DO re-verifies Registry state.
 * Any inability to prove either outcome leaves the fence in place. */
export async function settleRunnerMutation(env: WorkerEnv, runnerId: string, mutationId: string, allowLifecycleChange = false): Promise<"committed" | "cancelled" | "uncertain"> {
  const state = await runnerMutationState(env, runnerId, mutationId).catch(() => undefined);
  if (state?.mutation_committed === true) {
    try { await revokeRunnerTransport(env, runnerId, mutationId, allowLifecycleChange); return "committed"; }
    catch { return "uncertain"; }
  }
  try {
    const cancelled = await cancelRunnerPolicyMutation(env, runnerId, mutationId);
    return cancelled.ok ? "cancelled" : "uncertain";
  } catch { return "uncertain"; }
}

export { runnerMutationState } from "../platform/runner-state.js";
