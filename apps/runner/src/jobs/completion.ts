import type { JobRecord, LocalJobStatus } from "./records.js";
import { isActive, sameJobProcessIdentity, nextJobUpdate } from "./records.js";

/** Scoped operations on one Job; JobManager remains the only state owner. */
export interface CompletionPorts {
  current(): JobRecord | undefined;
  pendingTermination(): Promise<boolean> | undefined;
  terminationDelivered(): boolean;
  flushLogs(): Promise<void>;
  persist(record: JobRecord): Promise<void>;
  reserveTerminal(reserved: boolean): void;
  retireProcess(): void;
  publish(record: JobRecord): void;
  completed(record: JobRecord): void;
  prune(): Promise<void>;
  now(): number;
}
export async function finishJobCompletion(ports: CompletionPorts, code: number | null, signal: string | null, spawnFailed: boolean): Promise<void> {
  const pendingTermination = ports.pendingTermination();
  let pendingDelivered = pendingTermination === undefined ? false : await pendingTermination.catch(() => false);
  await ports.flushLogs();
  // A cancellation can register its termination decision while the log
  // durability barrier is in flight. Observe that newer promise as well;
  // otherwise this completion could classify a delivered signal as failed
  // and overwrite its evidence before cancel() resumes.
  const pendingAfterFlush = ports.pendingTermination();
  if (pendingAfterFlush !== undefined && pendingAfterFlush !== pendingTermination) pendingDelivered = (await pendingAfterFlush.catch(() => false)) || pendingDelivered;
  // Cancellation/recovery checks can terminalize the record while log
  // durability is in flight. Re-read after that await so a stale active
  // snapshot can never resurrect an already terminal identity decision.
  const prior = ports.current();
  if (prior === undefined || !isActive(prior)) return;
  const current = ports.current() ?? prior;
  const deliveredCancellation = current.status === "cancelling" && (pendingDelivered || ports.terminationDelivered() || current.cancellation_delivered_at_ms !== null);
  // A code-zero exit is a successful process completion even if cancel raced
  // with it. Cancellation is reserved for a delivered termination with an
  // abnormal/signal exit, so status does not overstate what happened.
  const status: LocalJobStatus = spawnFailed ? "failed" : code === 0 ? "succeeded" : deliveredCancellation ? "cancelled" : "failed";
  // A pending termination can settle before cancel() gets a chance to write
  // its delivery marker (for example, when the platform emits `close`
  // synchronously from the terminator). Preserve that evidence on the
  // terminal record so a restart cannot reinterpret a delivered request as
  // an ordinary interruption. This also applies when the process exits 0
  // after a delivered cancellation race.
  const cancellationDeliveredAt = current.cancellation_delivered_at_ms ?? (deliveredCancellation ? ports.now() : null);
  let completed: JobRecord = {
    ...current,
    status,
    updated_at_ms: nextJobUpdate(current, ports.now()),
    completed_at_ms: ports.now(),
    exit_code: status === "cancelled" ? null : code,
    signal,
    cancellation_delivered_at_ms: cancellationDeliveredAt
  };
  // Keep the in-memory record active until the terminal metadata is durable,
  // but reserve the terminal write first.  `start()` may still be finishing
  // its post-spawn running write; persist() uses this reservation to discard
  // that stale active snapshot rather than letting it run after the terminal
  // callback and overwrite the durable outcome.
  ports.reserveTerminal(true);
  try {
    await ports.persist(completed);
    // The terminal write yields to the filesystem and persistence queue. A
    // recovery/cancellation callback can publish a newer terminal identity
    // during that window. Do not overwrite it (or emit a duplicate
    // completion event) when this stale finish task resumes. The map check
    // is intentionally after the durability barrier: before it, `prior` is
    // still the active record whose terminal write is authorized above.
    const afterPersist = ports.current();
    if (afterPersist === undefined) {
      ports.retireProcess();
      return;
    }
    if (afterPersist !== prior) {
      // A newer active snapshot may have been published while the terminal
      // write was in flight (for example output_truncated, or a concurrent
      // cancellation). Never blindly replace it with the stale completed
      // object. A running snapshot can be safely merged only when it still
      // names the same child identity; preserve every newer field and
      // recompute the terminal cancellation evidence from that snapshot.
      if (!isActive(afterPersist) || !sameJobProcessIdentity(afterPersist, prior)) {
        // A different active identity may now own this job key. Its
        // ChildProcess/termination marker belongs to that newer process;
        // never clean those maps from this stale completion callback. A
        // terminal replacement has no newer process, so retire the old
        // handle in that case.
        if (!isActive(afterPersist)) {
          ports.retireProcess();
        }
        return;
      }
      // A cancellation that has not yet produced delivery evidence owns the
      // state transition. Let its process/close path finish the job instead
      // of converting a newer cancelling snapshot into a stale success or
      // failure. This is deliberately conservative even for an exit code of
      // zero: the cancellation caller may still be persisting its decision.
      const latestAttempt = ports.pendingTermination();
      if (latestAttempt !== undefined) pendingDelivered = (await latestAttempt.catch(() => false)) || pendingDelivered;
      const cancellationPending = afterPersist.status === "cancelling" && !pendingDelivered && !ports.terminationDelivered() && afterPersist.cancellation_delivered_at_ms === null;
      if (cancellationPending) {
        // The first terminal write was authorized against `prior`, but the
        // cancellation snapshot now owns this identity.  Keep the active
        // state on disk as well as in memory before returning; otherwise a
        // synthetic/late cancellation could leave a durable `succeeded`
        // record with no completion event for the still-cancelling job.
        // Drop the terminal reservation for this one current snapshot so
        // persist() does not intentionally suppress it as stale.
        ports.reserveTerminal(false);
        await ports.persist(afterPersist);
        return;
      }
      const mergedDelivered = afterPersist.status === "cancelling" && (pendingDelivered || ports.terminationDelivered() || afterPersist.cancellation_delivered_at_ms !== null);
      const mergedStatus: LocalJobStatus = spawnFailed ? "failed" : code === 0 ? "succeeded" : mergedDelivered ? "cancelled" : "failed";
      const mergedCancellationDeliveredAt = afterPersist.cancellation_delivered_at_ms ?? (mergedDelivered ? ports.now() : null);
      completed = {
        ...afterPersist,
        status: mergedStatus,
        updated_at_ms: nextJobUpdate(afterPersist, ports.now()),
        completed_at_ms: ports.now(),
        exit_code: mergedStatus === "cancelled" ? null : code,
        signal,
        cancellation_delivered_at_ms: mergedCancellationDeliveredAt
      };
      // Persist the merged terminal snapshot as the first write intentionally
      // used the older active identity. terminalPersisting permits this
      // pre-publication terminal write, while the identity check below
      // prevents a second active update from being overwritten.
      await ports.persist(completed);
      const afterMergedPersist = ports.current();
      if (afterMergedPersist !== afterPersist) {
        // Preserve a different active identity's process handle. Retire
        // only when the map is absent/terminal or still names this child.
        if (afterMergedPersist === undefined || !isActive(afterMergedPersist) || sameJobProcessIdentity(afterMergedPersist, afterPersist)) {
          ports.retireProcess();
        }
        return;
      }
    }
    ports.publish(completed);
    ports.retireProcess();
    ports.completed(completed);
    await ports.prune();
  } finally {
    ports.reserveTerminal(false);
  }
}
