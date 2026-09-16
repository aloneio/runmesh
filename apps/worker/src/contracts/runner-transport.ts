import type { WireMessage } from "@aloneio/runmesh-protocol";

export type RegistryRequestPort = (runnerId: string, action: string, init: RequestInit) => Promise<Response>;
export type BridgeReply = Extract<WireMessage, { type: "rpc.response" | "rpc.error" }>;
export interface BridgeWaiter {
  readonly resolve: (value: BridgeReply) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly socket: WebSocket;
}
/** Request deadlines remain owned by the dispatcher. All methods are synchronous. */
export interface BridgeReplyPort {
  readonly size: number;
  register(requestId: string, waiter: BridgeWaiter): void;
  forget(requestId: string): void;
  deliver(socket: WebSocket, reply: BridgeReply): void;
  reject(socket: WebSocket, reply: (requestId: string, socket: WebSocket) => BridgeReply): void;
}
