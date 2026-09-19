import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const invalid = () => new Error("invalid_or_changed_evidence_file");
function regular(info, limit) {
  return info.isFile() && !info.isSymbolicLink() && Number.isSafeInteger(info.size)
    && info.size > 0 && info.size <= limit;
}
function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

/** Read verification inputs through one regular-file descriptor. Limits apply
 * to bytes actually read, not just a prior path stat. O_NONBLOCK prevents FIFO
 * open waits; this is not a hard deadline for regular/network filesystem I/O.
 * Metadata checks detect observed changes, not an atomic content snapshot. */
export async function readBoundedEvidenceFile(path, limit = MAX_EVIDENCE_BYTES) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVIDENCE_BYTES) throw invalid();
  const before = await lstat(path);
  if (!regular(before, limit)) throw invalid();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const initial = await handle.stat();
    if (!regular(initial, limit) || !sameFile(before, initial)) throw invalid();
    const chunks = [];
    let total = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, limit + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > limit) throw invalid();
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (!regular(after, limit) || !sameFile(initial, after) || total !== initial.size) throw invalid();
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
}

export async function readEvidenceJson(path, limit = MAX_EVIDENCE_BYTES) {
  const bytes = await readBoundedEvidenceFile(path, limit);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
