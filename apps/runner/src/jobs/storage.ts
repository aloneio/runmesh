import { isErrno } from "./values.js";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, open, mkdir, rename, rm, readdir } from "node:fs/promises";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { JobFilePort } from "./ports.js";

// Recovery metadata is generated from bounded command/identity fields, but a
// corrupted or attacker-created file must not make startup allocate without a
// limit.  Eight MiB accommodates the legal worst-case UTF-8 command array
// while keeping recovery memory bounded.
export const MAX_METADATA_BYTES = 8 * 1024 * 1024;

export const METADATA_READ_CHUNK_BYTES = 64 * 1024;

export const NOFOLLOW = process.platform === "win32" ? 0 : constants.O_NOFOLLOW ?? 0;

/**
 * Ensure the state and jobs directories are real directories before any
 * metadata/log path is opened. The component-by-component walk also avoids
 * recursively creating through a symlinked ancestor. State roots provisioned
 * by the service manager may be group-readable (0750), but must never be
 * group/other writable; the jobs child is tightened to owner-only (0700).
 */
export async function ensureJobStorageDirectories(stateDir: string, jobsDir: string): Promise<void> {
  await ensureDirectoryPath(stateDir, "Runner state directory", false);
  await ensureDirectoryPath(jobsDir, "Runner jobs directory", true);
}

export async function ensureDirectoryPath(path: string, label: string, privateMode: boolean): Promise<void> {
  const normalized = resolve(path);
  const root = parse(normalized).root;
  const components = relative(root, normalized).split(sep).filter((part) => part.length > 0);
  let current = root;
  for (const component of components) {
    current = join(current, component);
    let info = await lstat(current).catch((error: unknown) => {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    });
    if (info === undefined) {
      await mkdir(current, { mode: 0o700 });
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw pathError(`${label} must be a regular directory`, "ENOTDIR");
    if (current === normalized && process.platform !== "win32") {
      if (!privateMode && (info.mode & 0o022) !== 0) throw new Error(`${label} is writable by group or others`);
      if (privateMode && (info.mode & 0o077) !== 0) {
        try { await chmod(current, 0o700); } catch { throw pathError(`${label} is not private`, "EPERM"); }
        const tightened = await lstat(current);
        if (!tightened.isDirectory() || tightened.isSymbolicLink() || (tightened.mode & 0o077) !== 0) throw pathError(`${label} is not private`, "EPERM");
      }
    }
  }
}



export function pathError(message: string, code: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/** Reject symlink/non-regular file substitutions while allowing first create. */
export async function assertRegularFile(path: string, allowMissing = true): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw pathError("state file is not a regular file", "ENOTDIR");
  } catch (error) {
    if (allowMissing && isErrno(error, "ENOENT")) return;
    throw error;
  }
}

export async function assertRegularDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw pathError("state parent is not a regular directory", "ENOTDIR");
}

export async function openJobLog(path: string, mode: "read" | "append"): Promise<Awaited<ReturnType<typeof open>>> {
  await assertRegularDirectory(dirname(path));
  await assertRegularFile(path);
  const flags = (mode === "read"
    ? constants.O_RDONLY | NOFOLLOW
    : constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | NOFOLLOW) | (constants.O_NONBLOCK ?? 0);
  const handle = await open(path, flags, 0o600);
  try {
    // lstat cannot prevent a regular-to-special-file swap before open. Do not
    // hand a pipe/device descriptor to either the log reader or the writer.
    const opened = await handle.stat();
    const current = await lstat(path);
    if (!opened.isFile() || !current.isFile() || current.isSymbolicLink() || opened.dev !== current.dev || opened.ino !== current.ino) {
      throw pathError("state file changed or is not a regular file", "ENOTDIR");
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function appendJobLog(path: string, data: Buffer): Promise<void> {
  const handle = await openJobLog(path, "append");
  try { await handle.writeFile(data); } finally { await handle.close(); }
}

export async function safeFileSize(path: string): Promise<number> {
  try {
    await assertRegularDirectory(dirname(path));
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink() ? info.size : 0;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return 0;
    return 0;
  }
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await assertRegularDirectory(dirname(path));
  await assertRegularFile(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, path);
  } finally {
    // Do not leave command metadata or partial snapshots behind when a disk
    // full/permission error interrupts the atomic replacement.
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function readJson<T>(path: string): Promise<T> {
  await assertRegularDirectory(dirname(path));
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw pathError("state file is not a regular file", "ENOTDIR");
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_METADATA_BYTES) throw metadataTooLarge(path);
    if (!sameMetadataStamp(before, info)) throw new Error("job metadata changed before reading");
    const chunks: Buffer[] = [];
    let total = 0;
    // Read in bounded chunks rather than FileHandle.readFile(), which allocates
    // based on the current file size.  The one-byte allowance detects a file
    // that grows beyond the initial stat between reads.
    for (;;) {
      const remaining = MAX_METADATA_BYTES - total;
      const buffer = Buffer.alloc(Math.min(METADATA_READ_CHUNK_BYTES, remaining + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_METADATA_BYTES) throw metadataTooLarge(path);
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    // Equal-size in-place writes can splice distinct JSON records just as a
    // truncate/append can. Bind the full observation and the final pathname,
    // so recovery rejects a snapshot when these observations detect a change.
    const final = await handle.stat();
    const current = await lstat(path);
    if (!final.isFile() || !current.isFile() || current.isSymbolicLink()
      || !sameMetadataStamp(info, final) || !sameMetadataStamp(info, current) || total !== info.size) {
      throw new Error("job metadata changed while being read");
    }
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as T;
  }
  finally { await handle.close(); }
}

function sameMetadataStamp(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export function metadataTooLarge(path: string): Error {
  const error = new Error(`job metadata exceeds ${MAX_METADATA_BYTES} bytes: ${path}`) as NodeJS.ErrnoException;
  error.code = "EFBIG";
  return error;
}

/** Native operations only: no queue, retries, record cache or startup I/O. */
export const nativeJobFiles: JobFilePort = Object.freeze({ ensureJobStorageDirectories, ensureDirectoryPath, openJobLog, appendJobLog, safeFileSize, atomicJson, readJson, lstat, rm, readdir });
