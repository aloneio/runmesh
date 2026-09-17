import type { Baseline } from "./contracts.js";
import { basename } from "node:path";
import { conflict } from "./values.js";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { hash } from "./values.js";
import type { InstallState } from "./contracts.js";
import { isErrno } from "./values.js";
import { join } from "node:path";
import { link } from "node:fs/promises";
import { lstat } from "node:fs/promises";
import { MAX_PATH_ATTEMPTS } from "./limits.js";
import { MAX_TEXT_FILE_BYTES } from "./limits.js";
import { message } from "./values.js";
import { open } from "node:fs/promises";
import type { ParentBoundary } from "./contracts.js";
import { PathPolicy } from "../path-policy.js";
import type { PathSnapshot } from "../path-policy.js";
import { randomUUID } from "node:crypto";
import { rename } from "node:fs/promises";
import type { ResolvedPath } from "./contracts.js";
import type { ResolvedPolicyPath } from "./contracts.js";
import { rm } from "node:fs/promises";
import { RpcRuntimeError } from "../errors.js";
import type { TargetBoundary } from "./contracts.js";
import { win32 } from "node:path";

export async function captureBaseline(path: ResolvedPath, policy?: PathPolicy): Promise<Baseline> {
  const parentBoundary = policy === undefined ? undefined : await captureParentBoundary(policy, path);
  let targetBoundary: TargetBoundary | undefined;
  const targetResolved: ResolvedPolicyPath | undefined = policy === undefined ? undefined : { workspace: policy.getWorkspace(path.workspaceId), path: path.path };
  if (policy !== undefined) {
    try {
      const snapshot = await policy.snapshot(targetResolved as ResolvedPolicyPath);
      targetBoundary = { resolved: targetResolved as ResolvedPolicyPath, snapshot };
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }
  try {
    const opened = await readRegularFileCapped(path.path, path.relativePath, policy, parentBoundary, targetBoundary, targetResolved);
    const finalTargetSnapshot = opened.targetSnapshot ?? targetBoundary?.snapshot;
    const finalTargetBoundary = targetResolved === undefined || finalTargetSnapshot === undefined
      ? undefined
      : { resolved: targetResolved, snapshot: finalTargetSnapshot };
    return {
      path, exists: true, hash: hash(opened.bytes), mode: opened.mode, size: opened.size, bytes: opened.bytes,
      ...(parentBoundary === undefined ? {} : { parentBoundary }),
      ...(finalTargetBoundary === undefined ? {} : { targetBoundary: finalTargetBoundary }),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      if (policy !== undefined) await verifyParentBoundary(policy, parentBoundary);
      return {
        path, exists: false, hash: null, mode: null, size: null,
        ...(parentBoundary === undefined ? {} : { parentBoundary }),
      };
    }
    if (code === "ELOOP") throw new RpcRuntimeError("symlink_write", `symlink paths are not allowed: ${path.relativePath}`);
    throw error;
  }
}

async function readRegularFileCapped(
  path: string,
  relativePath: string,
  policy?: PathPolicy,
  parentBoundary?: ParentBoundary,
  targetBoundary?: TargetBoundary,
  targetResolved?: ResolvedPolicyPath,
): Promise<{ readonly bytes: Buffer; readonly mode: number; readonly size: number; readonly targetSnapshot?: PathSnapshot }> {
  const handle = await openNoFollow(path);
  try {
    const info = await handle.stat();
    if (policy !== undefined) await verifyParentBoundary(policy, parentBoundary);
    let targetSnapshot = targetBoundary?.snapshot;
    if (policy !== undefined && targetResolved !== undefined) {
      // Always perform a post-open target snapshot, even when the initial
      // target was absent. This prevents a Windows leaf symlink created in the
      // lstat/open interval from being followed as an apparently new file.
      const currentTarget = await policy.snapshot(targetResolved);
      if (targetBoundary !== undefined && !sameSnapshotIdentity(currentTarget, targetBoundary.snapshot)) {
        throw new RpcRuntimeError("path_changed", `file changed while it was opened: ${relativePath}`);
      }
      targetSnapshot = currentTarget;
    }
    if (targetSnapshot !== undefined && (info.dev !== targetSnapshot.device || info.ino !== targetSnapshot.inode)) {
      throw new RpcRuntimeError("path_changed", `file changed while it was opened: ${relativePath}`);
    }
    if (!info.isFile()) throw new RpcRuntimeError("invalid_path", `path is not a regular file: ${relativePath}`);
    // Inspect through the opened descriptor before allocating. This prevents a
    // large file swapped in after a path lstat from bypassing the cap.
    if (info.size > MAX_TEXT_FILE_BYTES) throw new RpcRuntimeError("file_too_large", `file exceeds ${MAX_TEXT_FILE_BYTES} bytes: ${relativePath}`);
    const buffer = Buffer.allocUnsafe(MAX_TEXT_FILE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_TEXT_FILE_BYTES) throw new RpcRuntimeError("file_too_large", `file exceeds ${MAX_TEXT_FILE_BYTES} bytes: ${relativePath}`);
    return { bytes: Buffer.from(buffer.subarray(0, offset)), mode: info.mode & 0o7777, size: offset, ...(targetSnapshot === undefined ? {} : { targetSnapshot }) };
  } finally {
    await handle.close();
  }
}

async function openNoFollow(path: string): Promise<Awaited<ReturnType<typeof open>>> {
  try {
    // O_NOFOLLOW closes the final-component race on POSIX. Windows has no
    // portable Node flag for this, so lstat is retained as a best-effort leaf
    // guard and the parent snapshot is verified around every operation.
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new RpcRuntimeError("symlink_write", "symlink paths are not allowed");
    if (!info.isFile()) throw new RpcRuntimeError("invalid_path", "path is not a regular file");
    // A FIFO substituted after lstat must not strand a filesystem worker before
    // the descriptor/type and path-identity checks in readRegularFileCapped.
    return await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (error instanceof RpcRuntimeError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new RpcRuntimeError("symlink_write", "symlink paths are not allowed");
    throw error;
  }
}

async function captureParentBoundary(policy: PathPolicy, path: ResolvedPath): Promise<ParentBoundary> {
  const parentRelative = dirname(path.relativePath).replace(/\\/g, "/") || ".";
  let resolved: Awaited<ReturnType<PathPolicy["resolve"]>>;
  try {
    resolved = await policy.resolve(path.workspaceId, parentRelative, "write");
  } catch (error) {
    if (isErrno(error, "ENOENT")) throw conflict("invalid_path", "target parent directory does not exist", { path: path.relativePath });
    throw error;
  }
  let snapshot: PathSnapshot;
  try {
    snapshot = await policy.snapshot(resolved);
  } catch (error) {
    if (isErrno(error, "ENOENT")) throw conflict("invalid_path", "target parent directory does not exist", { path: path.relativePath });
    throw error;
  }
  if (snapshot.type !== "directory") throw conflict("invalid_path", `target parent directory is not a directory: ${parentRelative}`, { path: path.relativePath });
  return { resolved, snapshot };
}

export async function verifyParentBoundary(policy: PathPolicy | undefined, boundary: ParentBoundary | undefined): Promise<void> {
  if (policy !== undefined && boundary !== undefined) await policy.verifySnapshot(boundary.resolved, boundary.snapshot);
}

export async function verifyTargetBoundary(policy: PathPolicy | undefined, boundary: TargetBoundary | undefined): Promise<void> {
  if (policy !== undefined && boundary !== undefined) await policy.verifySnapshot(boundary.resolved, boundary.snapshot);
}

export function sameBaseline(left: Baseline, right: Baseline): boolean {
  return left.exists === right.exists && left.hash === right.hash && left.mode === right.mode && left.size === right.size
    && sameParentBoundary(left.parentBoundary, right.parentBoundary)
    && sameParentBoundary(left.targetBoundary, right.targetBoundary);
}

function sameParentBoundary(left: ParentBoundary | undefined, right: ParentBoundary | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return sameSnapshotIdentity(left.snapshot, right.snapshot);
}

function sameSnapshotIdentity(left: PathSnapshot, right: PathSnapshot): boolean {
  return sameCanonicalPath(left.canonicalPath, right.canonicalPath)
    && left.device === right.device && left.inode === right.inode
    && (left.rootCanonicalPath === undefined || right.rootCanonicalPath === undefined || sameCanonicalPath(left.rootCanonicalPath, right.rootCanonicalPath))
    && (left.rootDevice === undefined || right.rootDevice === undefined || left.rootDevice === right.rootDevice)
    && (left.rootInode === undefined || right.rootInode === undefined || left.rootInode === right.rootInode);
}

function sameCanonicalPath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase()
    : left === right;
}

export async function writeTemporary(target: string, bytes: Buffer, mode: number, policy?: PathPolicy, parentBoundary?: ParentBoundary): Promise<string> {
  // Anchor temporary creation to the canonical parent captured with the
  // baseline. If the lexical ancestor is replaced by a junction between the
  // check and open(), this path either remains the original directory or fails
  // closed; it cannot silently create the staging file in the junction target.
  const anchoredTarget = anchoredPath(target, parentBoundary);
  const temporary = `${anchoredTarget}.runmesh-${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), mode);
  try {
    if (policy !== undefined) await verifyParentBoundary(policy, parentBoundary);
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close();
  }
  return temporary;
}

export async function moveToBackup(target: string, policy?: PathPolicy, parentBoundary?: ParentBoundary, targetBoundary?: TargetBoundary): Promise<string> {
  const anchoredTarget = anchoredPath(target, parentBoundary);
  for (let attempt = 0; attempt < MAX_PATH_ATTEMPTS; attempt += 1) {
    const backupPath = backupName(anchoredTarget);
    let linked = false;
    try {
      if (policy !== undefined) await verifyParentBoundary(policy, parentBoundary);
      await verifyTargetBoundary(policy, targetBoundary);
      // link(2) creates the backup exclusively, unlike rename which would
      // silently replace a pre-existing (possibly attacker-created) name.
      // The source and backup share the same parent/filesystem, so this is a
      // durable equivalent to moving the original before installation.
      await link(anchoredTarget, backupPath);
      linked = true;
      if (policy !== undefined) await verifyParentBoundary(policy, parentBoundary);
      await verifyTargetBoundary(policy, targetBoundary);
      await rm(anchoredTarget, { force: false });
      if (policy !== undefined) await verifyParentBoundary(policy, parentBoundary);
      return backupPath;
    } catch (error) {
      if (linked) {
        try {
          if (policy !== undefined) await verifyParentBoundary(policy, parentBoundary);
          await rm(backupPath, { force: false });
        } catch (cleanupError) {
          throw new RpcRuntimeError("patch_rollback_failed", "could not remove a backup after installation failed", {
            recovery: [{ path: anchoredTarget, backup_path: backupPath, error: message(cleanupError) }],
          });
        }
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new RpcRuntimeError("patch_install_failed", "could not reserve an exclusive backup path");
}

export async function assertExistingParent(target: string, parentBoundary?: ParentBoundary): Promise<void> {
  const anchoredTarget = anchoredPath(target, parentBoundary);
  let info;
  try {
    info = await lstat(dirname(anchoredTarget));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw conflict("invalid_path", "target parent directory does not exist");
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw conflict("invalid_path", "target parent directory is not a regular directory");
}

export async function installNoReplace(temporaryPath: string, target: string, policy?: PathPolicy, parentBoundary?: ParentBoundary): Promise<void> {
  if (policy !== undefined) await verifyParentBoundary(policy, parentBoundary);
  await link(temporaryPath, anchoredPath(target, parentBoundary));
  if (policy !== undefined) await verifyParentBoundary(policy, parentBoundary);
  await rm(temporaryPath, { force: false });
}

export async function rollback(states: readonly InstallState[], policy?: PathPolicy): Promise<Record<string, unknown>[]> {
  const failures: Record<string, unknown>[] = [];
  for (const state of [...states].reverse()) {
    if (!state.backupMoved && !state.installed) continue;
    const { change } = state;
    try {
      await verifyParentBoundary(policy, change.baseline.parentBoundary);
      const current = await captureBaseline(change.path, policy);
      if (state.backupMoved) {
        // Do not erase a post-baseline writer during recovery. Retain the
        // backup and return its exact recovery path to the caller instead.
        if (current.exists && (!state.installed || current.hash !== state.installedHash)) {
          throw new Error("target changed after patch installation");
        }
        if (current.exists) await rm(anchoredPath(change.path.path, change.baseline.parentBoundary), { force: false });
        await verifyParentBoundary(policy, change.baseline.parentBoundary);
        await rename(state.backupPath as string, anchoredPath(change.path.path, change.baseline.parentBoundary));
      } else if (state.installed && change.action === "write") {
        if (!current.exists || current.hash !== state.installedHash) throw new Error("target changed after patch installation");
        await verifyParentBoundary(policy, change.baseline.parentBoundary);
        await rm(anchoredPath(change.path.path, change.baseline.parentBoundary), { force: false });
      }
      await fsyncDirectory(dirname(anchoredPath(change.path.path, change.baseline.parentBoundary)), policy, change.baseline.parentBoundary);
    } catch (error) {
      failures.push({
        path: change.path.relativePath,
        action: change.action,
        ...(state.backupPath === undefined ? {} : { backup_path: state.backupPath }),
        ...(change.temporaryPath === undefined ? {} : { temporary_path: change.temporaryPath }),
        error: message(error),
      });
    }
  }
  return failures;
}

export async function fsyncDirectory(directory: string, policy?: PathPolicy, parentBoundary?: ParentBoundary): Promise<void> {
  let handle;
  try {
    if (policy !== undefined) await verifyParentBoundary(policy, parentBoundary);
    // Keep directory resolution unchanged, but never wait on a replaced FIFO
    // before checking the descriptor or attempting this durability barrier.
    handle = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NONBLOCK ?? 0));
    if (!(await handle.stat()).isDirectory()) return;
    await handle.sync();
  } catch {
    // Some platforms do not permit syncing a directory. Data correctness does
    // not depend on this best-effort durability barrier.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function anchoredPath(target: string, parentBoundary: ParentBoundary | undefined): string {
  if (parentBoundary === undefined) return target;
  return join(parentBoundary.snapshot.canonicalPath, basename(target));
}

function backupName(path: string): string { return `${path}.runmesh-${randomUUID()}.bak`; }
