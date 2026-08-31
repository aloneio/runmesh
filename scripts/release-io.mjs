import { open } from "node:fs/promises";

// Keep every release input and distributable bounded before JSON parsing,
// signature verification, or hashing. The hosted installer embeds the same
// numeric contract independently because it cannot import this Node-only file.
export const MAX_RELEASE_ASSET_BYTES = 8 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Read one release input without allowing a malformed local asset to trigger
 * an unbounded allocation. The size is checked both before and after the read
 * so a concurrent truncation/growth cannot silently bypass the bound.
 */
export async function readBoundedReleaseFile(path, label = path) {
  let handle;
  try {
    // Keep the descriptor open across stat/read so a path replacement cannot
    // make the post-stat read target a different inode.
    handle = await open(path, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error(`${label} is not a regular file`);
    if (!Number.isSafeInteger(metadata.size) || metadata.size <= 0) throw new Error(`${label} is empty or has an invalid size`);
    if (metadata.size > MAX_RELEASE_ASSET_BYTES) throw new Error(`${label} exceeds the ${MAX_RELEASE_ASSET_BYTES}-byte release input limit`);

    const chunks = [];
    let total = 0;
    while (total <= MAX_RELEASE_ASSET_BYTES) {
      // Read at most one byte past the cap so growth after stat cannot cause
      // an unbounded allocation before the size check runs.
      const remaining = MAX_RELEASE_ASSET_BYTES + 1 - total;
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      chunks.push(bytesRead === chunk.byteLength ? chunk : chunk.subarray(0, bytesRead));
      total += bytesRead;
      if (total > MAX_RELEASE_ASSET_BYTES) throw new Error(`${label} exceeds the ${MAX_RELEASE_ASSET_BYTES}-byte release input limit`);
    }
    // Re-stat the same descriptor after EOF as well. An append that lands
    // immediately after the final read would otherwise evade the initial
    // size check even though the path was held open safely throughout.
    const finalMetadata = await handle.stat();
    if (!finalMetadata.isFile()
      || !Number.isSafeInteger(finalMetadata.size)
      || finalMetadata.size <= 0) throw new Error(`${label} changed while being read`);
    if (finalMetadata.size > MAX_RELEASE_ASSET_BYTES) throw new Error(`${label} exceeds the ${MAX_RELEASE_ASSET_BYTES}-byte release input limit`);
    if (total !== metadata.size || total !== finalMetadata.size) throw new Error(`${label} changed while being read`);
    return Buffer.concat(chunks, total);
  } finally {
    if (handle !== undefined) await handle.close().catch(() => {});
  }
}
