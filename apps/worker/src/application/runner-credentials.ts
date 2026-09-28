import type { RunnerExecutionSnapshot } from "../contracts/runner-admin.js";
import type { RunnerActionFailure, RunnerEnrollmentSuccess, RunnerRevocationPorts, RunnerRotationPorts } from "../contracts/runner-administration.js";
import { releaseUncommittedRunnerFence, settleRunnerMutation } from "./runner-lifecycle.js";
export async function revokeRunner(ports: RunnerRevocationPorts, runnerId: string): Promise<{
  readonly state: "completed";
} | RunnerActionFailure> {
  const mutationId = ports.mutationId();
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
  let changed;
  try {
    changed = await ports.revoke(runnerId, mutationId);
  } catch {
    return {
      state: "failed",
      reason: "commit"
    };
  }
  if (changed === "unknown") return {
    state: "failed",
    reason: "commit"
  };
  if (changed !== "accepted") {
    try {
      if (!(await ports.cancel(runnerId, mutationId))) return {
        state: "failed",
        reason: "cancel"
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
      cause: changed
    };
  }
  try {
    await ports.finalize(runnerId, mutationId, false);
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
export async function rotateRunner(ports: RunnerRotationPorts, runnerId: string, initial: RunnerExecutionSnapshot): Promise<RunnerEnrollmentSuccess | RunnerActionFailure> {
  const mutationId = ports.mutationId();
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
  const current = await ports.snapshot(runnerId).catch(() => ({
    state: "unavailable" as const
  }));
  if (current.state !== "available" || current.snapshot.lifecycleId !== initial.lifecycleId || current.snapshot.configuredMode !== initial.configuredMode) {
    if (!(await releaseUncommittedRunnerFence(ports, runnerId, mutationId))) return {
      state: "failed",
      reason: "recovery"
    };
    return {
      state: "failed",
      reason: "changed",
      cause: current.state === "missing" ? "missing" : "conflict"
    };
  }
  let changed;
  try {
    changed = await ports.rotate(runnerId, mutationId);
  } catch {
    return {
      state: "failed",
      reason: "commit"
    };
  }
  if (changed === "unknown") return {
    state: "failed",
    reason: "commit"
  };
  if (changed !== "accepted") {
    try {
      if (!(await ports.cancel(runnerId, mutationId))) return {
        state: "failed",
        reason: "cancel"
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
      cause: changed
    };
  }
  const enrollment = await ports.enroll(runnerId, current.snapshot).catch(() => ({
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
      cause: enrollment.status === 404 ? "missing" : "conflict"
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
