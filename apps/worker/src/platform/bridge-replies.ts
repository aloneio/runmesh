import type { BridgeReply, BridgeReplyPort, BridgeWaiter } from "../contracts/runner-transport.js";

/** The single owner of pending replies; no timer, transport or I/O on construction. */
export class BridgeReplies implements BridgeReplyPort {
  private readonly pending = new Map<string, BridgeWaiter>();
  public get size(): number { return this.pending.size; }
  public register(requestId: string, waiter: BridgeWaiter): void { this.pending.set(requestId, waiter); }
  public forget(requestId: string): void { this.pending.delete(requestId); }
  public deliver(socket: WebSocket, reply: BridgeReply): void {
    const waiter = this.pending.get(reply.request_id);
    if (waiter === undefined || waiter.socket !== socket) return;
    clearTimeout(waiter.timer);
    this.pending.delete(reply.request_id);
    waiter.resolve(reply);
  }
  public reject(socket: WebSocket, reply: (requestId: string, socket: WebSocket) => BridgeReply): void {
    for (const [requestId, waiter] of this.pending) {
      if (waiter.socket !== socket) continue;
      clearTimeout(waiter.timer);
      this.pending.delete(requestId);
      waiter.resolve(reply(requestId, waiter.socket));
    }
  }
}
