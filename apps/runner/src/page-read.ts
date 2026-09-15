import type { FileHandle } from "node:fs/promises";
import { RpcRuntimeError } from "./errors.js";

/** Read only this page, tolerating OS short reads without an unbounded loop.
 * The caller freezes the requested length from fstat and checks the object
 * again before returning. This is not an atomic filesystem snapshot.
 */
export async function readPageBytes(handle: FileHandle, position: number, length: number, changedCode: "file_changed" | "log_changed"): Promise<Buffer> {
  if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length) || length < 0 || length > 256 * 1024 + 3) throw new RpcRuntimeError("invalid_params", "Invalid page read bounds");
  const buffer = Buffer.alloc(length);
  let used = 0;
  for (let attempt = 0; used < length && attempt < 32; attempt += 1) {
    const result = await handle.read(buffer, used, length - used, position + used);
    if (result.bytesRead === 0) throw new RpcRuntimeError(changedCode, "The byte source changed while this page was being read; request a fresh page");
    used += result.bytesRead;
  }
  if (used !== length) throw new RpcRuntimeError("read_budget_exhausted", "The page required too many partial reads; reduce the page size");
  return buffer;
}
