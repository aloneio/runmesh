import type { RunnerConnectionState } from "../contracts/runner-selection.js";
import type { RunnerMetadata } from "@aloneio/runmesh-protocol";
import { constantTimeEqual } from "../security.js";
import { isConfiguredSecret } from "../security.js";
import { isSafeIdentifier } from "../security.js";
import { runnerTokenVerifier } from "../security.js";
import { validTimestamp } from "../validity.js";
import { validWindow } from "../validity.js";
import { validityStatus } from "../validity.js";
import type { ValidityWindow } from "../validity.js";
import type { ValidityStatus } from "../validity.js";
import type { RunnerExecutionMode, RunnerMutationState, RunnerUpdateChannel, RunnerPublicInfo, RunnerRecord, RunnerRow, EnrollmentRow, CredentialMutationKind, CredentialMutationRow } from './records.js';
import { READ_ONLY_PERMISSIONS, DEFAULT_RUNNER_ENROLLMENT_TTL_MS } from './records.js';
import { validRunnerVersion, validLifecycleId, validSessionId, validTransportIdentity, matchesTransportIdentity, validUpdateChannel, validExecutionMode, validOptionalExecutionMode, validExpectedExecutionMode, validRunnerEnrollmentTtl, protocolCompatibility, updateStatus, emptyMutationState, decodeRunner, safeNonnegativeInteger, validVerifier, validMutationId, validOptionalMutationId, validLabel, validRunnerPublicInfo, expectedRegistryConflict } from './values.js';
import type { RegistryStorage } from './storage.js';
import type { LifecyclePorts } from './ports.js';

/** Lifecycle operations over a single Registry database. Construction has no I/O.
 * SQL text, arguments, transaction callbacks and await positions are retained. */
export class RegistryLifecycle {
  public constructor(private readonly storage: RegistryStorage, private readonly ports: LifecyclePorts, private readonly runnerTokenPepper: string | undefined) {}
  public getRunnerMutationState(runnerId: string, mutationId: string): RunnerMutationState {
    if (!isSafeIdentifier(runnerId) || !validMutationId(mutationId)) return emptyMutationState();
    const runner = this.runnerRow(runnerId);
    if (runner === undefined) {
      // A tombstone is retained for runner_delete so a lost delete response
      // can be recovered. Credential rotate/revoke markers must not look
      // committed once the Runner row is gone.
      const deleted = this.mutationRow(runnerId, mutationId);
      return { ...emptyMutationState(), mutation_committed: deleted?.kind === "runner_delete" };
    }
    // Only the current desired revision is considered committed here. A
    // historical policy mutation may remain in the idempotency ledger after a
    // newer desired revision supersedes it; exposing it as the current
    // mutation would let delayed ACK/recovery traffic claim stale ownership.
    const policyCommitted = runner.desired_policy_revision > 0 && this.storage.sql.exec<{ committed: number }>(
      "SELECT 1 AS committed FROM runner_policy_versions WHERE runner_id = ? AND revision = ? AND mutation_id = ? LIMIT 1", runnerId, runner.desired_policy_revision, mutationId,
    ).toArray()[0] !== undefined;
    const credentialMutation = this.mutationRow(runnerId, mutationId);
    const credentialCommitted = credentialMutation !== undefined
      && validLifecycleId(runner.lifecycle_id)
      && validLifecycleId(credentialMutation.lifecycle_id)
      && credentialMutation.lifecycle_id === runner.lifecycle_id
      && credentialMutation.kind !== "runner_delete"
      // A runner_create marker is committed at its synthetic pre-version (0)
      // only while the newly-created row is still awaiting enrollment. Once
      // an enrollment/rotation advances the credential generation, an old
      // create finalizer must no longer be able to claim the mutation or clear
      // the replacement transport fence.
      && (credentialMutation.kind === "runner_create"
        ? runner.credential_version === credentialMutation.pre_credential_version
        : runner.credential_version === credentialMutation.pre_credential_version + 1);
    return {
      runner_exists: true,
      lifecycle_id: validLifecycleId(runner.lifecycle_id) ? runner.lifecycle_id : null,
      runner_state: runner.state,
      credential_mutation_committed: credentialCommitted,
      mutation_committed: policyCommitted || credentialCommitted,
      desired_revision: runner.desired_policy_revision,
      desired_checksum: runner.desired_policy_checksum,
      applied_revision: runner.applied_policy_revision,
      active_checksum: runner.active_policy_checksum,
      runner_reported_revision: runner.runner_reported_policy_revision,
      runner_reported_checksum: runner.runner_reported_policy_checksum,
      policy_status: runner.policy_status,
      connection_epoch: runner.connection_epoch,
      credential_version: runner.credential_version,
      session_id: runner.session_id,
    };
  }

