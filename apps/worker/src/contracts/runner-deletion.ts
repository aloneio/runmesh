/** Internal use-case ports, not public capabilities or an authorization cache. */
export interface RunnerDeletionPorts {
  mutationId(): string;
  fence(runnerId: string, mutationId: string): Promise<{ readonly ok: boolean }>;
  remove(runnerId: string, mutationId: string): Promise<{ readonly ok: boolean; readonly status: number }>;
  observe(runnerId: string, mutationId: string): Promise<{ readonly runner_exists?: unknown; readonly mutation_committed?: unknown } | undefined>;
  cancel(runnerId: string, mutationId: string): Promise<{ readonly ok: boolean }>;
  finalize(runnerId: string, mutationId: string): Promise<void>;
}
export type RunnerDeletionResult =
  | { readonly state: "deleted" }
  | { readonly state: "rejected"; readonly reason: "confirmation" | "registry"; readonly status: number }
  | { readonly state: "unavailable"; readonly reason: "fence" }
  | { readonly state: "unknown"; readonly reason: "commit" | "recovery" | "cancel" | "finalize" | "finalize_recovered" };
