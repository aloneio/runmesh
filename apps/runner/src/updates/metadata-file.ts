import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { UpdateFailure } from "./contracts.js";

interface MetadataReadOptions {
  readonly maxBytes: number;
  readonly errorCode: "local_state_invalid" | "invalid_installation";
}

/** Read the exact file admitted by a maintenance caller. Directory ownership,
 * permission policy and absent-file semantics remain with that caller; object
 * identity, bounded reads and replacement checks have one implementation. */
export async function readMetadataJson(path: string, expected: Stats, options: MetadataReadOptions): Promise<unknown> {
  const invalid = () => new UpdateFailure(options.errorCode);
  if (!expected.isFile() || expected.isSymbolicLink() || expected.size <= 0 || expected.size > options.maxBytes) throw invalid();
  // Nonblocking opens let a regular-to-FIFO replacement reach the descriptor
  // check even when no writer exists. Symlinks are rejected by the OS or by
  // the identity checks on platforms without O_NOFOLLOW.
  const handle = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino || opened.size !== expected.size) throw invalid();
    const bytes = Buffer.alloc(expected.size + 1); let offset = 0;
    while (offset < bytes.length) {
      const part = await handle.read(bytes, offset, bytes.length - offset, null);
      if (part.bytesRead === 0) break;
      offset += part.bytesRead;
    }
    const after = await handle.stat(); const current = await lstat(path);
    if (offset !== expected.size || after.size !== expected.size || after.mtimeMs !== opened.mtimeMs
      || current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino) throw invalid();
    return JSON.parse(bytes.subarray(0, offset).toString("utf8"));
  } finally { await handle.close(); }
}
