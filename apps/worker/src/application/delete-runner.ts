import type { RunnerDeletionPorts, RunnerDeletionResult } from "../contracts/runner-deletion.js";

/** Callers supply their independently authenticated principal context first.
 * This owns ordering, not authorization. Unknown outcomes never trigger retries,
 * fence release, invented rollback or a second mutation identifier. */
export async function deleteRunner(ports: RunnerDeletionPorts, runnerId: string, confirmation: unknown): Promise<RunnerDeletionResult> {
  if (confirmation !== runnerId) return { state: "rejected", reason: "confirmation", status: 400 };
  const mutationId = ports.mutationId();
  try {
    const fenced = await ports.fence(runnerId, mutationId);
    if (!fenced.ok) return { state: "unavailable", reason: "fence" };
  } catch { return { state: "unavailable", reason: "fence" }; }
  let response: { readonly ok: boolean; readonly status: number };
  try { response = await ports.remove(runnerId, mutationId); }
  catch { return { state: "unknown", reason: "commit" }; }
  if (!response.ok) {
    if (![400, 403, 404, 409].includes(response.status)) return { state: "unknown", reason: "commit" };
    try {
      const state = await ports.observe(runnerId, mutationId);
      if (state?.runner_exists === false && state.mutation_committed === true) {
        try { await ports.finalize(runnerId, mutationId); }
        catch { return { state: "unknown", reason: "finalize_recovered" }; }
        return { state: "deleted" };
      }
      // Browser authorization can expire after the transport fence is taken.
      // Release that rejected write only with explicit uncommitted evidence.
      if (response.status === 403 && (state?.runner_exists !== true || state.mutation_committed !== false)) {
        return { state: "unknown", reason: "recovery" };
      }
      const cancelled = await ports.cancel(runnerId, mutationId);
      if (!cancelled.ok) return { state: "unknown", reason: "cancel" };
    } catch { return { state: "unknown", reason: "recovery" }; }
    return { state: "rejected", reason: "registry", status: response.status };
  }
  try { await ports.finalize(runnerId, mutationId); }
  catch { return { state: "unknown", reason: "finalize" }; }
  return { state: "deleted" };
}
