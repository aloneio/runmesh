/** A pending reconfirmation marker is not policy or authorization evidence.
 * Retry is driven only by a completed low-frequency heartbeat persistence turn;
 * the caller must re-read desired policy and verify the exact current session. */
export class RunnerPolicyRecovery {
  private readonly pending = new WeakMap<WebSocket, string | undefined>();
  private readonly inFlight = new WeakSet<WebSocket>();

  public begin(socket: WebSocket): string {
    const generation = crypto.randomUUID();
    this.write(socket, generation);
    return generation;
  }

  public complete(socket: WebSocket, generation: string): void {
    if (this.read(socket) === generation) this.write(socket, undefined);
  }

  public async retry(socket: WebSocket, reconfirm: () => Promise<void>): Promise<void> {
    if (this.read(socket) === undefined || this.inFlight.has(socket)) return;
    this.inFlight.add(socket);
    try { await reconfirm(); }
    finally { this.inFlight.delete(socket); }
    // Sending a policy is not a receipt. Only its normal verified ACK path
    // may clear the generation, including after hibernation or overlapping ACKs.
  }

  private read(socket: WebSocket): string | undefined {
    if (this.pending.has(socket)) return this.pending.get(socket);
    try {
      const value = socket.deserializeAttachment()?.policyAckRecovery;
      return typeof value === "string" && /^[a-f0-9-]{36}$/.test(value) ? value : undefined;
    } catch { return undefined; }
  }

  private write(socket: WebSocket, generation: string | undefined): void {
    this.pending.set(socket, generation);
    try {
      const latest = socket.deserializeAttachment();
      if (typeof latest !== "object" || latest === null || Array.isArray(latest)) return;
      const next = { ...latest };
      if (generation === undefined) delete next.policyAckRecovery;
      else next.policyAckRecovery = generation;
      socket.serializeAttachment(next);
    } catch { /* The local marker remains usable without a database write. */ }
  }
}
