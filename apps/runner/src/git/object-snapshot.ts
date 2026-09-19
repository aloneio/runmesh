import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join } from "node:path";

const MAX_OBJECT_BYTES = 256 * 1024 * 1024;
const MAX_OBJECT_ENTRIES = 32768;

/** Git must not follow the mutable source object database as an alternate.
 * Copy bounded regular objects through checked descriptors into its private
 * directory. Linux directory traversal stays pinned to procfs descriptors;
 * other platforms additionally compare path identities around each copy.
 * This is not a multi-process repository transaction or an OS sandbox. */
export async function snapshotGitObjects(source: string, destination: string, deadline = performance.now() + 5000): Promise<void> {
  let bytes = 0, entries = 0;
  const check = (): void => {
    if (performance.now() >= deadline || entries > MAX_OBJECT_ENTRIES || bytes > MAX_OBJECT_BYTES) throw new Error("Git object snapshot exceeds its bounded inspection budget");
  };
  const same = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino;
  const copy = async (from: string, to: string, expected: Stats): Promise<void> => {
    check();
    if (!expected.isFile() || expected.isSymbolicLink() || expected.size > MAX_OBJECT_BYTES - bytes) throw new Error("Git object is not a bounded regular file");
    // A checked regular file can become a FIFO before open. Do not let
    // that race park a filesystem worker while waiting for a pipe writer.
    const input = await open(from, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = await input.stat();
      if (!opened.isFile() || !same(expected, opened) || opened.size !== expected.size) throw new Error("Git object changed before its snapshot");
      const output = await open(to, "wx", 0o600);
      try {
        const buffer = Buffer.alloc(64 * 1024); let offset = 0;
        while (offset < opened.size) {
          check();
          const result = await input.read(buffer, 0, Math.min(buffer.length, opened.size - offset), offset);
          if (result.bytesRead === 0) throw new Error("Git object changed during its snapshot");
          let written = 0;
          while (written < result.bytesRead) {
            const resultWrite = await output.write(buffer, written, result.bytesRead - written, offset + written);
            if (resultWrite.bytesWritten === 0) throw new Error("Git object snapshot write stalled");
            written += resultWrite.bytesWritten;
          }
          offset += result.bytesRead; bytes += result.bytesRead;
        }
        const after = await input.stat(), pathAfter = await lstat(from);
        if (!same(opened, after) || !same(opened, pathAfter) || !pathAfter.isFile() || pathAfter.isSymbolicLink() || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error("Git object changed during its snapshot");
      } finally { await output.close(); }
    } finally { await input.close(); }
  };
  const walk = async (from: string, to: string, depth: number): Promise<void> => {
    check();
    if (depth > 3) throw new Error("Git object directory nesting is unsupported");
    const before = await lstat(from);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("Git object directory is not a regular directory");
    const canonical = await realpath(from);
    const pinned = process.platform === "linux" ? await open(from, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW) : undefined;
    try {
      if (pinned !== undefined && !same(before, await pinned.stat())) throw new Error("Git object directory changed before opening");
      const base = pinned === undefined ? from : `/proc/self/fd/${pinned.fd}`;
      const directory = await opendir(base);
      try {
        for await (const entry of directory) {
          entries++; check();
          const child = join(base, entry.name), target = join(to, entry.name), info = await lstat(child);
          if (info.isSymbolicLink()) throw new Error("Git object links are not supported for isolated inspection");
          // Source info/alternates was independently checked. Never copy any
          // alternate pointer, commit-graph or other optional source accelerator.
          if (depth === 0 && entry.name === "info") {
            if (!info.isDirectory()) throw new Error("Git object info is not a regular directory");
            continue;
          }
          if (info.isDirectory()) { await mkdir(target, { recursive: true, mode: 0o700 }); await walk(child, target, depth + 1); }
          else await copy(child, target, info);
        }
      } finally { await directory.close().catch(() => undefined); }
      const after = await lstat(from);
      if (!after.isDirectory() || after.isSymbolicLink() || !same(before, after) || canonical !== await realpath(from)) throw new Error("Git object directory changed during its snapshot");
    } finally { await pinned?.close(); }
  };
  await walk(source, destination, 0);
}
