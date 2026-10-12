import { lstatSync, realpathSync } from "node:fs";
import { win32 } from "node:path";
import { fileIdentityKey, sameSnapshotFileIdentity } from "./file-identity.js";

export interface RootIdentity { readonly canonical: string; readonly device: number; readonly inode: number; readonly identityKey?: string }

/** Admission is synchronous so a first read cannot silently adopt a new root. */
export function captureRootIdentity(path: string): RootIdentity | undefined {
  try {
    const before = lstatSync(path, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) return undefined;
    const canonical = realpathSync.native(path), after = lstatSync(canonical, { bigint: true }), again = lstatSync(path, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.dev !== again.dev || before.ino !== again.ino) return undefined;
    const identityKey = fileIdentityKey(before);
    return identityKey === undefined ? undefined : { canonical: process.platform === "win32" ? win32.normalize(canonical).toLowerCase() : canonical,
      device: Number(before.dev), inode: Number(before.ino), identityKey };
  } catch { return undefined; }
}

export function sameRootIdentity(left: RootIdentity | undefined, right: RootIdentity | undefined): boolean {
  return left !== undefined && right !== undefined && left.canonical === right.canonical && sameSnapshotFileIdentity(left, right);
}