  public setRunnerVersionPolicy(runnerId: string, input: { update_channel: RunnerUpdateChannel; desired_runner_version?: string; latest_runner_version?: string }, nowMs: number): RunnerRecord | undefined {
    if (!isSafeIdentifier(runnerId) || this.runnerRow(runnerId) === undefined || !validUpdateChannel(input.update_channel) || (input.desired_runner_version !== undefined && !validRunnerVersion(input.desired_runner_version)) || (input.latest_runner_version !== undefined && !validRunnerVersion(input.latest_runner_version)) || (input.update_channel === "pinned" && input.desired_runner_version === undefined)) return undefined;
    this.storage.sql.exec(
      "UPDATE runners SET update_channel = ?, desired_runner_version = ?, latest_runner_version = ?, update_status = ?, updated_at_ms = ? WHERE runner_id = ?",
      input.update_channel, input.desired_runner_version ?? null, input.latest_runner_version ?? null,
      updateStatus(input.update_channel, input.desired_runner_version, input.latest_runner_version, this.runnerRow(runnerId)), nowMs, runnerId,
    );
    return this.getRunner(runnerId);
  }

  public registerRunner(runnerId: string, tokenVerifier: string, nowMs: number, mutationId?: string, configuredExecutionMode?: RunnerExecutionMode): boolean {
    // Credential replacement is retried after a lost Worker/Registry
    // response. Keep the marker and the credential update in one transaction;
    // a replay of the same mutation must not advance the generation again.
    return this.storage.transactionSync(() => {
      const existing = this.runnerRow(runnerId);
      if (configuredExecutionMode !== undefined && !validExecutionMode(configuredExecutionMode)) return false;
      if (existing !== undefined && configuredExecutionMode !== undefined && existing.configured_execution_mode !== configuredExecutionMode) return false;
      if (mutationId !== undefined) {
        if (!validMutationId(mutationId)) return false;
        if (existing !== undefined) {
          const recorded = this.recordCredentialMutation(runnerId, mutationId, "credential_rotate", nowMs);
          if (recorded === "conflict") return false;
          if (recorded === "committed") {
            // Idempotency is tied to the original token payload.  Returning
            // success for the same mutation with a different verifier would
            // make the Worker hand out a token that Registry never stored.
            const current = this.runnerRow(runnerId);
            return current !== undefined && constantTimeEqual(current.token_verifier, tokenVerifier);
          }
        } else {
          // A registration mutation may create a row after the Worker has
          // fenced a stale RunnerDO whose Registry row was already deleted.
          // Record a lifecycle-bound marker in the same transaction as the
          // insert.  The synthetic pre-version (0) makes the marker
          // immediately committed for the initial credential version (1), so
          // a retry with the same mutation cannot rotate the newly-created
          // credential a second time.  A tombstone with the same mutation ID
          // is rejected rather than being allowed to cross a delete/recreate
          // lifecycle boundary.
          if (this.mutationRow(runnerId, mutationId) !== undefined) return false;
          const lifecycleId = crypto.randomUUID();
          if (configuredExecutionMode === undefined) return false;
          this.storage.sql.exec(
            `INSERT INTO runners (runner_id, display_name, token_verifier, state, credential_version, lifecycle_id, configured_execution_mode, updated_at_ms)
             VALUES (?, ?, ?, 'offline', 1, ?, ?, ?)`, runnerId, runnerId, tokenVerifier, lifecycleId, configuredExecutionMode, nowMs,
          );
          this.storage.sql.exec(
            "INSERT INTO runner_mutations (runner_id, mutation_id, kind, pre_credential_version, lifecycle_id, committed_at_ms) VALUES (?, ?, 'credential_rotate', 0, ?, ?)",
            runnerId, mutationId, lifecycleId, nowMs,
          );
          this.storage.sql.exec("DELETE FROM runner_enrollments WHERE runner_id = ? AND used_at_ms IS NULL", runnerId);
          this.ports.createPolicySnapshot(runnerId, 1, nowMs, null, "runner-registered");
          return true;
        }
      }
      if (existing === undefined && configuredExecutionMode === undefined) return false;
      this.storage.sql.exec(
        `INSERT INTO runners (runner_id, display_name, token_verifier, state, credential_version, lifecycle_id, configured_execution_mode, updated_at_ms)
         VALUES (?, ?, ?, 'offline', 1, ?, ?, ?)
         ON CONFLICT(runner_id) DO UPDATE SET token_verifier = excluded.token_verifier,
           display_name = CASE WHEN runners.display_name = '' THEN excluded.display_name ELSE runners.display_name END,
           credential_version = runners.credential_version + 1, connection_epoch = runners.connection_epoch + 1,
           state = 'offline', session_id = NULL, metadata_json = NULL,
           last_heartbeat_ms = NULL, last_sync_sequence = NULL,
           policy_status = CASE WHEN desired_policy_revision = 0 THEN 'applied' ELSE 'pending' END, updated_at_ms = excluded.updated_at_ms`, runnerId, runnerId, tokenVerifier, crypto.randomUUID(), configuredExecutionMode ?? existing?.configured_execution_mode ?? null, nowMs,
       );
       if (existing === undefined) this.ports.createPolicySnapshot(runnerId, 1, nowMs, null, "runner-registered");
       // Pending enrollment codes are credential-replacement capabilities;
       // invalidate them whenever an API registration/rotation wins.
       this.storage.sql.exec("DELETE FROM runner_enrollments WHERE runner_id = ? AND used_at_ms IS NULL", runnerId);
      return true;
    });
  }

