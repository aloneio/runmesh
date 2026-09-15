import { createHash, randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { isBoundCursor } from "@aloneio/runmesh-protocol";
import { RpcRuntimeError } from "./errors.js";
import { readPageBytes } from "./page-read.js";

const TTL_MS = 5 * 60 * 1000;
export const MAX_FILE_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_CAPTURE_CONCURRENCY = 4;
type Entry<T> = { readonly id: string; readonly scope: string; readonly value: T; readonly bytes: number; readonly deadline: number; readonly expiresAt: number };

/** Lazy expiry and process-wide LRU budgets. No filesystem writes, retained
 * handles, watchers or timers. In-flight users must recheck before return. */
export class CursorCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private bytes = 0;
  public constructor(private readonly maxEntries: number, private readonly maxBytes: number, private readonly ttlMs = TTL_MS) {
    if (![maxEntries, maxBytes, ttlMs].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error("Invalid cursor cache budget");
  }
  public put(scope: string, value: T, bytes: number): Entry<T> {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maxBytes) throw new RpcRuntimeError("snapshot_too_large", "Snapshot exceeds the cache budget");
    this.expire();
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) this.delete(this.entries.keys().next().value as string);
    const entry = { id: randomBytes(32).toString("hex"), scope, value, bytes, deadline: performance.now() + this.ttlMs, expiresAt: Date.now() + this.ttlMs };
    this.entries.set(entry.id, entry); this.bytes += bytes; return entry;
  }
  public get(id: string, scope: string): Entry<T> {
    this.expire(); const entry = this.entries.get(id);
    if (entry === undefined) throw new RpcRuntimeError("cursor_expired", "The cursor expired, was evicted or belongs to a previous Runner process; start a new bounded read");
    if (entry.scope !== scope) throw new RpcRuntimeError("cursor_mismatch", "The cursor does not belong to this resource or policy generation");
    this.entries.delete(id); this.entries.set(id, entry); return entry;
  }
  public delete(id: string): void { const entry = this.entries.get(id); if (entry !== undefined) { this.entries.delete(id); this.bytes -= entry.bytes; } }
  public stats(): { entries: number; bytes: number } { this.expire(); return { entries: this.entries.size, bytes: this.bytes }; }
  private expire(): void { const now = performance.now(); for (const [id, entry] of this.entries) if (now >= entry.deadline) this.delete(id); }
}

export function boundPageRequest(params: Record<string, unknown>, kind: "file" | "log") {
  const mode = kind === "file" ? "snapshot" : "append";
  if (params.consistency !== undefined && params.consistency !== "live" && params.consistency !== mode) throw invalid();
  const cursor = params.cursor;
  if (isBoundCursor(cursor, kind)) {
    if (params.offset !== undefined || params.tail === true || params.consistency === "live") throw invalid();
    const [, id, position] = cursor.split(":");
    return { bound: true, id: id as string, offset: Number(position) };
  }
  if (cursor !== undefined && (typeof cursor !== "string" || cursor.length > 128 || !/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) throw invalid();
  if (params.consistency === mode && cursor !== undefined) throw invalid();
  return { bound: params.consistency === mode, id: undefined, offset: undefined };
}
function invalid(): RpcRuntimeError { return new RpcRuntimeError("invalid_params", "Use a cursor for this resource, without offset, tail or a contradictory consistency mode"); }
export function boundCursor(kind: "file" | "log", id: string, offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0) throw invalid();
  return `${kind === "file" ? "f1" : "l1"}:${id}:${offset}`;
}
export function bindBytePage(page: Record<string, unknown>, entry: { id: string; expiresAt: number }, kind: "file" | "log", snapshotId: string): Record<string, unknown> {
  const offset = page.resume_offset as number;
  const cursor = boundCursor(kind, entry.id, offset);
  return { ...page, page_protocol: 2, consistency: kind === "file" ? "snapshot" : "append", snapshot_id: snapshotId,
    next_cursor: page.page_state === "more" ? cursor : null, resume_cursor: cursor, cursor_expires_at_ms: entry.expiresAt };
}

export function fileObservation(info: Stats): string {
  return JSON.stringify([info.dev, info.ino, info.birthtimeMs, info.size, info.mtimeMs, info.ctimeMs, info.mode, info.uid, info.gid]);
}
type FileSnapshot = { readonly data: Buffer; readonly hash: string; readonly observation: string };
export const fileSnapshots = new CursorCache<FileSnapshot>(16, 8 * 1024 * 1024);
let captures = 0;
export async function captureFile(handle: FileHandle, info: Stats): Promise<FileSnapshot> {
  if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > MAX_FILE_SNAPSHOT_BYTES) throw new RpcRuntimeError("snapshot_too_large", "File snapshots are limited to 1 MiB; use explicitly live pages for larger files");
  if (captures >= MAX_CAPTURE_CONCURRENCY) throw new RpcRuntimeError("busy", "Too many concurrent file snapshot captures");
  captures += 1;
  try {
    const data = Buffer.alloc(info.size); let offset = 0; const deadline = performance.now() + 2000;
    for (let reads = 0; offset < data.length && reads < 64 && performance.now() < deadline; reads += 1) {
      const part = await handle.read(data, offset, Math.min(64 * 1024, data.length - offset), offset);
      if (part.bytesRead === 0) throw new RpcRuntimeError("file_changed", "File changed during snapshot capture");
      offset += part.bytesRead;
    }
    if (offset !== data.length) throw new RpcRuntimeError("read_budget_exhausted", "Snapshot capture exhausted its read budget");
    return { data, hash: createHash("sha256").update(data).digest("hex"), observation: fileObservation(info) };
  } finally { captures -= 1; }
}

type LogObservation = { readonly identity: string; readonly size: number; readonly mtime: number; readonly ctime: number; readonly prefix: string; readonly boundary: string };
export const logGenerations = new CursorCache<LogObservation>(256, 256 * 1024);
const ANCHOR_BYTES = 256;
function logIdentity(info: Stats): string { return JSON.stringify([info.dev, info.ino, info.birthtimeMs, info.mode, info.uid, info.gid]); }
async function logAnchors(handle: FileHandle, size: number): Promise<{ prefix: string; boundary: string }> {
  const length = Math.min(size, ANCHOR_BYTES);
  const first = await readPageBytes(handle, 0, length, "log_changed");
  const last = size <= ANCHOR_BYTES ? first : await readPageBytes(handle, size - length, length, "log_changed");
  const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
  return { prefix: digest(first), boundary: digest(last) };
}
export async function observeLog(handle: FileHandle, info: Stats): Promise<LogObservation> {
  return { identity: logIdentity(info), size: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs, ...await logAnchors(handle, info.size) };
}
/** Detect identity replacement, observed truncation and changed boundary
 * anchors while allowing append. This is not a hash of all historical output
 * and cannot attest to arbitrary same-inode interior edits by a host writer. */
export async function verifyLogGeneration(handle: FileHandle, info: Stats, previous: LogObservation): Promise<void> {
  if (logIdentity(info) !== previous.identity || info.size < previous.size || (info.size === previous.size && (info.mtimeMs !== previous.mtime || info.ctimeMs !== previous.ctime))) throw changedLog();
  const anchors = await logAnchors(handle, previous.size);
  if (anchors.prefix !== previous.prefix || anchors.boundary !== previous.boundary) throw changedLog();
}
export function changedLog(): RpcRuntimeError { return new RpcRuntimeError("log_changed", "Log generation or retained boundary changed; start a fresh read instead of joining output"); }
