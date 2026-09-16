import type WebSocket from "ws";
import type { RunnerSync } from "@aloneio/runmesh-protocol";
import type { WorkspaceConfig } from "../config.js";
import type { RunnerPolicy } from "../protocol-types.js";
import type { JobRecord } from "../jobs/records.js";

/** These ports describe consumed operations, not concrete service classes. */
export interface ConnectionRuntimePort {
  initialize(): Promise<void>;
  applyPolicy(workspaces: readonly WorkspaceConfig[]): void;
  dispatch(method: string, input: unknown): Promise<unknown>;
  configureJobRetention(days: number): void;
  cleanupJobs(): Promise<void>;
  needsHistoryReconciliation(): boolean;
  syncJobs(limit?: number): Promise<RunnerSync["jobs"]>;
  syncWorkspaceMetadata(): RunnerSync["workspaces"];
  readonly jobs: {
    list(): JobRecord[];
    setQueueAuthorizer?(authorize: ((input: Record<string, unknown>, job: JobRecord) => Promise<boolean>) | undefined): void;
  };
}
export interface ConnectionPolicyStorePort {
  load(runnerId: string): Promise<RunnerPolicy | undefined>;
  activate(policy: RunnerPolicy): Promise<void>;
}
/** The session owner alone opens/closes sockets and installs their handlers. */
export type ConnectionTransportFactory = (url: URL, options: { readonly headers: { readonly Authorization: string } }) => WebSocket;