  public addRunner(runnerId: string, displayName: string, nowMs: number, mutationId?: string, configuredExecutionMode?: RunnerExecutionMode, confirmPrivilegedHost = false, validity: ValidityWindow = { valid_from_ms: null, valid_until_ms: null }): RunnerRecord | undefined {
    if (!isSafeIdentifier(runnerId) || !validLabel(displayName) || !validOptionalMutationId(mutationId) || configuredExecutionMode === undefined || !validExecutionMode(configuredExecutionMode) || (configuredExecutionMode === "privileged_host" && !confirmPrivilegedHost) || !validWindow(validity)) return undefined;
    try {
      this.storage.transactionSync(() => {
        const existing = this.runnerRow(runnerId);
        if (existing !== undefined) {
          // A lost /add response may be retried with the same mutation.  Only
          // replay the exact creation marker for the same lifecycle and label;
          // never turn an arbitrary existing row into an idempotent success.
          if (mutationId === undefined) throw new Error("runner already exists");
          const marker = this.mutationRow(runnerId, mutationId);
          if (marker === undefined || marker.kind !== "runner_create" || !validLifecycleId(existing.lifecycle_id) || marker.lifecycle_id !== existing.lifecycle_id || existing.display_name !== displayName || existing.credential_version !== marker.pre_credential_version
            || (configuredExecutionMode !== undefined && existing.configured_execution_mode !== configuredExecutionMode)) throw new Error("runner creation conflict");
          return;
        }
        if (mutationId !== undefined && this.mutationRow(runnerId, mutationId) !== undefined) throw new Error("runner creation tombstone conflict");
        const lifecycleId = crypto.randomUUID();
        this.storage.sql.exec(
          `INSERT INTO runners (runner_id, display_name, token_verifier, state, configured_execution_mode, valid_from_ms, valid_until_ms, credential_version, lifecycle_id, desired_policy_revision, desired_policy_checksum, policy_status, runner_permissions_json, updated_at_ms)
           VALUES (?, ?, '', 'offline', ?, ?, ?, 0, ?, 0, NULL, 'pending', ?, ?)`, runnerId, displayName, configuredExecutionMode, validity.valid_from_ms, validity.valid_until_ms, lifecycleId, JSON.stringify(READ_ONLY_PERMISSIONS), nowMs,
        );
        if (mutationId !== undefined) this.storage.sql.exec(
          "INSERT INTO runner_mutations (runner_id, mutation_id, kind, pre_credential_version, lifecycle_id, committed_at_ms) VALUES (?, ?, 'runner_create', 0, ?, ?)",
          runnerId, mutationId, lifecycleId, nowMs,
        );
        this.ports.createPolicySnapshot(runnerId, 1, nowMs, null, "runner-created");
      });
    } catch (error) { if (expectedRegistryConflict(error, ["runner already exists", "runner creation conflict", "runner creation tombstone conflict"])) return undefined; throw error; }
    return this.getRunner(runnerId);
  }

  public renameRunner(runnerId: string, displayName: string, nowMs: number): RunnerRecord | undefined {
    if (!isSafeIdentifier(runnerId) || !validLabel(displayName)) return undefined;
    this.storage.sql.exec("UPDATE runners SET display_name = ?, updated_at_ms = ? WHERE runner_id = ?", displayName, nowMs, runnerId);
    return this.getRunner(runnerId);
  }

  public deleteRunner(runnerId: string, confirmation: string, nowMs: number, mutationId?: string): boolean {
    if (!isSafeIdentifier(runnerId) || confirmation !== runnerId || this.runnerRow(runnerId) === undefined || !validOptionalMutationId(mutationId)) return false;
    return this.storage.transactionSync(() => {
      if (mutationId !== undefined) {
        const recorded = this.recordCredentialMutation(runnerId, mutationId, "runner_delete", nowMs);
        if (recorded === "conflict") return false;
        if (recorded === "committed") return true;
      }
      this.storage.sql.exec("DELETE FROM runner_enrollments WHERE runner_id = ?", runnerId);
      this.storage.sql.exec("DELETE FROM client_runner_overrides WHERE runner_id = ?", runnerId);
      this.storage.sql.exec("DELETE FROM managed_workspaces WHERE runner_id = ?", runnerId);
      this.storage.sql.exec("DELETE FROM jobs WHERE runner_id = ?", runnerId);
      this.storage.sql.exec("DELETE FROM runner_policy_versions WHERE runner_id = ?", runnerId);
      this.storage.sql.exec("DELETE FROM runner_policy_mutations WHERE runner_id = ?", runnerId);
      this.storage.sql.exec("UPDATE mcp_clients SET active_runner_id = NULL, active_runner_updated_at_ms = ?, updated_at_ms = ? WHERE active_runner_id = ?", nowMs, nowMs, runnerId);
      this.storage.sql.exec("DELETE FROM runners WHERE runner_id = ?", runnerId);
      return true;
    });
  }

