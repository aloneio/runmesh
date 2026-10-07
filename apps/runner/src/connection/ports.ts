import type { WorkspaceConfig } from "../config.js";
import type { JobMetadata, RunnerPolicy, WorkspaceMetadata } from "../protocol-types.js";
import type { JobEvent, JobRecord } from "../jobs/records.js";

/** The authenticated connection that may recover a cached policy. */
export interface PolicyStoreIdentity {
  readonly server: string;
  readonly runnerId: string;
  readonly token: string;
}

/** These ports describe consumed operations, not concrete service classes. */
export interface ConnectionRuntimePort {
  initialize(): Promise<void>;
  applyPolicy(workspaces: readonly WorkspaceConfig[]): void;
  dispatch(method: string, input: unknown): Promise<unknown>;
  configureJobRetention(days: number): void;
  cleanupJobs(): Promise<void>;
  needsHistoryReconciliation(): boolean;
  syncJobs(limit?: number): Promise<JobMetadata[]>;
  syncWorkspaceMetadata(): WorkspaceMetadata[];
  readonly jobs: {
    activeHistoryJobIds(): string[];
    setQueueAuthorizer?(authorize: ((input: Record<string, unknown>, job: JobRecord) => Promise<boolean>) | undefined): void;
  };
}
export interface ConnectionPolicyStorePort {
  load(runnerId: string, identity?: PolicyStoreIdentity): Promise<RunnerPolicy | undefined>;
  activate(policy: RunnerPolicy, identity?: PolicyStoreIdentity): Promise<void>;
}
/** @internal Runtime construction receives the same event sink as native composition. */
export type ConnectionRuntimeFactory = (onJobEvent: (event: JobEvent) => void) => ConnectionRuntimePort;
/** @internal The session owner alone opens/closes sockets and installs their handlers. */
export type ConnectionTransportFactory = (url: URL, options: {
  readonly headers: { readonly Authorization: string };
  readonly maxPayload: number;
  readonly perMessageDeflate: false;
}) => import("ws").default;
