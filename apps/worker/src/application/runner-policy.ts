import type { RunnerPolicyPorts, RunnerPolicyResult } from "../contracts/runner-mutations.js";

/** Ordering only. Adapters classify evidence; HTTP and signing stay outside the use case. */
export async function mutateRunnerPolicy<T>(ports: RunnerPolicyPorts<T>, runnerId: string): Promise<RunnerPolicyResult<T>> {
  const mutationId = ports.mutationId();
  try { const fenced = await ports.fence(runnerId, mutationId); if (!fenced.ok) return { state: "rejected", value: fenced.value }; }
  catch { return { state: "failed", reason: "fence" }; }
  let changed;
  try { changed = await ports.change(mutationId); } catch { return { state: "failed", reason: "write" }; }
  if (changed.state === "unknown") return { state: "failed", reason: "commit" };
  if (changed.state === "rejected") {
    try { if (!await ports.cancel(runnerId, mutationId)) return { state: "failed", reason: "cancel" }; }
    catch { return { state: "failed", reason: "recovery" }; }
    return changed;
  }
  const evidence = await ports.observe(runnerId, mutationId).catch(() => undefined);
  if (evidence?.mutation_committed !== true) return { state: "failed", reason: "evidence" };
  const phase = evidence.policy_status === "offline_pending" ? "offline_pending" : "committed_pending";
  try {
    if (!await ports.mark(runnerId, mutationId, phase, typeof evidence.desired_revision === "number" ? evidence.desired_revision : 0, typeof evidence.desired_checksum === "string" ? evidence.desired_checksum : "")) return { state: "failed", reason: "evidence" };
  } catch { return { state: "failed", reason: "evidence" }; }
  try { const pushed = await ports.push(runnerId, mutationId); if (pushed.state === "rejected") return pushed; }
  catch { /* Committed desired policy remains pending for reconnect. */ }
  return { state: "accepted", value: changed.value };
}
