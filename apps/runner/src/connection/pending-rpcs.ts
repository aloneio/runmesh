/** Owns the pending control/RPC requests and their timeout lifecycle.
 * The calling connection retains transport generation and authorization checks. */
export class PendingRpcRegistry {
  private readonly entries = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  public register(id: string, resolve: (value: unknown) => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout>): void {
    if (this.entries.has(id)) throw new Error("duplicate pending RPC");
    this.entries.set(id, { resolve, reject, timer });
  }

  private take(id: string) {
    const entry = this.entries.get(id);
    if (entry !== undefined) {
      this.entries.delete(id);
      clearTimeout(entry.timer);
    }
    return entry;
  }

  public resolve(id: string, value: unknown): void {
    this.take(id)?.resolve(value);
  }

  public reject(id: string, error: Error): void {
    this.take(id)?.reject(error);
  }

  public rejectAll(error: Error): void {
    for (const id of this.entries.keys()) this.reject(id, error);
  }
}
