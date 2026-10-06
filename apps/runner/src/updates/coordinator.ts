import { isTerminalRunnerUpdate } from "@aloneio/runmesh-protocol";
import { UpdateFailure } from "./contracts.js";
import { MaintenanceHttpError } from "./cloud.js";
import type { CloudUpdateObservation, LocalUpdatePhase, UpdateCoordinatorOptions, UpdateErrorCode, UpdateJournal, UpdateOwner } from "./contracts.js";

const terminal = (phase: LocalUpdatePhase): phase is "succeeded" | "rolled_back" | "failed" => ["succeeded", "rolled_back", "failed"].includes(phase);
const needsRecovery = (phase: LocalUpdatePhase): boolean => ["stopping", "switching", "starting", "checking", "rolling_back"].includes(phase);
const unavailableObservation = (error: unknown): boolean => error instanceof TypeError
  || error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)
  || error instanceof MaintenanceHttpError && (error.status >= 500 || [408, 429].includes(error.status));

/** One operation owns the durable journal and the platform installation lease.
 * Network acknowledgement never owns native cleanup or rollback. */
export class UpdateCoordinator {
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  public constructor(private readonly options: UpdateCoordinatorOptions) {
    this.now = options.now ?? (() => performance.now());
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }
  private guard(): void { this.options.assertInstallationLock?.(); }
  private owner(journal: UpdateJournal): UpdateOwner { return { operation_id: journal.operation.operation_id, lifecycle_id: journal.operation.lifecycle_id, manager_id: journal.manager_id }; }
  private matches(journal: UpdateJournal, observation: CloudUpdateObservation): boolean {
    return observation.operation?.operation_id === journal.operation.operation_id && observation.operation.lifecycle_id === journal.operation.lifecycle_id && observation.operation.manager_id === journal.manager_id;
  }
  private async write(journal: UpdateJournal, phase: LocalUpdatePhase, errorCode?: UpdateErrorCode): Promise<UpdateJournal> {
    const next: UpdateJournal = { ...journal, phase, ...(errorCode === undefined ? {} : { error_code: errorCode }) };
    await this.options.journal.save(next); return next;
  }
  private async finish(journal: UpdateJournal): Promise<void> {
    if (!terminal(journal.phase)) throw new UpdateFailure("local_state_invalid");
    // Persist terminal local state before asking the cloud to remove its fence.
    // A lost HTTP response can only replay this idempotent acknowledgement; it
    // must never roll back a target after the cloud has admitted new jobs.
    const version = journal.phase === "succeeded" ? journal.operation.target_version : journal.previous.version;
    let result: CloudUpdateObservation;
    try { result = await this.options.cloud.report(this.owner(journal), journal.phase, { observed_version: version, ...(journal.error_code === undefined ? {} : { error_code: journal.error_code }) }); }
    catch (error) {
      if (!(error instanceof MaintenanceHttpError) || error.status !== 409) throw error;
      const observed = await this.options.cloud.poll();
      // An operator can enqueue the next operation after the server committed
      // our terminal receipt but its response was lost. Retire only this local
      // terminal record; never replay it over a new operation or lifecycle.
      if (observed.operation !== null && (observed.operation.operation_id !== journal.operation.operation_id || observed.operation.lifecycle_id !== journal.operation.lifecycle_id)) {
        await this.options.journal.complete(journal); return;
      }
      if (this.matches(journal, observed) && observed.operation?.state === journal.phase) {
        await this.options.journal.complete(journal); return;
      }
      if (journal.phase === "succeeded" && this.matches(journal, observed) && observed.operation !== null && !isTerminalRunnerUpdate(observed.operation.state)) {
        // The candidate can exit between its health observation and commit.
        // A fresh nonterminal server record proves that the cloud fence is
        // still held; only then may a rejected success safely roll back.
        await this.rollback(await this.write(journal, "checking"), "activation_failed"); return;
      }
      throw error;
    }
    if (!this.matches(journal, result) || result.operation?.state !== journal.phase) throw new UpdateFailure("activation_failed");
    await this.options.journal.complete(journal);
  }
  private async waitForVersion(journal: UpdateJournal, version: string): Promise<void> {
    const deadline = this.now() + (this.options.activationTimeoutMs ?? 120_000);
    while (this.now() < deadline) {
      try {
        const observation = await this.options.cloud.poll();
        if (!this.matches(journal, observation)) throw new UpdateFailure("activation_failed");
        if (observation.observed_new_session && observation.observed_version === version) return;
      } catch (error) {
        if (error instanceof UpdateFailure) throw error;
        // Reconnection and transient HTTPS failures remain inside one fixed
        // activation budget, with no mutation or status writes per poll.
      }
      await this.sleep(2_000);
    }
    throw new UpdateFailure("activation_failed");
  }
  private async drain(journal: UpdateJournal): Promise<boolean> {
    const deadline = this.now() + (this.options.drainTimeoutMs ?? 15 * 60_000);
    let invalidSince: number | undefined;
    while (this.now() < deadline) {
      if (this.options.signal?.aborted) throw new UpdateFailure("busy_local_jobs");
      const observation = await this.options.cloud.poll();
      if (!this.matches(journal, observation) || (observation.operation !== null && isTerminalRunnerUpdate(observation.operation.state))) throw new UpdateFailure("activation_failed");
      if (observation.cloud_drained || observation.cloud_uncertain) {
        try {
          const jobs = await this.options.jobs(); invalidSince = undefined;
          if (jobs.idle) return !observation.cloud_drained;
        } catch (error) {
          if (!(error instanceof UpdateFailure) || error.code !== "local_state_invalid") throw error;
          // A job can atomically publish its terminal metadata during a scan.
          // Retry that conservative observation briefly, never count it idle.
          invalidSince ??= this.now();
          if (this.now() - invalidSince >= 5_000) throw error;
        }
      }
      await this.sleep(2_000);
    }
    throw new UpdateFailure(invalidSince === undefined ? "busy_local_jobs" : "local_state_invalid");
  }
  private async proveStopped(journal: UpdateJournal): Promise<void> {
    const deadline = this.now() + (this.options.activationTimeoutMs ?? 120_000);
    while (this.now() < deadline) {
      try {
        const result = await this.options.cloud.proveStopped(this.owner(journal));
        if (!this.matches(journal, result)) throw new UpdateFailure("activation_failed");
        if (result.cloud_drained && !result.cloud_uncertain) return;
      } catch (error) {
        // Native exit can precede close-frame propagation. Only the explicit
        // HTTP conflict is retried; no timeout is itself drain evidence.
        if (!(error instanceof MaintenanceHttpError) || error.status !== 409) throw error;
      }
      await this.sleep(2_000);
    }
    throw new UpdateFailure("activation_failed");
  }
  private async rollback(journal: UpdateJournal, errorCode: UpdateErrorCode): Promise<void> {
    let identity: string;
    let observed: CloudUpdateObservation | undefined;
    try {
      identity = await this.options.recoveryIdentity();
      try { observed = await this.options.cloud.poll(); }
      catch (error) {
        // A network outage does not prevent restoring our original install.
        // Changed/re-enrolled credentials always need authenticated ownership.
        if (!unavailableObservation(error) || journal.recovery_identity !== identity) throw error;
      }
    } catch {
      // No authenticated answer is not proof of replacement. Keep this phase
      // retryable so a rotated credential can confirm ownership when online.
      throw new UpdateFailure("invalid_installation");
    }
    try {
      if (observed !== undefined && (!this.matches(journal, observed) || observed.operation === null || isTerminalRunnerUpdate(observed.operation.state))) throw new UpdateFailure("invalid_installation");
      await this.options.installation.assertRecoverable(journal.previous, journal.next, journal.operation.operation_id);
      if (await this.options.recoveryIdentity() !== identity) throw new UpdateFailure("invalid_installation");
    } catch {
      // A retained old journal cannot stop work admitted after re-enrollment or
      // replacement of current. Keep the evidence for explicit local recovery.
      await this.write(journal, "recovery_required", "invalid_installation");
      throw new UpdateFailure("invalid_installation");
    }
    let current = await this.write({ ...journal, recovery_identity: identity }, "rolling_back", errorCode);
    const guardRecovery = async (): Promise<void> => {
      this.guard();
      if (await this.options.recoveryIdentity() !== identity) throw new UpdateFailure("invalid_installation");
    };
    try {
      await guardRecovery(); await this.options.service.stop();
      await guardRecovery(); await this.options.installation.restore(current.previous, current.next, current.operation.operation_id);
      await guardRecovery(); await this.options.service.start();
      await guardRecovery(); await this.options.service.restoreEnabled(current.service);
      await this.waitForVersion(current, current.previous.version);
      current = await this.write(current, "rolled_back", errorCode);
    } catch {
      // Never remove the cloud fence when native rollback is uncertain.
      await this.write(current, "recovery_required", "rollback_failed");
      await this.options.cloud.report(this.owner(current), "checking", { error_code: "rollback_failed" }).catch(() => undefined);
      throw new UpdateFailure("rollback_failed");
    }
    await this.finish(current);
  }