  public createRunnerEnrollment(runnerId: string, enrollmentId: string, verifier: string, nowMs: number, configuredExecutionMode?: RunnerExecutionMode, confirmPrivilegedHost = false, expectedConfiguredExecutionMode?: RunnerExecutionMode | null, expectedLifecycleId?: string, enrollmentTtlMs = DEFAULT_RUNNER_ENROLLMENT_TTL_MS, window: { not_before_ms?: number; expires_at_ms?: number } = {}): { enrollment_id: string; runner_id: string; created_at_ms: number; not_before_ms: number; expires_at_ms: number } | undefined {
    // The expected values are an optional compare-and-swap guard used by the
    // browser action path.
    if (!isSafeIdentifier(runnerId) || !/^[A-Za-z0-9_-]{43}$/.test(enrollmentId) || !validVerifier(verifier) || !validOptionalExecutionMode(configuredExecutionMode) || (configuredExecutionMode === "privileged_host" && !confirmPrivilegedHost) || !validExpectedExecutionMode(expectedConfiguredExecutionMode) || (expectedLifecycleId !== undefined && !validLifecycleId(expectedLifecycleId)) || !validRunnerEnrollmentTtl(enrollmentTtlMs)) return undefined;
    const notBeforeMs = window.not_before_ms ?? nowMs;
    const expiresAtMs = window.expires_at_ms ?? (Math.max(nowMs, notBeforeMs) + enrollmentTtlMs);
    if (!validTimestamp(notBeforeMs) || !validTimestamp(expiresAtMs) || expiresAtMs <= Math.max(nowMs, notBeforeMs) || expiresAtMs - nowMs > 365 * 24 * 60 * 60 * 1_000) return undefined;
    try {
      this.storage.transactionSync(() => {
        const current = this.runnerRow(runnerId);
        if (current === undefined) throw new Error("runner not found");
        // A mode read and the subsequent enrollment write may be separated by
        // a RunnerDO fence/network round trip.  Check both the trusted mode
        // and lifecycle while holding the Registry transaction so an old
        // request cannot downgrade a newer mode or write into a recreated
        // runner-id lifecycle. `undefined` means the caller did not request
        // a guard.
        if (expectedConfiguredExecutionMode !== undefined && current.configured_execution_mode !== expectedConfiguredExecutionMode) throw new Error("runner execution mode changed");
        if (expectedLifecycleId !== undefined && current.lifecycle_id !== expectedLifecycleId) throw new Error("runner lifecycle changed");
        // Persist the administrator's selection in the same transaction as
        // the one-time code.  A failed insert therefore cannot leave the
        // Runner advertising a mode for a code that was never issued.
        if (configuredExecutionMode !== undefined) {
          const update = expectedLifecycleId === undefined
            ? this.storage.sql.exec("UPDATE runners SET configured_execution_mode = ?, updated_at_ms = ? WHERE runner_id = ?", configuredExecutionMode, nowMs, runnerId)
            : this.storage.sql.exec("UPDATE runners SET configured_execution_mode = ?, updated_at_ms = ? WHERE runner_id = ? AND lifecycle_id = ?", configuredExecutionMode, nowMs, runnerId, expectedLifecycleId);
          if (update.rowsWritten !== 1) throw new Error("runner execution mode compare-and-swap failed");
        }
        this.storage.sql.exec("DELETE FROM runner_enrollments WHERE runner_id = ? AND used_at_ms IS NULL", runnerId);
        this.storage.sql.exec("INSERT INTO runner_enrollments (enrollment_id, runner_id, verifier, created_at_ms, not_before_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?)", enrollmentId, runnerId, verifier, nowMs, notBeforeMs, expiresAtMs);
      });
    } catch (error) { if (expectedRegistryConflict(error, ["runner not found", "runner execution mode changed", "runner lifecycle changed", "runner execution mode compare-and-swap failed"])) return undefined; throw error; }
    return { enrollment_id: enrollmentId, runner_id: runnerId, created_at_ms: nowMs, not_before_ms: notBeforeMs, expires_at_ms: expiresAtMs };
  }

  public lookupRunnerEnrollment(verifier: string, nowMs: number): { runner_id: string } | undefined {
    if (!validVerifier(verifier)) return undefined;
    const row = this.storage.sql.exec<Pick<EnrollmentRow, "runner_id">>(
      "SELECT runner_id FROM runner_enrollments WHERE verifier = ? AND used_at_ms IS NULL AND not_before_ms <= ? AND expires_at_ms > ?", verifier, nowMs, nowMs,
    ).toArray()[0];
    return row !== undefined && this.runnerRow(row.runner_id) !== undefined ? { runner_id: row.runner_id } : undefined;
  }

