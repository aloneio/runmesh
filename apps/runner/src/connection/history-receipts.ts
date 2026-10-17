type HistoryStatus = "recorded" | "unchanged" | "disabled";

interface Pending<Socket> {
  readonly socket: Socket;
  readonly requestId: string;
  readonly snapshot: string;
  readonly revision?: number;
}

/** The matching authenticated session/request owns acknowledgement. A missing
 * or malformed receipt must never report the sync as persisted. */
export class HistoryReceiptTracker<Socket extends object> {
  private pending: Pending<Socket> | undefined;
  private acknowledged: string | undefined;

  public get lastSnapshot(): string | undefined { return this.acknowledged; }

  public reset(): void {
    this.pending = undefined;
    this.acknowledged = undefined;
  }

  public optimistic(snapshot: string): void { this.acknowledged = snapshot; }

  public track(socket: Socket, requestId: string, snapshot: string, revision?: number): void {
    this.pending = { socket, requestId, snapshot, ...(revision === undefined ? {} : { revision }) };
  }

  public accept(socket: Socket, requestId: string, result: unknown): { status: HistoryStatus | null; revision?: number } | null {
    const pending = this.pending;
    if (pending === undefined || pending.socket !== socket || pending.requestId !== requestId) return null;
    this.pending = undefined;
    if (typeof result !== "object" || result === null || Array.isArray(result)) return { status: null };
    const candidate = (result as { history_status?: unknown }).history_status;
    if (candidate !== "recorded" && candidate !== "unchanged" && candidate !== "disabled") return { status: null };
    this.acknowledged = pending.snapshot;
    return { status: candidate, ...(pending.revision === undefined ? {} : { revision: pending.revision }) };
  }
}
