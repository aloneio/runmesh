import type { RunnerActionFailure, RunnerCreationPorts, RunnerEnrollmentSuccess, RunnerWriteOutcome } from "../contracts/runner-administration.js";
import { settleRunnerMutation } from "./runner-lifecycle.js";

/** Keep ownership of the fence through code issuance and transport finalization. */
export async function createRunner(ports: RunnerCreationPorts, runnerId: string): Promise<RunnerEnrollmentSuccess | RunnerActionFailure> {
  const mutationId = ports.mutationId();
  try {
    if (!(await ports.canRead(runnerId))) return {
      state: "failed",
      reason: "read"
    };
  } catch {
    return {
      state: "failed",
      reason: "read"
    };
  }
  try {
    if (!(await ports.fence(runnerId, mutationId))) return {
      state: "failed",
      reason: "fence"
    };
  } catch {
    return {
      state: "failed",
      reason: "fence"
    };
  }
  let changed: RunnerWriteOutcome;
  try {
    changed = await ports.create(runnerId, mutationId);
  } catch {
    changed = "unknown";
  }
  if (changed !== "accepted") {
    const rejection = changed === "unknown" ? undefined : { confirmedWriteRejection: true as const };
    if ((await settleRunnerMutation(ports, runnerId, mutationId, true, rejection)) === "uncertain") return {
      state: "failed",
      reason: "commit"
    };
    return {
      state: "failed",
      reason: "write",
      cause: changed
    };
  }
  const evidence = await ports.observe(runnerId, mutationId).catch(() => undefined);
  if (evidence?.mutation_committed !== true) return {
    state: "failed",
    reason: "commit"
  };
  if (typeof evidence.lifecycle_id !== "string" || evidence.lifecycle_id.length === 0) return {
    state: "failed",
    reason: "enrollment_state"
  };
  const enrollment = await ports.enroll(runnerId, evidence.lifecycle_id).catch(() => ({
    ok: false as const,
    status: 503,
    deterministic: false
  }));
  if (!enrollment.ok) {
    if (!enrollment.deterministic) return {
      state: "failed",
      reason: "enrollment"
    };
    if ((await settleRunnerMutation(ports, runnerId, mutationId, true)) === "uncertain") return {
      state: "failed",
      reason: "enrollment_recovery"
    };
    return {
      state: "failed",
      reason: "enrollment_rejected",
      cause: enrollment.status === 403 ? "denied" : enrollment.status === 404 ? "missing" : "conflict"
    };
  }
  try {
    await ports.finalize(runnerId, mutationId, true);
  } catch {
    return {
      state: "failed",
      reason: "finalize"
    };
  }
  return {
    state: "completed",
    enrollment
  };
}
