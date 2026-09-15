import type { McpClientActiveRunner } from "../contracts/runner-selection.js";
import type { ValidityStatus } from "../validity.js";
import type { RunnerRecord, RegistryFeatureKey, McpClientRecord, VerifiedMcpClient, RunnerRow } from './records.js';

/** Narrow synchronous collaboration ports. No concrete DO/service imports. */
export interface AuthPorts {
  disableFeatureHealth(feature: RegistryFeatureKey, error: unknown, nowMs?: number, cooldownMs?: number): void;
  featureHealthDisabled(feature: RegistryFeatureKey, nowMs?: number): boolean;
  listRunners(): RunnerRecord[];
  runnerRow(runnerId: string): RunnerRow | undefined;
}

export interface PolicyPorts {
  getJob(runnerId: string, jobId: string): unknown | undefined;
  getMcpClient(clientId: string): McpClientRecord | undefined;
  getMcpClientActiveRunner(clientId: string): McpClientActiveRunner | undefined;
  getRunner(runnerId: string): RunnerRecord | undefined;
  revalidateMcpClient(clientId: unknown, secretVersion: unknown, includeJobRecording?: boolean): VerifiedMcpClient | undefined;
  runnerAccess(runnerId: string, nowMs?: number): { allowed: boolean; status: ValidityStatus | "missing" };
  runnerRow(runnerId: string): RunnerRow | undefined;
  sessionIsCurrent(runnerId: string, epoch: number, credentialVersion: number, requireOnline: boolean, lifecycleId: string, sessionId: string): boolean;
}

export interface LifecyclePorts {
  createPolicySnapshot(runnerId: string, revision: number, nowMs: number, sourceRevision: number | null, mutationId: string): void;
}

export interface HistoryPorts {
  clearFeatureHealth(feature: RegistryFeatureKey): void;
  disableFeatureHealth(feature: RegistryFeatureKey, error: unknown, nowMs?: number, cooldownMs?: number): void;
  featureHealthDisabled(feature: RegistryFeatureKey, nowMs?: number): boolean;
  getMcpClient(clientId: string): McpClientRecord | undefined;
  listRunners(): RunnerRecord[];
  recordsJobActivity(clientId: string): boolean;
  runnerMatchesTransportFence(current: RunnerRow | undefined, epoch: number, credentialVersion: number, requireOnline: boolean, lifecycleId: string, sessionId: string): current is RunnerRow;
  runnerRow(runnerId: string): RunnerRow | undefined;
  scheduleMaintenanceAlarm(nowMs: number): Promise<void>;
  syncSequenceCanAdvance(current: RunnerRow, syncSequence: number): boolean;
  waitUntil(promise: Promise<unknown>): void;
}
