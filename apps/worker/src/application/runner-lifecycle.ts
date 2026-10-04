import type { RunnerLifecyclePorts } from "../contracts/runner-mutations.js";

export async function releaseUncommittedRunnerFence(ports: Pick<RunnerLifecyclePorts, "cancel">, runnerId: string, mutationId: string): Promise<boolean> {
  try { return await ports.cancel(runnerId, mutationId); } catch { return false; }
}

/** Recovery never invents rollback: Registry evidence and the transport owner decide completion. */
export async function settleRunnerMutation(ports: RunnerLifecyclePorts, runnerId: string, mutationId: string, allowLifecycleChange = false): Promise<"committed" | "cancelled" | "uncertain"> {
  const state = await ports.observe(runnerId, mutationId).catch(() => undefined);
  if (state?.mutation_committed === true) {
    try { await ports.finalize(runnerId, mutationId, allowLifecycleChange); return "committed"; }
    catch { return "uncertain"; }
  }
  try { return await ports.cancel(runnerId, mutationId) ? "cancelled" : "uncertain"; }
  catch { return "uncertain"; }
}
