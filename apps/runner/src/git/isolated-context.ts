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
import { gitMetadataValue, isGitRefName, symbolicGitRef } from "./ref-name.js";
import { isolatedGitConfig } from "./config.js";
import { sharedIndexName, validateSharedIndex, validateShallowBoundary } from "./metadata-format.js";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";

/**
 * Build a throw-away Git directory containing only the current HEAD and
 * index, local excludes and allowlisted non-executing config values. The
 * source config, hooks, filters and fsmonitor are never loaded by Git. It has no command-line switch to
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

    const exclude = await readGitMetadata(commonDirectory, ["info", "exclude"], MAX_GIT_METADATA_BYTES);
    if (exclude !== undefined) await writeFile(join(directory, "info", "exclude"), exclude, { mode: 0o600 });
    const rawConfig = await readGitMetadata(commonDirectory, ["config"], MAX_GIT_METADATA_BYTES);
    const config = isolatedGitConfig(rawConfig === undefined ? "" : new TextDecoder("utf-8", { fatal: true }).decode(rawConfig), process.platform === "win32");
    await writeFile(join(directory, "config"), config, { mode: 0o600 });
    // The projected config has a canonical spelling and contains only data.
    const hashBytes = config.includes("\tobjectFormat = sha256\n") ? 32 : 20;
    const shallow = await readGitMetadata(commonDirectory, ["shallow"], MAX_GIT_METADATA_BYTES);
    if (shallow !== undefined) {
      validateShallowBoundary(shallow, hashBytes);
      await writeFile(join(directory, "shallow"), shallow, { mode: 0o600 });
    }

    const head = gitMetadataValue(await readRefText(join(gitDirectory, "HEAD"), 4_096));
    const ref = symbolicGitRef(head);
    const safeHead = head + "\n";
    if (ref !== undefined) {
      const hash = await resolveGitRef(gitDirectory, commonDirectory, ref);
      // A branch without a commit is a valid freshly initialized repository;
      // leave its symbolic HEAD unresolved so Git reports the unborn branch.
      if (hash !== undefined) {
        const refPath = join(directory, ref);
        await mkdir(dirname(refPath), { recursive: true });
        await writeFile(refPath, `${hash}\n`, { mode: 0o600 });
      }
    } else if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(head)) {
      throw new Error("the current Git HEAD is malformed");
    }
    await writeFile(join(directory, "HEAD"), safeHead, { mode: 0o600 });

    const index = join(gitDirectory, "index");
    const indexInfo = await optionalMetadataInfo(index);
    if (indexInfo !== undefined) {
      if (!indexInfo.isFile() || indexInfo.isSymbolicLink() || indexInfo.size > MAX_GIT_METADATA_BYTES) throw new Error("Git index is not a safe regular file");
      // Read through an identity-checked descriptor; copyFile(index, ...)
      // would follow a replacement symlink after the lstat above.
      const isolatedIndex = join(directory, "index");
      const indexBytes = await readGitMetadata(gitDirectory, ["index"], MAX_GIT_METADATA_BYTES);
      if (indexBytes === undefined) throw new Error("Git index disappeared during inspection");
      const sharedName = sharedIndexName(indexBytes, hashBytes);
      if (sharedName !== undefined) {
        const shared = await readGitMetadata(gitDirectory, [sharedName], MAX_GIT_METADATA_BYTES);
        if (shared === undefined) throw new Error("Git shared index is missing");
        validateSharedIndex(shared, sharedName, hashBytes);
        await writeFile(join(directory, sharedName), shared, { mode: 0o600 });
      }
      await writeFile(isolatedIndex, indexBytes, { mode: 0o600 });
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
    const alternateInfo = await optionalMetadataInfo(alternateFile);
    if (alternateInfo !== undefined) {
      const alternateText = await readRegularText(alternateFile, 64 * 1_024);
      if (alternateText.trim() !== "") throw new Error("Git object alternates are not supported for isolated inspection");
    }
    await snapshotGitObjects(objectDirectory, join(directory, "objects"), Math.min(deadline ?? Infinity, performance.now() + 5000));

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
  const info = await optionalMetadataInfo(pointer);
  if (info === undefined) return gitDirectory;
  throw new Error("Git common-directory pointers are not supported for isolated inspection");
}

async function resolveGitRef(gitDirectory: string, commonDirectory: string, ref: string, depth = 0): Promise<string | undefined> {
  if (depth > 4 || !isGitRefName(ref)) throw new Error("Git symbolic ref is malformed or cyclic");
  for (const root of new Set([gitDirectory, commonDirectory])) {
    const contents = await readLooseGitRef(root, ref);
    if (contents === undefined) continue;
    const value = gitMetadataValue(contents);
    if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(value)) return value;
    const symbolic = symbolicGitRef(value);
    if (symbolic === undefined) throw new Error("Git ref contents are malformed");
    return resolveGitRef(gitDirectory, commonDirectory, symbolic, depth + 1);
  }
  const packed = join(commonDirectory, "packed-refs");
  const packedInfo = await optionalMetadataInfo(packed);
  if (packedInfo === undefined) return undefined;
  if (!packedInfo.isFile() || packedInfo.isSymbolicLink() || packedInfo.size > MAX_GIT_METADATA_BYTES) throw new Error("Git packed refs are not a safe regular file");
  const lines = (await readRefText(packed, MAX_GIT_METADATA_BYTES)).split(/\r?\n/u);
  for (const line of lines) {
    const match = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) ([\s\S]+)$/iu.exec(line);
    if (match?.[2] === ref && match[1] !== undefined) return match[1];
  }
  return undefined;
}

/** Missing optional metadata is valid; unreadable metadata cannot describe a repository. */
async function optionalMetadataInfo(path: string): Promise<Stats | undefined> {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readLooseGitRef(root: string, ref: string): Promise<string | undefined> {
  const value = await readGitMetadata(root, ref.split("/"), 4_096);
  return value === undefined ? undefined : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value);
}

