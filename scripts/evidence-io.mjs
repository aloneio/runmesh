import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

/** CI projections own names and serialization; this adapter owns publication.
 * Each file replaces its previous attempt through a private temporary file. */
export async function writeCiEvidenceFile(root, name, body) {
  assert.match(name, /^[a-z][a-z0-9_-]{0,63}\.(?:json|xml)$/u);
  const directory = join(root, "ci-results");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const folder = await lstat(directory);
  assert.ok(folder.isDirectory() && !folder.isSymbolicLink(), "unsafe report directory");
  const target = join(directory, name), temporary = join(directory, `${randomUUID()}.tmp`);
  const current = await lstat(target).catch(error => { if (error.code !== "ENOENT") throw error; });
  assert.ok(current === undefined || current.isFile() && !current.isSymbolicLink(), "unsafe existing report");
  try { await writeFile(temporary, body, { flag: "wx", mode: 0o600 }); await rename(temporary, target); }
  finally { await rm(temporary, { force: true }); }
}

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
