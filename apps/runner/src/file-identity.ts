import type { BigIntStats, Stats } from "node:fs";

export interface ExactFileStats extends Stats { readonly identityKey: string }
type SnapshotIdentity = { readonly device: number; readonly inode: number; readonly identityKey?: string | undefined };
type FileIdentity = { readonly dev: number | bigint; readonly ino: number | bigint; readonly identityKey?: string | undefined };

/** Decimal keys retain the complete native identity and remain JSON-safe. */
export function fileIdentityKey(info: { readonly dev: number | bigint; readonly ino: number | bigint }): string | undefined {
  const component = (value: number | bigint): string | undefined => typeof value === "bigint"
    ? value >= 0n ? value.toString() : undefined
    : Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
  const device = component(info.dev), inode = component(info.ino);
  return device === undefined || inode === undefined ? undefined : `${device}:${inode}`;
}

export function snapshotIdentityKey(value: SnapshotIdentity): string | undefined {
  if (value.identityKey === undefined) return fileIdentityKey({ dev: value.device, ino: value.inode });
  if (!/^(?:0|[1-9]\d{0,19}):(?:0|[1-9]\d{0,19})$/u.test(value.identityKey)) return undefined;
  const [device, inode] = value.identityKey.split(":");
  return Number(device) === value.device && Number(inode) === value.inode ? value.identityKey : undefined;
}

export function sameSnapshotFileIdentity(left: SnapshotIdentity, right: SnapshotIdentity): boolean {
  const key = snapshotIdentityKey(left);
  return key !== undefined && key === snapshotIdentityKey(right);
}

export function statIdentityKey(info: FileIdentity): string | undefined {
  if (info.identityKey === undefined) return fileIdentityKey(info);
  if (typeof info.dev === "bigint" || typeof info.ino === "bigint") {
    const key = fileIdentityKey(info);
    return key === info.identityKey ? key : undefined;
  }
  return snapshotIdentityKey({ device: info.dev, inode: info.ino, identityKey: info.identityKey });
}

export function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  const key = statIdentityKey(left);
  return key !== undefined && key === statIdentityKey(right);
}

/** Keep existing metadata consumers numeric while obtaining identity from one
 * bigint stat syscall. Split seconds/nanoseconds before converting timestamps. */
export function exactFileStats(info: BigIntStats): ExactFileStats {
  const identityKey = fileIdentityKey(info);
  if (identityKey === undefined) throw new Error("File identity is invalid");
  const milliseconds = (ns: bigint): number => Number(ns / 1_000_000_000n) * 1000 + Number(ns % 1_000_000_000n) / 1_000_000;
  return {
    dev: Number(info.dev), ino: Number(info.ino), mode: Number(info.mode), nlink: Number(info.nlink),
    uid: Number(info.uid), gid: Number(info.gid), rdev: Number(info.rdev), size: Number(info.size),
    blksize: Number(info.blksize), blocks: Number(info.blocks),
    atimeMs: milliseconds(info.atimeNs), mtimeMs: milliseconds(info.mtimeNs),
    ctimeMs: milliseconds(info.ctimeNs), birthtimeMs: milliseconds(info.birthtimeNs),
    atime: info.atime, mtime: info.mtime, ctime: info.ctime, birthtime: info.birthtime,
    isFile: () => info.isFile(), isDirectory: () => info.isDirectory(), isSymbolicLink: () => info.isSymbolicLink(),
    isBlockDevice: () => info.isBlockDevice(), isCharacterDevice: () => info.isCharacterDevice(),
    isFIFO: () => info.isFIFO(), isSocket: () => info.isSocket(), identityKey,
  };
}
