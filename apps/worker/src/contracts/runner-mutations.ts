/** Internal mutation evidence. The Registry and transport retain their own authority. */
export interface RunnerMutationObservation {
  readonly mutation_committed?: unknown;
  readonly runner_exists?: unknown;
  readonly policy_status?: unknown;
  readonly desired_revision?: unknown;
  readonly desired_checksum?: unknown;
  readonly lifecycle_id?: unknown;
}
export interface RunnerLifecyclePorts {
  observe(runnerId: string, mutationId: string): Promise<RunnerMutationObservation | undefined>;
  cancel(runnerId: string, mutationId: string): Promise<boolean>;
  finalize(runnerId: string, mutationId: string, allowLifecycleChange: boolean): Promise<void>;
}
export type RunnerWriteResult<T> = {
  readonly state: "accepted";
  readonly value: T;
} | {
  readonly state: "rejected";
  readonly value: T;
} | {
  readonly state: "unknown";
};
export interface RunnerPolicyPorts<T> extends Pick<RunnerLifecyclePorts, "observe" | "cancel"> {
  mutationId(): string;
  fence(runnerId: string, mutationId: string): Promise<{
    readonly ok: true;
  } | {
    readonly ok: false;
    readonly value: T;
  }>;
  change(mutationId: string): Promise<RunnerWriteResult<T>>;
  mark(runnerId: string, mutationId: string, phase: "committed_pending" | "offline_pending", revision: number, checksum: string): Promise<boolean>;
  push(runnerId: string, mutationId: string): Promise<{
    readonly state: "pending";
  } | {
    readonly state: "rejected";
    readonly value: T;
  }>;
}
export type RunnerPolicyResult<T> = {
  readonly state: "accepted";
  readonly value: T;
} | {
  readonly state: "rejected";
  readonly value: T;
} | {
  readonly state: "failed";
  readonly reason: "fence" | "write" | "commit" | "cancel" | "recovery" | "evidence";
};
