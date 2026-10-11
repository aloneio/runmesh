import { constants } from "node:fs";
import { link, open, unlink } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { randomUUID } from "node:crypto";

async function syncParent(path: string): Promise<void> {
  const parent = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
}

/** Publish a complete record without replacing an existing destination. */
export async function createDurableFile(path: string, content: string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    try { await handle.writeFile(content); await handle.sync(); }
    finally { await handle.close(); }
    await link(temporary, path);
  } finally { await unlink(temporary); }
  await syncParent(path);
}

/** A retry must also cover a previous attempt that failed during sync. */
export async function syncDurableFile(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("recovery record is not a regular file");
    await handle.sync();
  } finally { await handle.close(); }
  await syncParent(path);
}
