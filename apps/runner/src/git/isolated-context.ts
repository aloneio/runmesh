import { snapshotGitObjects } from "./object-snapshot.js";
import { constants } from "node:fs";
import { dirname } from "node:path";
import type { IsolatedGitContext } from "./contracts.js";
import { isolatedGitEnvironment } from "./trust.js";
import { isPathWithin } from "./trust.js";
import { join } from "node:path";
import { lstat } from "node:fs/promises";
import { MAX_GIT_METADATA_BYTES } from "./limits.js";
import { mkdir } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { open } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { RpcRuntimeError } from "../errors.js";
import { tmpdir } from "node:os";
import { trustedGitCwd } from "./trust.js";
import { utimes } from "node:fs/promises";
import { writeFile } from "node:fs/promises";

/**
 * Build a throw-away Git directory containing only the current HEAD and
 * index.  A repository's own `.git/config`, hooks, filters, and fsmonitor
 * settings are intentionally not copied.  Git has no command-line switch to
 * ignore only local config, so running against this sanitized directory is
 * the reliable way to keep read-only status/diff from executing repository
 * supplied clean/smudge/process helpers.
 */
export async function createIsolatedGitContext(worktree: string, deadline?: number): Promise<IsolatedGitContext> {
  let directory: string | undefined;
  try {
    const canonicalWorktree = await realpath(worktree);
    if (dirname(canonicalWorktree) === canonicalWorktree) {
      throw new Error("filesystem-root workspaces cannot isolate Git inspection safely; configure a dedicated workspace directory");
    }
    const gitDirectory = await locateGitDirectory(worktree);
    const commonDirectory = await locateCommonDirectory(gitDirectory);
    directory = await mkdtemp(join(tmpdir(), "runmesh-git-"));
    await Promise.all([
      mkdir(join(directory, "hooks"), { recursive: true }),
      mkdir(join(directory, "info"), { recursive: true }),
      mkdir(join(directory, "refs", "heads"), { recursive: true }),
      mkdir(join(directory, "refs", "tags"), { recursive: true }),
      mkdir(join(directory, "objects", "info"), { recursive: true }),
    ]);

    const head = await readRegularText(join(gitDirectory, "HEAD"), 4_096);
    const ref = /^ref:\s*(refs\/[A-Za-z0-9._/-]+)\s*$/u.exec(head.trim());
    const safeHead = head.trim() + "\n";
    if (ref?.[1] !== undefined) {
      const hash = await resolveGitRef(gitDirectory, commonDirectory, ref[1]);
      // A branch without a commit is a valid freshly initialized repository;
      // leave its symbolic HEAD unresolved so Git reports the unborn branch.
      if (hash !== undefined) {
        const refPath = join(directory, ref[1].replaceAll("/", "/"));
        await mkdir(dirname(refPath), { recursive: true });
        await writeFile(refPath, `${hash}\n`, { mode: 0o600 });
      }
    } else if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(head.trim())) {
      throw new Error("the current Git HEAD is malformed");
    }
    await writeFile(join(directory, "HEAD"), safeHead, { mode: 0o600 });

    const index = join(gitDirectory, "index");
    const indexInfo = await lstat(index).catch(() => undefined);
    if (indexInfo !== undefined) {
      if (!indexInfo.isFile() || indexInfo.isSymbolicLink() || indexInfo.size > MAX_GIT_METADATA_BYTES) throw new Error("Git index is not a safe regular file");
      // Read through an identity-checked descriptor; copyFile(index, ...)
      // would follow a replacement symlink after the lstat above.
      const isolatedIndex = join(directory, "index");
      await writeFile(isolatedIndex, await readRegularBytes(index, MAX_GIT_METADATA_BYTES), { mode: 0o600 });
      // The copied index is created after the worktree is inspected, so its
      // fresh filesystem mtime can be newer than the files it describes. Git
      // would then trust stale stat entries (especially on Windows' coarse
      // timestamp filesystems) and miss a same-size edit. Preserve the source
      // index mtime so Git's normal racy-clean check hashes entries when the
      // timestamps are equal, without rewriting any user-owned index flags.
      await utimes(isolatedIndex, indexInfo.atime, indexInfo.mtime);
    }

    const objectPath = join(commonDirectory, "objects");
    const objectInfo = await lstat(objectPath);
    if (!objectInfo.isDirectory() || objectInfo.isSymbolicLink()) throw new Error("Git object directory is not a regular directory");
    const objectDirectory = await realpath(objectPath);
    if (!isPathWithin(objectDirectory, commonDirectory)) throw new Error("Git object directory escapes the repository");
    const alternateFile = join(commonDirectory, "objects", "info", "alternates");
    const alternateInfo = await lstat(alternateFile).catch(() => undefined);
    if (alternateInfo !== undefined) {
      const alternateText = await readRegularText(alternateFile, 64 * 1_024);
      if (alternateText.trim() !== "") throw new Error("Git object alternates are not supported for isolated inspection");
    }
    await snapshotGitObjects(objectDirectory, join(directory, "objects"), Math.min(deadline ?? Infinity, performance.now() + 5000));

    const objectFormat = await gitObjectFormat(gitDirectory, commonDirectory);
    const config = `[core]\n\trepositoryformatversion = ${objectFormat === "sha256" ? 1 : 0}\n\tfilemode = ${process.platform === "win32" ? "false" : "true"}\n\tbare = false\n\tignorecase = ${process.platform === "win32" ? "true" : "false"}\n` + (objectFormat === "sha256" ? "[extensions]\n\tobjectFormat = sha256\n" : "");
    await writeFile(join(directory, "config"), config, { mode: 0o600 });

    const environment = isolatedGitEnvironment(directory, worktree);
    return { directory, commandCwd: trustedGitCwd(), environment, cleanup: () => rm(directory!, { recursive: true, force: true }) };
  } catch (error) {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    const detail = error instanceof Error ? error.message.slice(0, 512) : "repository metadata is unavailable";
    throw new RpcRuntimeError("git_unavailable", `cannot inspect repository safely: ${detail}`);
  }
}