/** Pin every metadata parent as well as the leaf. Excludes and config are
 * ordinary data, but neither may be selected through a link or changed inode. */
async function readGitMetadata(root: string, parts: readonly string[], maxBytes: number): Promise<Buffer | undefined> {
  const directories: { path: string; info: Stats; handle?: FileHandle }[] = [];
  let parent = root;
  try {
    // A regular leaf can still be reached through an outside symlink/junction.
    // Check every directory, pin Linux lookups to open directory descriptors,
    // and verify identities again before publishing the copied ref value.
    for (let index = 0; index < parts.length; index += 1) {
      const path = index === 0 ? root : join(parent, parts[index - 1]!);
      const info = await optionalMetadataInfo(path);
      if (info === undefined) return undefined;
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Git ref directory is not a regular directory");
      const handle = process.platform === "linux" ? await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW) : undefined;
      directories.push({ path, info, ...(handle === undefined ? {} : { handle }) });
      if (handle !== undefined) {
        const opened = await handle.stat();
        if (opened.dev !== info.dev || opened.ino !== info.ino) throw new Error("Git ref directory changed while being opened");
      }
      parent = handle === undefined ? path : `/proc/self/fd/${handle.fd}`;
    }
    const value = await readRegularBytes(join(parent, parts.at(-1)!), maxBytes).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    for (const { path, info } of directories) {
      const after = await lstat(path);
      if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== info.dev || after.ino !== info.ino) {
        throw new Error("Git ref directory changed during inspection");
      }
    }
    return value;
  } finally {
    await Promise.all(directories.map(({ handle }) => handle?.close()));
  }
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
    const final = await handle.stat(), after = await lstat(path);
    if (!final.isFile() || !after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino
      || final.dev !== opened.dev || final.ino !== opened.ino || final.size !== opened.size || offset !== opened.size
      || final.mtimeMs !== opened.mtimeMs || final.ctimeMs !== opened.ctimeMs) {
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

async function readRefText(path: string, maxBytes: number): Promise<string> {
  // Ref names are identities: decoding invalid bytes as U+FFFD could select a
  // different real ref with that name. Keep literal BOM characters as well.
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readRegularBytes(path, maxBytes));
}
