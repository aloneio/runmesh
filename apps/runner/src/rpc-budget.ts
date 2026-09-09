import { encodeWireFrame, PROTOCOL_CURRENT_VERSION, type JsonValue } from "@aloneio/runmesh-protocol";
import { RpcRuntimeError } from "./errors.js";

// Keep ordinary results below both the wire cap and the MCP structured cap,
// including room for the MCP envelope and runner_context.
export const MAX_RPC_RESULT_BYTES = 48 * 1024;
export function jsonBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
export function assertRpcResultFits(value: unknown, maxBytes = MAX_RPC_RESULT_BYTES): void {
  try {
    if (jsonBytes(value) > maxBytes) throw new Error("result budget exceeded");
    encodeWireFrame({ type: "rpc.response", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: "r".repeat(128), result: value as JsonValue });
  } catch {
    throw new RpcRuntimeError("file_too_large", "result exceeds the safe response budget; split the operation before retrying");
  }
}

// One queue for all PatchService instances in this process. Lock canonical
// workspace roots rather than client/operation IDs. Preparation may overlap;
// revalidation, filesystem commit and recovery may not.
const commitQueues = new Map<string, { tail: Promise<void>; count: number }>();
export async function withPatchCommitLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const key = process.platform === "win32" ? root.toLowerCase() : root;
  let queue = commitQueues.get(key);
  if (queue === undefined) { queue = { tail: Promise.resolve(), count: 0 }; commitQueues.set(key, queue); }
  if (queue.count >= 32) throw new RpcRuntimeError("busy", "workspace patch queue is full");
  queue.count += 1;
  const prior = queue.tail;
  let release!: () => void;
  queue.tail = new Promise<void>((resolve) => { release = resolve; });
  await prior;
  try { return await action(); }
  finally { release(); queue.count -= 1; if (queue.count === 0) commitQueues.delete(key); }
}
