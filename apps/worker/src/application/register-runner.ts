import type { RunnerRegistrationPorts, RunnerRegistrationResult } from "../contracts/runner-administration.js";
import { settleRunnerMutation } from "./runner-lifecycle.js";

/** Registration and credential replacement share one fenced commit protocol. */
export async function registerRunner(ports: RunnerRegistrationPorts, runnerId: string, hasExecutionMode: boolean): Promise<RunnerRegistrationResult> {
  const mutationId = ports.mutationId();
  const initial = await ports.read(runnerId).catch(() => "unavailable" as const);
  if (initial === "unavailable") return {
    state: "failed",
    reason: "read"
  };
  if (initial === "missing" && !hasExecutionMode) return {
    state: "failed",
    reason: "mode_required"
  };
  // Missing Registry state does not prove the transport has been cleaned up.
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
  let written;
  try {
    written = await ports.write(runnerId, mutationId);
  } catch {
    await settleRunnerMutation(ports, runnerId, mutationId, true);
    return {
      state: "failed",
      reason: "commit"
    };
  }
  if (written === "unknown") return {
    state: "failed",
    reason: "commit"
  };
  if (written !== "accepted") {
    const evidence = await ports.observe(runnerId, mutationId).catch(() => undefined);
    if (evidence?.mutation_committed === true) {
      try {
        await ports.finalize(runnerId, mutationId, true);
      } catch {
        return {
          state: "failed",
          reason: "recovery"
        };
      }
      return {
        state: "failed",
        reason: "post_commit"
      };
    }
    try {
      if (!(await ports.cancel(runnerId, mutationId, { confirmedWriteRejection: true }))) return {
        state: "failed",
        reason: "recovery"
      };
    } catch {
      return {
        state: "failed",
        reason: "recovery"
      };
    }
    return {
      state: "failed",
      reason: "write",
      cause: written
    };
  }
  const committed = await ports.observe(runnerId, mutationId).catch(() => undefined);
  if (committed?.mutation_committed !== true) return {
    state: "failed",
    reason: "commit"
  };
  // A replacement lifecycle is accepted only against this mutation's ledger.
  try {
    await ports.finalize(runnerId, mutationId, true);
  } catch {
    return {
      state: "failed",
      reason: "finalize"
    };
  }
  return {
    state: "completed"
  };
}