  public async redeemRunnerEnrollment(verifier: string, tokenVerifier: string, publicInfo: RunnerPublicInfo, nowMs: number, mutationId?: string): Promise<{ runner_id: string } | undefined> {
    if (!validVerifier(verifier) || !validVerifier(tokenVerifier) || !validRunnerPublicInfo(publicInfo) || !validOptionalMutationId(mutationId)) return undefined;
    return this.storage.transactionSync(() => {
      const row = this.storage.sql.exec<EnrollmentRow>(
        "SELECT * FROM runner_enrollments WHERE verifier = ? AND used_at_ms IS NULL AND not_before_ms <= ? AND expires_at_ms > ?", verifier, nowMs, nowMs,
      ).toArray()[0];
      if (row === undefined) {
        // A successful enrollment consumes the one-time row.  On a lost
        // response, a retry with the same mutation must still be recoverable,
        // but only when the consumed row carries the same verifier and the
        // current Runner lifecycle/credential generation proves the mutation
        // committed.  Never recover solely by mutation id: that would let a
        // caller replay an id against a different enrollment code.
        if (mutationId === undefined) return undefined;
        const committed = this.consumedEnrollmentMutation(mutationId, verifier);
        if (committed === undefined) return undefined;
        const recorded = this.recordCredentialMutation(committed.runner_id, mutationId, "credential_enroll", nowMs);
        const current = this.runnerRow(committed.runner_id);
        return recorded === "committed" && current !== undefined && constantTimeEqual(current.token_verifier, tokenVerifier)
          ? { runner_id: committed.runner_id } : undefined;
      }
      const runner = this.runnerRow(row.runner_id);
      if (runner === undefined) return undefined;
      if (mutationId !== undefined) {
        // Keep enrollment credential replacement on the same idempotent
        // mutation ledger as rotate/revoke.  The WorkerDO fence is acquired
        // before this transaction, so an attached old socket cannot race the
        // credential change and continue serving protected RPCs.
        const recorded = this.recordCredentialMutation(row.runner_id, mutationId, "credential_enroll", nowMs);
        if (recorded === "conflict") return undefined;
        if (recorded === "committed") {
          // A replay with a different token verifier must not be reported as a
          // successful enrollment: the original verifier is the credential
          // that Registry committed and is the only one the Worker may return.
          if (!constantTimeEqual(runner.token_verifier, tokenVerifier)) return undefined;
          // A committed marker with no consumed row represents a partial
          // transaction (the marker was written before the one-time row was
          // marked used). Complete only that row; if a used row is
          // already present, leave any newer pending enrollment untouched and
          // return the idempotent result above instead.
          const consumed = this.storage.sql.exec<{ enrollment_id: string }>(
            "SELECT enrollment_id FROM runner_enrollments WHERE runner_id = ? AND verifier = ? AND used_at_ms IS NOT NULL ORDER BY used_at_ms DESC LIMIT 1", row.runner_id, verifier,
          ).toArray()[0];
          if (consumed !== undefined) return { runner_id: row.runner_id };
          const anyConsumed = this.storage.sql.exec<{ enrollment_id: string }>(
            "SELECT enrollment_id FROM runner_enrollments WHERE runner_id = ? AND used_at_ms IS NOT NULL LIMIT 1", row.runner_id,
          ).toArray()[0];
          if (anyConsumed !== undefined) return undefined;
          this.storage.sql.exec("UPDATE runner_enrollments SET used_at_ms = ? WHERE enrollment_id = ? AND used_at_ms IS NULL", nowMs, row.enrollment_id);
          this.storage.sql.exec("DELETE FROM runner_enrollments WHERE runner_id = ? AND used_at_ms IS NULL", row.runner_id);
          return { runner_id: row.runner_id };
        }
      }
      const changed = this.storage.sql.exec("UPDATE runner_enrollments SET used_at_ms = ? WHERE enrollment_id = ? AND used_at_ms IS NULL AND not_before_ms <= ? AND expires_at_ms > ?", nowMs, row.enrollment_id, nowMs, nowMs);
      if (changed.rowsWritten !== 1) return undefined;
      this.storage.sql.exec(
        `UPDATE runners SET token_verifier = ?, credential_version = credential_version + 1, connection_epoch = connection_epoch + 1,
         state = 'offline', session_id = NULL, metadata_json = NULL, public_info_json = ?, current_runner_version = ?,
         protocol_min_version = ?, protocol_max_version = ?, protocol_compatibility = ?, update_status = ?, last_heartbeat_ms = NULL,
         last_sync_sequence = NULL, updated_at_ms = ? WHERE runner_id = ?`,
        tokenVerifier, JSON.stringify(publicInfo), publicInfo.runner_version, publicInfo.protocol_version, publicInfo.protocol_version,
        protocolCompatibility(publicInfo.protocol_version, publicInfo.protocol_version),
         updateStatus(runner.update_channel ?? "stable", runner.desired_runner_version ?? undefined, runner.latest_runner_version ?? undefined, { current_runner_version: publicInfo.runner_version, protocol_compatibility: protocolCompatibility(publicInfo.protocol_version, publicInfo.protocol_version) }),
         nowMs, row.runner_id,
       );
       // A Runner normally has only one pending code, but clear any duplicate
       // or stale rows as part of the credential replacement so an older code
       // cannot immediately rotate the new credential again.
       this.storage.sql.exec("DELETE FROM runner_enrollments WHERE runner_id = ? AND used_at_ms IS NULL", row.runner_id);
       return this.runnerRow(row.runner_id) === undefined ? undefined : { runner_id: row.runner_id };
    });
  }

