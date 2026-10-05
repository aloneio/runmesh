import type { EnrollmentCodeResult, RunnerExecutionSnapshot } from "./runner-admin.js";
import type { RunnerLifecyclePorts } from "./runner-mutations.js";
export type RunnerWriteOutcome = "accepted" | "invalid" | "denied" | "missing" | "conflict" | "unknown";
export type RunnerActionFailure = {
  readonly state: "failed";
  readonly reason: "read" | "fence" | "write" | "commit" | "cancel" | "recovery" | "changed" | "enrollment_state" | "enrollment_rejected" | "enrollment" | "enrollment_recovery" | "finalize";
  readonly cause?: Exclude<RunnerWriteOutcome, "accepted">;
};
export type RunnerEnrollmentSuccess = {
  readonly state: "completed";
  readonly enrollment: Extract<EnrollmentCodeResult, {
    ok: true;
  }>;
};
export interface RunnerActionPorts extends RunnerLifecyclePorts {
  mutationId(): string;
  fence(runnerId: string, mutationId: string): Promise<boolean>;
}
export interface RunnerCreationPorts extends RunnerActionPorts {
  canRead(runnerId: string): Promise<boolean>;
  create(runnerId: string, mutationId: string): Promise<RunnerWriteOutcome>;
  enroll(runnerId: string, lifecycleId: string): Promise<EnrollmentCodeResult>;
}
export type RunnerSnapshot = {
  readonly state: "available";
  readonly snapshot: RunnerExecutionSnapshot;
} | {
  readonly state: "missing" | "unavailable";
};
export interface RunnerRotationPorts extends RunnerActionPorts {
  snapshot(runnerId: string): Promise<RunnerSnapshot>;
  rotate(runnerId: string, mutationId: string): Promise<RunnerWriteOutcome>;
  enroll(runnerId: string, snapshot: RunnerExecutionSnapshot): Promise<EnrollmentCodeResult>;
}
export interface RunnerRevocationPorts extends RunnerActionPorts {
  revoke(runnerId: string, mutationId: string): Promise<RunnerWriteOutcome>;
}
export interface RunnerRegistrationPorts extends RunnerActionPorts {
  read(runnerId: string): Promise<"available" | "missing" | "unavailable">;
  write(runnerId: string, mutationId: string): Promise<RunnerWriteOutcome>;
}
export type RunnerRegistrationResult = {
  readonly state: "completed";
} | RunnerActionFailure | {
  readonly state: "failed";
  readonly reason: "mode_required" | "post_commit";
};
export interface RunnerEnrollmentPorts extends Pick<RunnerActionPorts, "mutationId" | "fence" | "cancel"> {
  snapshot(runnerId: string): Promise<RunnerSnapshot>;
  enroll(runnerId: string, snapshot: RunnerExecutionSnapshot): Promise<EnrollmentCodeResult>;
  release(runnerId: string, mutationId: string): Promise<{
    released: boolean;
    diagnostic?: string;
  }>;
}
export type RunnerEnrollmentResult = RunnerEnrollmentSuccess | RunnerActionFailure | {
  readonly state: "failed";
  readonly reason: "cleanup";
  readonly diagnostic?: string;
};
