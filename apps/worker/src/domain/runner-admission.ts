import { validLifecycleId } from "./runner-handshake.js";

/** Session identity only; sockets and attachment capabilities belong to the transport. */
export interface RunnerConnectionIdentity {
  readonly runnerId: string;
  readonly sessionId: string;
  readonly epoch: number;
  readonly credentialVersion: number;
  readonly lifecycleId: string;
}

export type MutationPhase = "idle" | "precommit" | "committed_pending" | "offline_pending" | "invalid" | "restart_reconcile";

export interface AdmissionState {
  readonly fenced: boolean;
  readonly reconciled: boolean;
  readonly runnerId: string | null;
  readonly activeRevision: number | null;
  readonly activeChecksum: string | null;
  readonly desiredRevision: number | null;
  readonly desiredChecksum: string | null;
  readonly connectionEpoch: number | null;
  readonly credentialVersion: number | null;
  /** Opaque Registry identity for the runner_id lifecycle. */
  readonly lifecycleId: string | null;
  readonly sessionId: string | null;
  readonly mutationId: string | null;
  readonly mutationPhase: MutationPhase;
  readonly preMutationActiveRevision: number | null;
  readonly preMutationActiveChecksum: string | null;
  readonly preMutationDesiredRevision: number | null;
  readonly preMutationDesiredChecksum: string | null;
  readonly lastReconciledAtMs: number | null;
}
export const RESTART_RECONCILE_MUTATION_ID = "restart-reconcile";
export const FENCED_ADMISSION: AdmissionState = {
  fenced: true, reconciled: false, runnerId: null, activeRevision: null, activeChecksum: null,
  desiredRevision: null, desiredChecksum: null, connectionEpoch: null, credentialVersion: null, lifecycleId: null,
  sessionId: null, mutationId: null, mutationPhase: "restart_reconcile", preMutationActiveRevision: null, preMutationActiveChecksum: null, preMutationDesiredRevision: null, preMutationDesiredChecksum: null, lastReconciledAtMs: null,
};

/** Conservative in-memory state after an uncertain admission-state write. */
export function conservativeAdmission(next: AdmissionState): AdmissionState {
  return {
    ...next,
    fenced: true,
    reconciled: false,
    activeRevision: null,
    activeChecksum: null,
    lastReconciledAtMs: null,
    // Preserve an in-flight mutation owner when present so recovery/cancel
    // cannot be raced by a second mutation. An ordinary policy state gets the
    // restart marker and must be reconciled from Registry before admission.
    mutationId: next.mutationId ?? RESTART_RECONCILE_MUTATION_ID,
    mutationPhase: next.mutationId === null ? "restart_reconcile" : next.mutationPhase,
  };
}

/** Restart invalidates permission admission while preserving an unresolved mutation owner. */
export function restoreAdmission(stored: unknown): { readonly state: AdmissionState; readonly changed: boolean } {
  const validStored = validAdmissionState(stored);
  const ownedMutation = validStored && stored.fenced && stored.mutationId !== null
    && stored.mutationId !== RESTART_RECONCILE_MUTATION_ID;
  const state = ownedMutation ? conservativeAdmission(stored)
    : validStored
      ? { ...stored, fenced: true, reconciled: false, activeRevision: null, activeChecksum: null, mutationId: RESTART_RECONCILE_MUTATION_ID, mutationPhase: "restart_reconcile" as const, preMutationActiveRevision: null, preMutationActiveChecksum: null, preMutationDesiredRevision: null, preMutationDesiredChecksum: null, lastReconciledAtMs: null }
      : { ...FENCED_ADMISSION };
  return { state, changed: !validStored || !sameAdmissionState(stored, state) };
}

export function admitsProtectedRpc(state: AdmissionState, attachment: RunnerConnectionIdentity, revision: number, checksum: string): boolean {
  return !state.fenced && state.reconciled
    && state.runnerId === attachment.runnerId
    && (state.lifecycleId ?? null) === (attachment.lifecycleId ?? null)
    && state.connectionEpoch === attachment.epoch
    && state.credentialVersion === attachment.credentialVersion
    && state.sessionId === attachment.sessionId
    && state.activeRevision === revision && state.activeChecksum === checksum
    && state.desiredRevision === revision && state.desiredChecksum === checksum;
}

export function sameRunnerConnection(state: AdmissionState, attachment: RunnerConnectionIdentity): boolean {
  return state.runnerId === attachment.runnerId && state.lifecycleId === attachment.lifecycleId
    && state.connectionEpoch === attachment.epoch && state.credentialVersion === attachment.credentialVersion && state.sessionId === attachment.sessionId;
}

export function sameAdmissionState(left: AdmissionState, right: AdmissionState): boolean {
  return left.fenced === right.fenced && left.reconciled === right.reconciled && left.runnerId === right.runnerId
    && left.activeRevision === right.activeRevision && left.activeChecksum === right.activeChecksum
    && left.desiredRevision === right.desiredRevision && left.desiredChecksum === right.desiredChecksum
    && left.connectionEpoch === right.connectionEpoch && left.credentialVersion === right.credentialVersion
    && left.lifecycleId === right.lifecycleId
    && left.sessionId === right.sessionId && left.mutationId === right.mutationId && left.mutationPhase === right.mutationPhase && left.preMutationActiveRevision === right.preMutationActiveRevision && left.preMutationActiveChecksum === right.preMutationActiveChecksum && left.preMutationDesiredRevision === right.preMutationDesiredRevision && left.preMutationDesiredChecksum === right.preMutationDesiredChecksum && left.lastReconciledAtMs === right.lastReconciledAtMs;
}

export function validAdmissionState(value: unknown): value is AdmissionState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return typeof state.fenced === "boolean" && typeof state.reconciled === "boolean"
    && (state.runnerId === null || typeof state.runnerId === "string")
    && (state.activeRevision === null || Number.isSafeInteger(state.activeRevision))
    && (state.activeChecksum === null || typeof state.activeChecksum === "string")
    && (state.desiredRevision === null || Number.isSafeInteger(state.desiredRevision))
    && (state.desiredChecksum === null || typeof state.desiredChecksum === "string")
    && (state.connectionEpoch === null || Number.isSafeInteger(state.connectionEpoch))
    && (state.credentialVersion === null || Number.isSafeInteger(state.credentialVersion))
    && (state.lifecycleId === null || validLifecycleId(state.lifecycleId))
    && (state.sessionId === null || validSessionId(state.sessionId))
    && (state.mutationId === null || typeof state.mutationId === "string")
    && (state.mutationPhase === "idle" || state.mutationPhase === "precommit" || state.mutationPhase === "committed_pending" || state.mutationPhase === "offline_pending" || state.mutationPhase === "invalid" || state.mutationPhase === "restart_reconcile")
    && (state.preMutationActiveRevision === null || Number.isSafeInteger(state.preMutationActiveRevision))
    && (state.preMutationActiveChecksum === null || typeof state.preMutationActiveChecksum === "string")
    && (state.preMutationDesiredRevision === null || Number.isSafeInteger(state.preMutationDesiredRevision))
    && (state.preMutationDesiredChecksum === null || typeof state.preMutationDesiredChecksum === "string")
    && (state.lastReconciledAtMs === null || Number.isSafeInteger(state.lastReconciledAtMs));
}
export function validSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}
