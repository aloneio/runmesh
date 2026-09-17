import { lstatSync, realpathSync } from "node:fs";
import { win32 } from "node:path";

export interface RootIdentity { readonly canonical: string; readonly device: number; readonly inode: number }

/** Admission is synchronous so a first read cannot silently adopt a new root. */
export function captureRootIdentity(path: string): RootIdentity | undefined {
  try {
    const before = lstatSync(path);
    if (!before.isDirectory() || before.isSymbolicLink()) return undefined;
    const canonical = realpathSync.native(path), after = lstatSync(canonical), again = lstatSync(path);
    if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.dev !== again.dev || before.ino !== again.ino) return undefined;
    return { canonical: process.platform === "win32" ? win32.normalize(canonical).toLowerCase() : canonical, device: before.dev, inode: before.ino };
  } catch { return undefined; }
}

export function sameRootIdentity(left: RootIdentity | undefined, right: RootIdentity | undefined): boolean {
  return left !== undefined && right !== undefined && left.canonical === right.canonical && left.device === right.device && left.inode === right.inode;
}
