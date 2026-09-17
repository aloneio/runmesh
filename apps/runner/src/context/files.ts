import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, opendir, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { RpcRuntimeError } from "../errors.js";
import { sameStorageStamp, checkContextDirectory } from "../context-storage.js";
import { isErrno, conflict } from "./model.js";
import type { ContextFilePort } from "./ports.js";

export const NOFOLLOW = process.platform === "win32" ? 0 : constants.O_NOFOLLOW ?? 0;

export async function readJsonBounded(path: string, maxBytes: number): Promise<{ readonly value: unknown; readonly bytes: number; readonly sha256: string }> {
  await assertRegularParent(path);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new RpcRuntimeError("context_record_corrupt", "context file is not a bounded regular file");
  // The descriptor stamp below is meaningful only if a substituted FIFO
  // cannot block open before that validation runs.
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  try {
    const finalInfo = await handle.stat();
    if (!finalInfo.isFile() || !sameStorageStamp(info, finalInfo) || finalInfo.size > maxBytes) throw new RpcRuntimeError("context_record_corrupt", "context file changed or exceeds its budget");
    const data = Buffer.alloc(finalInfo.size);
    let offset = 0;
    let attempts = 0;
    while (offset < data.byteLength) {
      if (++attempts > 64) throw new RpcRuntimeError("context_scan_budget", "Context read exceeded its bounded partial-read attempts");
      const { bytesRead } = await handle.read(data, offset, data.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (!sameStorageStamp(after, finalInfo) || offset !== data.byteLength) throw new RpcRuntimeError("context_record_corrupt", "context file changed while reading");
    let value: unknown;
    try { value = JSON.parse(data.toString("utf8")); } catch { throw new RpcRuntimeError("context_record_corrupt", "Context record is not valid JSON"); }
    return { value, bytes: data.byteLength, sha256: createHash("sha256").update(data).digest("hex") };
  } finally { await handle.close(); }
}

export async function writeImmutable(path: string, data: string, assertAuthorized: () => void): Promise<void> {
  await assertRegularParent(path);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    assertAuthorized();
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    created = true;
    assertAuthorized();
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    if (isErrno(error, "EEXIST")) throw conflict("context_revision_conflict", "context revision already exists");
    if (created) await rm(path, { force: true }).catch(() => undefined);
    throw error;
  } finally { await handle?.close().catch(() => undefined); }
}

export async function atomicReplace(path: string, data: string, assertAuthorized: () => void): Promise<void> {
  await assertRegularParent(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    assertAuthorized();
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}

export async function ensurePrivateDirectory(path: string, privateMode = true): Promise<void> {
  const normalized = resolve(path);
  const root = parse(normalized).root;
  const components = relative(root, normalized).split(sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = join(current, component);
    let info = await lstat(current).catch((error: unknown) => isErrno(error, "ENOENT") ? undefined : Promise.reject(error));
    if (info === undefined) { await mkdir(current, { mode: 0o700 }); info = await lstat(current); }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new RpcRuntimeError("context_storage_unsafe", "context state directory is not a regular directory");
    if (current === normalized && process.platform !== "win32") {
      if (!privateMode && (info.mode & 0o022) !== 0) throw new RpcRuntimeError("context_storage_unsafe", "Runner state directory is writable by group or others");
      if (privateMode && (info.mode & 0o077) !== 0) {
        await chmod(current, 0o700);
        const tightened = await lstat(current);
        if ((tightened.mode & 0o077) !== 0) throw new RpcRuntimeError("context_storage_unsafe", "context directory could not be made private");
      }
    }
  }
}

export async function assertPrivateDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new RpcRuntimeError("context_storage_unsafe", `${label} is not a regular directory`);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new RpcRuntimeError("context_storage_unsafe", `${label} is not private`);
}

export async function assertRegularParent(path: string): Promise<void> {
  await checkContextDirectory(dirname(path));
}

export async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (isErrno(error, "ENOENT")) return false; throw error; }
}

/** No implicit directory creation, retries, caches or background work. */
export const nativeContextFiles: ContextFilePort = Object.freeze({ readJsonBounded, writeImmutable, atomicReplace, ensurePrivateDirectory, assertPrivateDirectory, pathExists, opendir, rm });