  public async authenticateRunner(runnerId: string, token: string): Promise<{ credential_version: number } | undefined> {
    if (!isConfiguredSecret(this.runnerTokenPepper)) return undefined;
    const tokenVerifier = await runnerTokenVerifier(token, this.runnerTokenPepper);
    const row = this.storage.sql.exec<Pick<RunnerRow, "token_verifier" | "credential_version">>("SELECT token_verifier, credential_version FROM runners WHERE runner_id = ?", runnerId).toArray()[0];
    return row !== undefined && row.token_verifier.length > 0 && constantTimeEqual(row.token_verifier, tokenVerifier) ? { credential_version: row.credential_version } : undefined;
  }

  public beginConnection(runnerId: string, metadata: RunnerMetadata, protocol: { min_protocol_version: number; max_protocol_version: number }, sessionId: string, credentialVersion: number, nowMs: number): number | undefined {
    const compatibility = protocolCompatibility(protocol.min_protocol_version, protocol.max_protocol_version);
    // Allocate the epoch and publish the session in one transaction. Reading
    // the row, then querying it again after UPDATE, lets two simultaneous
    // connects both observe the *later* epoch and would leave both sockets
    // authorized as the same session.
    return this.storage.transactionSync(() => {
      const prior = this.runnerRow(runnerId);
      if (prior === undefined || prior.credential_version !== credentialVersion || !validLifecycleId(prior.lifecycle_id) || !validSessionId(sessionId) || !Number.isSafeInteger(prior.connection_epoch) || prior.connection_epoch < 0) return undefined;
      const nextEpoch = prior.connection_epoch + 1;
      const changed = this.storage.sql.exec(
        `UPDATE runners SET state = 'online', connection_epoch = ?, session_id = ?, metadata_json = ?,
         current_runner_version = ?, protocol_min_version = ?, protocol_max_version = ?, protocol_compatibility = ?,
         update_status = ?, last_heartbeat_ms = ?, last_sync_sequence = NULL,
         policy_status = CASE WHEN desired_policy_revision = 0 THEN 'applied' ELSE 'pending' END, updated_at_ms = ?
         WHERE runner_id = ? AND credential_version = ? AND connection_epoch = ?`,
        nextEpoch, sessionId, JSON.stringify(metadata), metadata.runner_version, protocol.min_protocol_version, protocol.max_protocol_version, compatibility,
        updateStatus(prior.update_channel ?? "stable", prior.desired_runner_version ?? undefined, prior.latest_runner_version ?? undefined, { ...prior, current_runner_version: metadata.runner_version, protocol_compatibility: compatibility }),
        nowMs, nowMs, runnerId, credentialVersion, prior.connection_epoch,
      );
      return changed.rowsWritten === 1 ? nextEpoch : undefined;
    });
  }

  public sessionIsCurrent(runnerId: string, epoch: number, credentialVersion: number, requireOnline: boolean, lifecycleId: string, sessionId: string): boolean {
    if (!validTransportIdentity(lifecycleId, sessionId)) return false;
    const row = this.storage.sql.exec<Pick<RunnerRow, "connection_epoch" | "credential_version" | "state" | "lifecycle_id" | "session_id">>("SELECT connection_epoch, credential_version, state, lifecycle_id, session_id FROM runners WHERE runner_id = ?", runnerId).toArray()[0];
    return row?.connection_epoch === epoch && row.credential_version === credentialVersion && (!requireOnline || row.state === "online") && matchesTransportIdentity(row, lifecycleId, sessionId);
  }

  public recordHeartbeat(runnerId: string, epoch: number, credentialVersion: number, nowMs: number, lifecycleId: string, sessionId: string): boolean {
    if (!validTransportIdentity(lifecycleId, sessionId) || !safeNonnegativeInteger(epoch) || !safeNonnegativeInteger(credentialVersion) || !safeNonnegativeInteger(nowMs)) return false;
    // Heartbeats may be retried or replayed inside the signature skew window.
    // Keep the write monotonic so an older replay cannot move the liveness
    // timestamp backwards. The normal path is one conditional write; only a
    // duplicate/clock-rollback frame needs a read to distinguish an unchanged
    // current session from a stale transport identity.
    // Storage exceptions propagate to the HTTP boundary as 503, never false.
    const updated = this.storage.sql.exec("UPDATE runners SET state = 'online', last_heartbeat_ms = ?, updated_at_ms = ? WHERE runner_id = ? AND connection_epoch = ? AND credential_version = ? AND lifecycle_id = ? AND session_id = ? AND (last_heartbeat_ms IS NULL OR last_heartbeat_ms < ?)", nowMs, nowMs, runnerId, epoch, credentialVersion, lifecycleId, sessionId, nowMs);
    if (updated.rowsWritten === 1) return true;
    const current = this.storage.sql.exec<Pick<RunnerRow, "connection_epoch" | "credential_version" | "state" | "lifecycle_id" | "session_id" | "last_heartbeat_ms">>("SELECT connection_epoch, credential_version, state, lifecycle_id, session_id, last_heartbeat_ms FROM runners WHERE runner_id = ?", runnerId).toArray()[0];
    return current?.connection_epoch === epoch && current.credential_version === credentialVersion && current.state === "online"
      && current.lifecycle_id === lifecycleId && current.session_id === sessionId && current.last_heartbeat_ms !== null && current.last_heartbeat_ms >= nowMs;
  }

