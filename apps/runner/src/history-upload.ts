/** One request-local upload opportunity, not a repeating snapshot poll.
 * A generation acknowledges only the changes captured by that upload. */
export interface HistoryUploadClock {
  schedule(delayMs: number, callback: () => void): () => void;
}
const nativeClock: HistoryUploadClock = {
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, delayMs); timer.unref();
    return () => clearTimeout(timer);
  },
};

export class HistoryUploadScheduler {
  private active = false;
  private epoch = 0;
  private revision = 0;
  private acknowledged = 0;
  private intervalMs = 300_000;
  private immediate = false;
  private attempts = 0;
  private flushing = false;
  private recoveryPending = false;
  private cancelTimer: (() => void) | undefined;

  public constructor(private readonly upload: (revision: number) => Promise<void>, private readonly clock: HistoryUploadClock = nativeClock) {}

  public start(intervalMs: number, immediate = false): void {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 3_600_000) throw new Error("invalid history upload interval");
    this.stop(); this.active = true; this.intervalMs = intervalMs; this.immediate = immediate;
    this.revision = 1; this.acknowledged = 0; this.attempts = 0; this.flushing = false; this.recoveryPending = false;
    // Exactly one bounded bootstrap reconciles retained records after restart.
    this.schedule(0);
  }

  public stop(): void {
    this.active = false; this.epoch++; this.cancelTimer?.(); this.cancelTimer = undefined;
  }

  public changed(): void {
    if (!this.active) return;
    const wasAcknowledged = this.revision <= this.acknowledged;
    this.revision++;
    // New immediate activity supersedes an idle recovery-only opportunity,
    // but cannot shorten an outstanding archive retry or delay a dirty batch.
    if (this.immediate && wasAcknowledged && this.cancelTimer !== undefined) {
      this.cancelTimer(); this.cancelTimer = undefined;
    }
    this.schedule(this.immediate ? 0 : this.intervalMs);
  }

  public acknowledge(revision: number): void {
    if (!this.active || !Number.isSafeInteger(revision) || revision < 1 || revision > this.revision) return;
    this.acknowledged = Math.max(this.acknowledged, revision); this.attempts = 0;
    this.cancelTimer?.(); this.cancelTimer = undefined;
    this.schedule(this.immediate && this.revision > this.acknowledged ? 0 : this.intervalMs);
  }

  /** Recovered PIDs have no child exit event. Reconcile only while such a
   * recordable job remains unresolved; live children do not require polling. */
  public setRecoveryPending(value: boolean): void { this.recoveryPending = value; }

  public status(): { pending: boolean; scheduled: boolean; flushing: boolean; recovery: boolean } {
    return { pending: this.active && this.revision > this.acknowledged, scheduled: this.cancelTimer !== undefined,
      flushing: this.active && this.flushing, recovery: this.active && this.recoveryPending };
  }

  private schedule(delayMs: number): void {
    if (!this.active || this.cancelTimer !== undefined || this.flushing || (this.revision <= this.acknowledged && !this.recoveryPending)) return;
    const epoch = this.epoch;
    this.cancelTimer = this.clock.schedule(delayMs, () => {
      if (!this.active || epoch !== this.epoch) return;
      this.cancelTimer = undefined;
      void this.flush(epoch);
    });
  }

  private async flush(epoch: number): Promise<void> {
    if (!this.active || epoch !== this.epoch || this.flushing) return;
    if (this.recoveryPending) this.revision++;
    this.flushing = true; this.attempts = Math.min(16, this.attempts + 1);
    try { await this.upload(this.revision); }
    catch { /* Local records are authoritative; retry only at the next bounded opportunity. */ }
    finally {
      if (this.active && epoch === this.epoch) {
        this.flushing = false;
        const delay = this.attempts === 0 ? (this.immediate && this.revision > this.acknowledged ? 0 : this.intervalMs)
          : Math.min(3_600_000, this.intervalMs * 2 ** Math.min(8, this.attempts - 1));
        this.schedule(delay);
      }
    }
  }
}
