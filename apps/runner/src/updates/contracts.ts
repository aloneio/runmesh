import type { NativeServiceMaintenancePort, NativeServiceSnapshot } from "./native-service.js";
import { exactRunnerRelease, RunnerUpdateErrorCodeSchema } from "@aloneio/runmesh-protocol";
import type { RunnerUpdateOperation, RunnerUpdateResponse, RunnerUpdateState, RunnerUpdateErrorCode, RunnerUpdateClaim } from "@aloneio/runmesh-protocol";

export function isExactUpdateVersion(version: string): boolean { try { exactRunnerRelease(version); return true; } catch { return false; } }
export const UPDATE_IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/u;
export const UPDATE_ERRORS = RunnerUpdateErrorCodeSchema.options;
export type UpdateErrorCode = RunnerUpdateErrorCode;
export type CloudUpdateState = RunnerUpdateState;
export type CloudUpdateOperation = RunnerUpdateOperation;
export type CloudUpdateObservation = RunnerUpdateResponse;
export type UpdateOwner = RunnerUpdateClaim;
export interface CloudMaintenancePort {
  poll(): Promise<CloudUpdateObservation>;
  claim(owner: UpdateOwner): Promise<CloudUpdateObservation>;
  proveStopped(owner: UpdateOwner): Promise<CloudUpdateObservation>;
  report(owner: UpdateOwner, state: Exclude<CloudUpdateState, "queued">, details?: { readonly error_code?: UpdateErrorCode; readonly observed_version?: string }): Promise<CloudUpdateObservation>;
}
export interface ReleaseTarget {
  readonly version: string;
  readonly channel: "dev" | "stable";
  readonly manifest_sha256?: string;
  readonly artifact_sha256?: string;
}
export interface InstalledRelease { readonly version: string; readonly directory: string; }
export interface VerifiedStagedRelease {
  readonly version: string;
  readonly versionDirectory: string;
  readonly artifactSha256: string;
  readonly manifestSha256: string;
}
export interface InstallationPointerPort {
  inspect(): Promise<InstalledRelease>;
  assertRecoverable(previous: InstalledRelease, next: InstalledRelease | undefined, operationId: string): Promise<void>;
  switch(previous: InstalledRelease, next: InstalledRelease, operationId: string): Promise<void>;
  restore(previous: InstalledRelease, next: InstalledRelease | undefined, operationId: string): Promise<void>;
}
export type LocalUpdatePhase = "claimed" | "staged" | "draining" | "stopping" | "switching" | "starting" | "checking" | "rolling_back" | "succeeded" | "rolled_back" | "failed" | "recovery_required";
export interface UpdateJournal {
  readonly schema_version: 1;
  readonly operation: CloudUpdateOperation;
  readonly manager_id: string;
  readonly recovery_identity?: string;
  readonly previous: InstalledRelease;
  readonly service: NativeServiceSnapshot;
  readonly next?: InstalledRelease;
  readonly phase: LocalUpdatePhase;
  readonly error_code?: UpdateErrorCode;
}
export interface UpdateJournalPort {
  load(): Promise<UpdateJournal | undefined>;
  save(journal: UpdateJournal): Promise<void>;
  complete(journal: UpdateJournal): Promise<void>;
}
export interface LocalJobDrainObservation { readonly idle: boolean; readonly active: number; }
export interface UpdateCoordinatorOptions {
  readonly managerId: string;
  readonly recoveryIdentity: () => Promise<string>;
  readonly cloud: CloudMaintenancePort;
  readonly journal: UpdateJournalPort;
  readonly installation: InstallationPointerPort;
  readonly service: NativeServiceMaintenancePort;
  readonly stage: (target: ReleaseTarget, operationId: string) => Promise<VerifiedStagedRelease>;
  readonly jobs: () => Promise<LocalJobDrainObservation>;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly drainTimeoutMs?: number;
  readonly activationTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly assertInstallationLock?: () => void;
}

/** Deliberately carries no native message, URL, path or credentials. */
export class UpdateFailure extends Error {
  public constructor(public readonly code: UpdateErrorCode) { super(code); this.name = "UpdateFailure"; }
}