  public markDisconnected(runnerId: string, epoch: number, credentialVersion: number, state: Exclude<RunnerConnectionState, "online">, nowMs: number, lifecycleId: string, sessionId: string): void {
    if (!validTransportIdentity(lifecycleId, sessionId)) return;
    this.storage.sql.exec("UPDATE runners SET state = ?, session_id = NULL, updated_at_ms = ? WHERE runner_id = ? AND connection_epoch = ? AND credential_version = ? AND lifecycle_id = ? AND session_id = ?", state, nowMs, runnerId, epoch, credentialVersion, lifecycleId, sessionId);
  }

  public invalidateRunnerCredential(runnerId: string, nowMs: number, mutationId?: string): boolean {
    if (!validOptionalMutationId(mutationId)) return false;
    return this.storage.transactionSync(() => {
      if (this.runnerRow(runnerId) === undefined) return false;
      if (mutationId !== undefined) {
        const recorded = this.recordCredentialMutation(runnerId, mutationId, "credential_rotate", nowMs);
        if (recorded === "conflict") return false;
        if (recorded === "committed") return true;
      }
      const result = this.storage.sql.exec(`UPDATE runners SET credential_version = credential_version + 1, connection_epoch = connection_epoch + 1,
        token_verifier = '', state = 'offline', session_id = NULL, last_heartbeat_ms = NULL, updated_at_ms = ? WHERE runner_id = ?`, nowMs, runnerId);
      if (result.rowsWritten === 1) this.storage.sql.exec("DELETE FROM runner_enrollments WHERE runner_id = ? AND used_at_ms IS NULL", runnerId);
      return result.rowsWritten === 1;
    });
  }

  public revokeRunner(runnerId: string, confirmation: string, nowMs: number, mutationId?: string): boolean {
    if (!isSafeIdentifier(runnerId) || confirmation !== runnerId || this.runnerRow(runnerId) === undefined || !validOptionalMutationId(mutationId)) return false;
    return this.storage.transactionSync(() => {
      if (mutationId !== undefined) {
        const recorded = this.recordCredentialMutation(runnerId, mutationId, "credential_revoke", nowMs);
        if (recorded === "conflict") return false;
        if (recorded === "committed") return true;
      }
      this.storage.sql.exec(`UPDATE runners SET credential_version = credential_version + 1, connection_epoch = connection_epoch + 1,
       token_verifier = '', state = 'offline', session_id = NULL, metadata_json = NULL, last_heartbeat_ms = NULL,
       last_sync_sequence = NULL, updated_at_ms = ? WHERE runner_id = ?`, nowMs, runnerId);
      this.storage.sql.exec("DELETE FROM runner_enrollments WHERE runner_id = ? AND used_at_ms IS NULL", runnerId);
      return true;
    });
  }

  public runnerAccess(runnerId: string, nowMs = Date.now()): { allowed: boolean; status: ValidityStatus | "missing" } {
    const runner = this.runnerRow(runnerId);
    const status = runner === undefined ? "missing" : validityStatus(runner, nowMs);
    return { allowed: status === "active", status };
  }

  public setRunnerValidity(runnerId: string, window: ValidityWindow, lifecycleId: string, nowMs = Date.now()): boolean {
    if (!validWindow(window) || !validLifecycleId(lifecycleId)) return false;
    return this.storage.sql.exec("UPDATE runners SET valid_from_ms = ?, valid_until_ms = ?, updated_at_ms = ? WHERE runner_id = ? AND lifecycle_id = ?", window.valid_from_ms, window.valid_until_ms, nowMs, runnerId, lifecycleId).rowsWritten === 1;
  }

  public latestRunnerEnrollment(runnerId: string): Omit<EnrollmentRow, "verifier"> | undefined {
    return this.storage.sql.exec<Omit<EnrollmentRow, "verifier">>("SELECT enrollment_id, runner_id, created_at_ms, not_before_ms, expires_at_ms, used_at_ms FROM runner_enrollments WHERE runner_id = ? ORDER BY created_at_ms DESC LIMIT 1", runnerId).toArray()[0];
  }

  public getRunner(runnerId: string): RunnerRecord | undefined {
    const nowMs = Date.now();
    const staleBefore = nowMs - 45_000;
    let row = this.storage.sql.exec<RunnerRow>("SELECT * FROM runners WHERE runner_id = ?", runnerId).toArray()[0];
    // Read first so healthy control-plane lookups do not execute a write
    // statement that matches zero rows on every request. Only persist the
    // transition when the snapshot is actually stale.
    if (row?.state === "online" && row.last_heartbeat_ms !== null && row.last_heartbeat_ms < staleBefore) {
      this.storage.sql.exec("UPDATE runners SET state = 'stale', updated_at_ms = ? WHERE runner_id = ? AND state = 'online' AND last_heartbeat_ms < ?", nowMs, runnerId, staleBefore);
      row = this.storage.sql.exec<RunnerRow>("SELECT * FROM runners WHERE runner_id = ?", runnerId).toArray()[0];
    }
    return row === undefined ? undefined : decodeRunner(row);
  }

