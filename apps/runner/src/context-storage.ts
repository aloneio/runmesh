import type { ContextStorageLimits, Stamp, ContextStorageFile, ContextStorageInventory } from "./context/storage-types.js";
export type { ContextStorageLimits, ContextStorageFile, ContextStorageInventory } from "./context/storage-types.js";
import { createHash } from "node:crypto";
import { lstat, opendir } from "node:fs/promises";
import { join, parse, relative, resolve, sep } from "node:path";
import { RpcRuntimeError } from "./errors.js";

/** Logical revision-file bytes, not filesystem allocated blocks or total disk.
 * The index is separately bounded to 2 MiB by ContextStore. No timers/writes. */
export const CONTEXT_STORAGE_LIMITS = Object.freeze({ maxBytes: 32 * 1024 * 1024, maxRecords: 4096, maxContexts: 256 });

export function contextStorageLimits(input: Partial<ContextStorageLimits> = {}): ContextStorageLimits {
  if (typeof input !== "object" || input === null || Array.isArray(input) || Object.keys(input).some(key => !Object.hasOwn(CONTEXT_STORAGE_LIMITS, key))) throw new Error("Invalid Context storage limits");
  const result = { ...CONTEXT_STORAGE_LIMITS, ...input };
  for (const key of Object.keys(CONTEXT_STORAGE_LIMITS) as (keyof ContextStorageLimits)[]) if (!Number.isSafeInteger(result[key]) || result[key] < 1 || result[key] > CONTEXT_STORAGE_LIMITS[key]) throw new Error("Context storage limits can only lower the bounded defaults");
  return Object.freeze(result);
}



export function sameStorageStamp(a: Stamp, b: Stamp): boolean { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs; }
function stamp(value: Stamp): Stamp { return { dev: value.dev, ino: value.ino, size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs }; }
const unsafe = () => new RpcRuntimeError("context_storage_unsafe", "Context storage contains an unsafe or unrecognized entry; preserve it for operator inspection");
function absent(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }

/** Check every ancestor, not just the last parent. Do not create or chmod. */
export async function checkContextDirectory(path: string): Promise<void> {
  const normalized = resolve(path), root = parse(normalized).root;
  let current = root;
  for (const component of relative(root, normalized).split(sep).filter(Boolean)) {
    current = join(current, component); const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw unsafe();
    if (current === normalized && process.platform !== "win32" && (info.mode & 0o077) !== 0) throw unsafe();
  }
}
export async function verifyContextStorageFile(workspace: string, file: ContextStorageFile): Promise<void> {
  const directory = join(workspace, file.contextId);
  await checkContextDirectory(directory);
  const info = await lstat(join(directory, `${file.revision}.json`));
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !sameStorageStamp(info, file.stamp)) throw new RpcRuntimeError("context_plan_changed", "Context files changed since the retention preview; create a fresh preview");
}

/** One bounded two-level metadata walk. Old over-limit stores remain
 * inspectable up to the hard scan budget; no implicit eviction or deletion. */
export async function scanContextStorage(workspace: string): Promise<ContextStorageInventory> {
  try { await checkContextDirectory(workspace); } catch (error) {
    if (absent(error)) return { exists: false, files: [], contexts: 0, bytes: 0, metadataBytes: 0, pending: false, digest: createHash("sha256").update("missing").digest("hex") };
    throw error;
  }
  const files: ContextStorageFile[] = [], metadata: unknown[] = [], directories: { path: string; info: Stamp }[] = [];
  let entries = 0, bytes = 0, metadataBytes = 0, contexts = 0, pending = false;
  const deadline = performance.now() + 4000;
  const budget = () => { if (++entries > 16384 || files.length > 8192 || contexts > 1024 || performance.now() > deadline) throw new RpcRuntimeError("context_scan_budget", "Context storage inventory exceeded its bounded scan; no data was changed"); };
  directories.push({ path: workspace, info: stamp(await lstat(workspace)) });
  for await (const item of await opendir(workspace)) {
    budget(); const path = join(workspace, item.name), info = await lstat(path);
    if (item.name === "index.json" || item.name === ".pending-checkpoint.json") {
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > (item.name === "index.json" ? 2 * 1024 * 1024 : 4096)) throw unsafe();
      metadata.push([item.name, stamp(info)]); metadataBytes += info.size; pending ||= item.name === ".pending-checkpoint.json"; continue;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(item.name) || !info.isDirectory() || info.isSymbolicLink()) throw unsafe();
    await checkContextDirectory(path); contexts += 1; directories.push({ path, info: stamp(info) });
    for await (const revision of await opendir(path)) {
      budget();
      if (!/^[1-9]\d{0,15}\.json$/u.test(revision.name)) throw unsafe();
      const number = Number(revision.name.slice(0, -5)), record = await lstat(join(path, revision.name));
      if (!Number.isSafeInteger(number) || !record.isFile() || record.isSymbolicLink() || record.nlink !== 1 || record.size > 64 * 1024) throw unsafe();
      files.push({ contextId: item.name, revision: number, stamp: stamp(record) }); bytes += record.size;
    }
  }
  budget();
  for (const directory of directories) if (!sameStorageStamp(directory.info, await lstat(directory.path))) throw new RpcRuntimeError("context_plan_changed", "Context storage changed during inventory; retry the read-only preview");
  files.sort((a, b) => a.contextId < b.contextId ? -1 : a.contextId > b.contextId ? 1 : a.revision - b.revision);
  metadata.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const digest = createHash("sha256").update(JSON.stringify({ files, metadata, contexts, directoryIdentities: directories.map(item => [relative(workspace, item.path), item.info.dev, item.info.ino]).sort() })).digest("hex");
  return { exists: true, files, contexts, bytes, metadataBytes, pending, digest };
}

export function contextStorageSummary(inventory: ContextStorageInventory, limits: ContextStorageLimits): Record<string, unknown> {
  return { storage_schema: 1, state: inventory.exists ? "ready" : "missing", record_files: inventory.files.length,
    record_bytes: inventory.bytes, context_count: inventory.contexts, metadata_bytes: inventory.metadataBytes,
    limit_bytes: limits.maxBytes, limit_records: limits.maxRecords, limit_contexts: limits.maxContexts,
    over_limit: inventory.bytes > limits.maxBytes || inventory.files.length > limits.maxRecords || inventory.contexts > limits.maxContexts,
    pending_checkpoint: inventory.pending, accounting: "logical_revision_bytes" };
}
