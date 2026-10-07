import { statSync } from "node:fs";

/** Source identity belongs to the requested checkout, independent of Git
 * routing inherited from a hook, IDE or another repository's tooling. */
export function sourceGitEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
}

/** A directory can have multiple Windows case/8.3 spellings. Compare the
 * actual directory object, never case-fold arbitrary paths or trust a prefix.
 * BigInt prevents distinct 64-bit file IDs from collapsing through rounding. */
export function sourceDirectoryIdentity(path) {
  try {
    const info = statSync(path, { bigint: true });
    if (!info.isDirectory() || typeof info.dev !== "bigint" || info.dev < 0n || typeof info.ino !== "bigint" || info.ino <= 0n) return undefined;
    return { device: info.dev, inode: info.ino };
  } catch { return undefined; }
}
export function sameDirectoryIdentity(left, right) {
  return left !== undefined && right !== undefined && left !== null && right !== null
    && typeof left.device === "bigint" && left.device >= 0n && typeof left.inode === "bigint" && left.inode > 0n
    && left.device === right.device && left.inode === right.inode;
}