  public getRunnerExecutionState(runnerId: string): { readonly runner: RunnerRecord; readonly lifecycle_id: string; readonly session_id: string | null } | undefined {
    const nowMs = Date.now();
    const staleBefore = nowMs - 45_000;
    let row = this.storage.sql.exec<RunnerRow>("SELECT * FROM runners WHERE runner_id = ?", runnerId).toArray()[0];
    if (row?.state === "online" && row.last_heartbeat_ms !== null && row.last_heartbeat_ms < staleBefore) {
      this.storage.sql.exec("UPDATE runners SET state = 'stale', updated_at_ms = ? WHERE runner_id = ? AND state = 'online' AND last_heartbeat_ms < ?", nowMs, runnerId, staleBefore);
      row = this.storage.sql.exec<RunnerRow>("SELECT * FROM runners WHERE runner_id = ?", runnerId).toArray()[0];
    }
    return row === undefined || !validLifecycleId(row.lifecycle_id) ? undefined : { runner: decodeRunner(row), lifecycle_id: row.lifecycle_id, session_id: row.session_id };
  }

  public listRunners(): RunnerRecord[] { return this.storage.sql.exec<RunnerRow>("SELECT * FROM runners ORDER BY display_name, runner_id").toArray().map(decodeRunner); }

  public consumedEnrollmentMutation(mutationId: string, verifier: string): (CredentialMutationRow & { runner_id: string }) | undefined {
    const rows = this.storage.sql.exec<CredentialMutationRow & { runner_id: string }>(
      `SELECT m.runner_id, m.kind, m.pre_credential_version, m.lifecycle_id
       FROM runner_mutations AS m
       INNER JOIN runner_enrollments AS e ON e.runner_id = m.runner_id
       WHERE m.mutation_id = ? AND e.verifier = ? AND e.used_at_ms IS NOT NULL
       ORDER BY e.used_at_ms DESC`, mutationId, verifier,
    ).toArray();
    for (const row of rows) {
      if (row.kind !== "credential_enroll" && row.kind !== "credential_rotate") continue;
      const runner = this.runnerRow(row.runner_id);
      if (runner !== undefined && validLifecycleId(runner.lifecycle_id) && runner.lifecycle_id === row.lifecycle_id && runner.credential_version === row.pre_credential_version + 1) return row;
    }
    return undefined;
  }

  public mutationRow(runnerId: string, mutationId: string): CredentialMutationRow | undefined {
    return this.storage.sql.exec<CredentialMutationRow>(
      "SELECT kind, pre_credential_version, lifecycle_id FROM runner_mutations WHERE runner_id = ? AND mutation_id = ?", runnerId, mutationId,
    ).toArray()[0];
  }

  public recordCredentialMutation(runnerId: string, mutationId: string, kind: CredentialMutationKind, nowMs: number): "new" | "committed" | "conflict" {
    const runner = this.runnerRow(runnerId);
    if (runner === undefined || !validMutationId(mutationId)) throw new Error("invalid credential mutation");
    // A missing lifecycle identity indicates incomplete/unsafe data;
    // fail closed rather than letting an empty marker match it.
    if (!validLifecycleId(runner.lifecycle_id)) return "conflict";
    const existing = this.mutationRow(runnerId, mutationId);
    if (existing !== undefined) {
      // Mutation IDs are scoped to a single Runner lifecycle. A tombstone from
      // a deleted Runner must never be allowed to mutate a newly-created row
      // that happens to reuse the same runner_id.
      if (!validLifecycleId(existing.lifecycle_id) || existing.lifecycle_id !== runner.lifecycle_id) return "conflict";
      if (existing.kind !== kind) return "conflict";
      // Credential mutations advance credential_version. A matching
      // post-version proves the first transaction committed; a marker with
      // the same version is retried safely below. Deletion is different:
      // it removes the Runner row instead of advancing a version, so an
      // existing row always means the delete still needs to run.
      // A delete marker can survive while the row remains present if its
      // transaction was interrupted. Retry that partial
      // delete only for the same credential generation; never let an old
      // delete marker erase a credential that was rotated afterwards.
      if (existing.kind === "runner_delete") return runner.credential_version === existing.pre_credential_version ? "new" : "conflict";
      if (existing.kind === "runner_create") return "conflict";
      if (runner.credential_version === existing.pre_credential_version + 1) return "committed";
      return runner.credential_version === existing.pre_credential_version ? "new" : "conflict";
    }
    this.storage.sql.exec("INSERT INTO runner_mutations (runner_id, mutation_id, kind, pre_credential_version, lifecycle_id, committed_at_ms) VALUES (?, ?, ?, ?, ?, ?)", runnerId, mutationId, kind, runner.credential_version, runner.lifecycle_id, nowMs);
    return "new";
  }

  public runnerRow(runnerId: string): RunnerRow | undefined { return this.storage.sql.exec<RunnerRow>("SELECT * FROM runners WHERE runner_id = ?", runnerId).toArray()[0]; }
}
