import type { RunnerExecutionSnapshot } from "../contracts/runner-admin.js";
import type { RunnerEnrollmentPorts, RunnerEnrollmentResult } from "../contracts/runner-administration.js";
import { releaseUncommittedRunnerFence } from "./runner-lifecycle.js";

/** Regenerating a one-time code fences capabilities without rotating credentials. */
export async function regenerateRunnerEnrollment(ports: RunnerEnrollmentPorts, runnerId: string, initial: RunnerExecutionSnapshot): Promise<RunnerEnrollmentResult> {
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
    if (!(await releaseUncommittedRunnerFence(ports, runnerId, mutationId))) return {
      state: "failed",
      reason: "enrollment_recovery"
    };
    return {
      state: "failed",
      reason: "enrollment_rejected",
      cause: enrollment.status === 404 ? "missing" : "conflict"
    };
  }
  const released = await ports.release(runnerId, mutationId).catch(() => ({
    released: false
  }));
  if (!released.released) return {
    state: "failed",
    reason: "cleanup",
    ...("diagnostic" in released ? {
      diagnostic: released.diagnostic
    } : {})
  };
  return {
    state: "completed",
    enrollment
  };
}
