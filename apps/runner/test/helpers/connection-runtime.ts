import type { ConnectionPolicyStorePort, ConnectionRuntimePort } from "../../src/connection/ports.js";

/** Complete structural fixtures: tests override operations, never private owners. */
export function connectionRuntime(overrides: Partial<ConnectionRuntimePort> = {}): ConnectionRuntimePort {
  return {
    initialize: async () => {}, applyPolicy: () => {}, dispatch: async () => undefined,
    configureJobRetention: () => {}, cleanupJobs: async () => {}, needsHistoryReconciliation: () => false,
    syncJobs: async () => [], syncWorkspaceMetadata: () => [], jobs: { list: () => [] },
    ...overrides,
  };
}

export function connectionPolicyStore(overrides: Partial<ConnectionPolicyStorePort> = {}): ConnectionPolicyStorePort {
  return { load: async () => undefined, activate: async () => {}, ...overrides };
}
