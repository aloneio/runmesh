import { expect, it } from "vitest";
import {
  type AdmissionState, type RunnerConnectionIdentity, FENCED_ADMISSION,
  RESTART_RECONCILE_MUTATION_ID, admitsProtectedRpc, conservativeAdmission,
  restoreAdmission, sameAdmissionState, sameRunnerConnection, validAdmissionState,
} from "../../apps/worker/src/domain/runner-admission.js";

const identity: RunnerConnectionIdentity = Object.freeze({ runnerId: "runner-1", lifecycleId: "lifecycle-123456789", sessionId: "session-1", epoch: 7, credentialVersion: 2 });
const checksum = "a".repeat(64);
const ready: AdmissionState = Object.freeze({
  ...FENCED_ADMISSION, fenced: false, reconciled: true, runnerId: identity.runnerId,
  lifecycleId: identity.lifecycleId, sessionId: identity.sessionId, connectionEpoch: identity.epoch,
  credentialVersion: identity.credentialVersion, activeRevision: 3, activeChecksum: checksum,
  desiredRevision: 3, desiredChecksum: checksum, mutationPhase: "idle", lastReconciledAtMs: 100,
});

it("reopens protected RPC only for the reconciled session and exact active and desired policy", () => {
  expect(admitsProtectedRpc(ready, identity, 3, checksum)).toBe(true);
  expect(admitsProtectedRpc(ready, identity, 4, checksum)).toBe(false);
  expect(admitsProtectedRpc(ready, identity, 3, "b".repeat(64))).toBe(false);
});

it.each<Partial<AdmissionState>>([
  { fenced: true }, { reconciled: false }, { runnerId: "runner-2" }, { lifecycleId: "lifecycle-987654321" },
  { sessionId: "session-2" }, { connectionEpoch: 8 }, { credentialVersion: 3 }, { activeRevision: 4 },
  { activeChecksum: "b".repeat(64) }, { desiredRevision: 4 }, { desiredChecksum: "b".repeat(64) },
])("denies stale session or policy admission %#", change => {
  expect(admitsProtectedRpc({ ...ready, ...change }, identity, 3, checksum)).toBe(false);
});

it.each<Partial<RunnerConnectionIdentity>>([
  { runnerId: "runner-2" }, { lifecycleId: "lifecycle-987654321" }, { sessionId: "session-2" }, { epoch: 8 }, { credentialVersion: 3 },
])("separates every transport identity component %#", change => {
  expect(sameRunnerConnection(ready, identity)).toBe(true);
  expect(sameRunnerConnection(ready, { ...identity, ...change })).toBe(false);
});

it("requires reconciliation after restart and does not repeat an unchanged durable write", () => {
  const first = restoreAdmission(ready);
  expect(first.changed).toBe(true);
  expect(first.state).toMatchObject({ fenced: true, reconciled: false, activeRevision: null, activeChecksum: null,
    mutationId: RESTART_RECONCILE_MUTATION_ID, mutationPhase: "restart_reconcile", lastReconciledAtMs: null });
  expect(admitsProtectedRpc(first.state, identity, 3, checksum)).toBe(false);
  expect(restoreAdmission(first.state)).toEqual({ state: first.state, changed: false });
  expect(ready.reconciled).toBe(true);
});

it.each(["precommit", "committed_pending", "offline_pending", "invalid"] as const)("preserves unresolved %s ownership through storage failure and restart", mutationPhase => {
  const before: AdmissionState = Object.freeze({ ...ready, fenced: true, mutationId: "mutation-1", mutationPhase,
    preMutationActiveRevision: 2, preMutationActiveChecksum: "b".repeat(64), preMutationDesiredRevision: 3, preMutationDesiredChecksum: checksum });
  const failed = conservativeAdmission(before);
  const restarted = restoreAdmission(before);
  expect(restarted).toEqual({ state: failed, changed: true });
  expect(restarted.state).toMatchObject({ mutationId: "mutation-1", mutationPhase,
    preMutationActiveRevision: 2, preMutationActiveChecksum: "b".repeat(64), preMutationDesiredRevision: 3, preMutationDesiredChecksum: checksum });
  expect(restoreAdmission(failed).changed).toBe(false);
  expect(admitsProtectedRpc(failed, identity, 3, checksum)).toBe(false);
});

it.each([undefined, null, [], {}, "bad", { ...ready, mutationPhase: "unknown" }, { ...ready, connectionEpoch: 0.5 },
  { ...ready, sessionId: "invalid session" }, { ...ready, lifecycleId: "short" }, { ...ready, lastReconciledAtMs: Infinity }])
  ("restores malformed state to a fresh fence %#", stored => {
    expect(validAdmissionState(stored)).toBe(false);
    expect(restoreAdmission(stored)).toEqual({ state: FENCED_ADMISSION, changed: true });
  });

it("compares every admission field so a stale writer cannot overwrite changed ownership", () => {
  expect(validAdmissionState(ready)).toBe(true);
  expect(sameAdmissionState(ready, { ...ready })).toBe(true);
  const changes: { [Key in keyof AdmissionState]-?: AdmissionState[Key] } = {
    fenced: true, reconciled: false, runnerId: "other", activeRevision: 4, activeChecksum: "b".repeat(64),
    desiredRevision: 4, desiredChecksum: "b".repeat(64), connectionEpoch: 8, credentialVersion: 3,
    lifecycleId: "lifecycle-987654321", sessionId: "session-2", mutationId: "mutation-2", mutationPhase: "precommit",
    preMutationActiveRevision: 2, preMutationActiveChecksum: checksum, preMutationDesiredRevision: 3,
    preMutationDesiredChecksum: checksum, lastReconciledAtMs: 101,
  };
  for (const [key, value] of Object.entries(changes)) expect(sameAdmissionState(ready, { ...ready, [key]: value }), key).toBe(false);
});
