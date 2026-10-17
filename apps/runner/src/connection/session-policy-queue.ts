/** A policy candidate waits only behind candidates for its own socket.
 * Failures are consumed so a failed candidate cannot poison later delivery.
 * The caller retains generation/authorization checks after its awaits. */
export class SessionPolicyQueue<Socket extends object> {
  private readonly tails = new WeakMap<Socket, Promise<void>>();

  public enqueue(socket: Socket, apply: () => Promise<void>): void {
    const previous = this.tails.get(socket) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(apply);
    this.tails.set(socket, next.catch(() => undefined));
  }
}