async function locateGitDirectory(worktree: string): Promise<string> {
  const dotGit = join(worktree, ".git");
  const info = await lstat(dotGit);
  if (info.isDirectory() && !info.isSymbolicLink()) {
    const canonicalWorktree = await realpath(worktree);
    const canonicalGit = await realpath(dotGit);
    const after = await lstat(dotGit);
    const canonicalInfo = await lstat(canonicalGit);
    if (!after.isDirectory() || after.isSymbolicLink() || !canonicalInfo.isDirectory() || canonicalInfo.isSymbolicLink()
      || info.dev !== after.dev || info.ino !== after.ino || info.dev !== canonicalInfo.dev || info.ino !== canonicalInfo.ino
      || !isPathWithin(canonicalGit, canonicalWorktree) || canonicalGit === canonicalWorktree) {
      throw new Error("Git metadata directory changed or escaped the worktree");
    }
    return canonicalGit;
  }
  // A linked-worktree `.git` file can point at an arbitrary external object
  // database.  Following it would let a read-only request select and expose
  // another repository's index/objects, so isolated inspection deliberately
  // supports only a real `.git` directory.
  throw new Error("linked Git worktrees and .git pointer files are not supported for isolated inspection");
}

async function locateCommonDirectory(gitDirectory: string): Promise<string> {
  const pointer = join(gitDirectory, "commondir");
  const info = await lstat(pointer).catch(() => undefined);
  if (info === undefined) return gitDirectory;
  throw new Error("Git common-directory pointers are not supported for isolated inspection");
}

async function resolveGitRef(gitDirectory: string, commonDirectory: string, ref: string, depth = 0): Promise<string | undefined> {
  if (depth > 4 || !/^refs\/[A-Za-z0-9._/-]+$/u.test(ref) || ref.split("/").some((part) => part === "" || part === "." || part === "..")) return undefined;
  for (const root of [gitDirectory, commonDirectory]) {
    const path = join(root, ref.replaceAll("/", "/"));
    const info = await lstat(path).catch(() => undefined);
    if (info === undefined) continue;
    if (!info.isFile() || info.isSymbolicLink()) return undefined;
    const value = (await readRegularText(path, 4_096)).trim();
    if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(value)) return value;
    const symbolic = /^ref:\s*(refs\/[A-Za-z0-9._/-]+)$/u.exec(value);
    return symbolic?.[1] === undefined ? undefined : resolveGitRef(gitDirectory, commonDirectory, symbolic[1], depth + 1);
  }
  const packed = join(commonDirectory, "packed-refs");
  const packedInfo = await lstat(packed).catch(() => undefined);
  if (packedInfo === undefined) return undefined;
  if (!packedInfo.isFile() || packedInfo.isSymbolicLink() || packedInfo.size > MAX_GIT_METADATA_BYTES) return undefined;
  const lines = (await readRegularText(packed, MAX_GIT_METADATA_BYTES)).split(/\r?\n/u);
  for (const line of lines) {
    const match = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)\s+(refs\/[A-Za-z0-9._/-]+)$/iu.exec(line);
    if (match?.[2] === ref && match[1] !== undefined) return match[1];
  }
  return undefined;
}

async function gitObjectFormat(gitDirectory: string, commonDirectory: string): Promise<"sha1" | "sha256"> {
  for (const path of [join(gitDirectory, "config"), join(commonDirectory, "config")]) {
    const info = await lstat(path).catch(() => undefined);
    if (info === undefined) continue;
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_GIT_METADATA_BYTES) throw new Error("Git config is not a safe regular file");
    const text = await readRegularText(path, MAX_GIT_METADATA_BYTES);
    const match = /^\s*objectformat\s*=\s*(sha1|sha256)\s*$/imu.exec(text);
    if (match?.[1]?.toLowerCase() === "sha256") return "sha256";
    if (match?.[1]?.toLowerCase() === "sha1") return "sha1";
  }
  return "sha1";
}

async function readRegularBytes(path: string, maxBytes: number): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new Error(`Git metadata file is invalid: ${path}`);
  // Keep the descriptor identity stable across the read. A lstat followed by
  // readFile(path) can otherwise be redirected to a symlink/replaced inode by
  // a concurrent writer in an untrusted worktree. Nonblocking open also lets
  // the descriptor check reject a FIFO replacement without waiting for a peer.
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size > maxBytes) {
      throw new Error(`Git metadata file changed while being opened: ${path}`);
    }
    const buffer = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const final = await handle.stat();
    if (!final.isFile() || final.dev !== opened.dev || final.ino !== opened.ino || final.size !== opened.size || offset !== opened.size) {
      throw new Error(`Git metadata file changed while being read: ${path}`);
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function readRegularText(path: string, maxBytes: number): Promise<string> {
  return (await readRegularBytes(path, maxBytes)).toString("utf8");
}