  public async runOnce(): Promise<void> {
    this.guard();
    const saved = await this.options.journal.load();
    if (saved !== undefined) {
      if (saved.manager_id !== this.options.managerId) throw new UpdateFailure("local_state_invalid");
      if (terminal(saved.phase)) { await this.finish(saved); return; }
      if (saved.phase === "recovery_required") {
        const observed = await this.options.cloud.poll();
        const errorCode = saved.error_code ?? "rollback_failed";
        if (this.matches(saved, observed) && (observed.operation?.state !== "checking" || observed.operation.error_code !== errorCode)) await this.options.cloud.report(this.owner(saved), "checking", { error_code: errorCode });
        throw new UpdateFailure(errorCode);
      }
      if (needsRecovery(saved.phase)) { await this.rollback(saved, saved.error_code ?? "activation_failed"); return; }
      // Before stopping the service, a crashed operation is safe to abandon.
      // It retains its immutable staged tree, and releases the cloud fence.
      await this.finish(await this.write(saved, "failed", "activation_failed")); return;
    }
    const offered = await this.options.cloud.poll();
    const offeredOperation = offered.operation;
    if (offeredOperation === null || isTerminalRunnerUpdate(offeredOperation.state) || (offeredOperation.manager_id !== null && offeredOperation.manager_id !== this.options.managerId)) return;
    const owner = { operation_id: offeredOperation.operation_id, lifecycle_id: offeredOperation.lifecycle_id, manager_id: this.options.managerId };
    const recoveryIdentity = await this.options.recoveryIdentity();
    const claimed = await this.options.cloud.claim(owner);
    if (claimed.operation?.operation_id !== offeredOperation.operation_id || claimed.operation.lifecycle_id !== offeredOperation.lifecycle_id || claimed.operation.manager_id !== this.options.managerId) throw new UpdateFailure("activation_failed");
    const operation = claimed.operation;
    if (operation.state !== "verifying") throw new UpdateFailure("local_state_invalid");
    let journal: UpdateJournal;
    try {
      const previous = await this.options.installation.inspect();
      if (operation.original_version !== previous.version) throw new UpdateFailure("invalid_installation");
      const service = await this.options.service.snapshot();
      if (!service.registered) throw new UpdateFailure("invalid_installation");
      journal = { schema_version: 1, operation, manager_id: this.options.managerId, recovery_identity: recoveryIdentity, previous, service, phase: "claimed" };
      await this.options.journal.save(journal);
    } catch {
      await this.options.cloud.report(owner, "failed", { error_code: "invalid_installation" });
      throw new UpdateFailure("invalid_installation");
    }
    let failureCode: UpdateErrorCode = "verification_failed";
    try {
      await this.options.cloud.report(owner, "verifying"); this.guard();
      const staged = await this.options.stage({ version: operation.target_version, channel: operation.target_channel, manifest_sha256: operation.manifest_sha256, artifact_sha256: operation.artifact_sha256 }, operation.operation_id);
      if (staged.version !== operation.target_version || staged.manifestSha256 !== operation.manifest_sha256 || staged.artifactSha256 !== operation.artifact_sha256) throw new UpdateFailure("verification_failed");
      journal = await this.write({ ...journal, next: { version: staged.version, directory: staged.versionDirectory } }, "staged");
      failureCode = "busy_local_jobs";
      journal = await this.write(journal, "draining"); await this.options.cloud.report(owner, "draining");
      await this.drain(journal);
      failureCode = "service_stop_failed";
      await this.options.cloud.report(owner, "installing");
      // Recheck immediately before the stop. The cloud fence prevents fresh
      // admission while this second complete local scan closes the stage gap.
      const proofRequired = await this.drain(journal);
      journal = await this.write(journal, "stopping"); this.guard(); await this.options.service.stop();
      failureCode = "activation_failed";
      if (proofRequired) await this.proveStopped(journal);
      journal = await this.write(journal, "switching"); this.guard();
      await this.options.installation.switch(journal.previous, journal.next!, operation.operation_id);
      journal = await this.write(journal, "starting"); this.guard(); await this.options.service.start();
      journal = await this.write(journal, "checking"); await this.options.cloud.report(owner, "checking");
      await this.waitForVersion(journal, operation.target_version);
      this.guard(); await this.options.service.restoreEnabled(journal.service);
      journal = await this.write(journal, "succeeded");
    } catch (error) {
      const code = error instanceof UpdateFailure ? error.code : failureCode;
      if (needsRecovery(journal.phase)) { await this.rollback(journal, code); return; }
      await this.finish(await this.write(journal, "failed", code)); return;
    }
    await this.finish(journal);
  }
}
