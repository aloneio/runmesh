import { lstat, open, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { normalizeJobRecord, safeJobId } from "../jobs/records.js";
import { MAX_METADATA_BYTES } from "../jobs/storage.js";
import { UpdateFailure, type LocalJobDrainObservation } from "./contracts.js";

async function regularDirectory(path: string): Promise<void> {
  const target = resolve(path); const root = parse(target).root; let current = root;
  for (const component of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, component);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new UpdateFailure("local_state_invalid");
  }
}

/** Observe every durable job, including disabled-history and recovered unknown
 * jobs. Missing, malformed or concurrently replaced metadata is never idle. */
export async function inspectLocalJobs(stateRoot: string): Promise<LocalJobDrainObservation> {
  try {
    const jobsRoot = join(stateRoot, "jobs");
    await regularDirectory(jobsRoot);
    const before = await lstat(jobsRoot);
    const entries = await readdir(jobsRoot, { withFileTypes: true });
    if (entries.length > 10_000) throw new UpdateFailure("local_state_invalid");
    let active = 0;
    for (const entry of entries) {
      if (!safeJobId(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) throw new UpdateFailure("local_state_invalid");
      const path = join(jobsRoot, entry.name, "meta.json");
      await regularDirectory(dirname(path));
      const initial = await lstat(path);
      if (!initial.isFile() || initial.isSymbolicLink() || initial.size <= 0 || initial.size > MAX_METADATA_BYTES) throw new UpdateFailure("local_state_invalid");
      const handle = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
      let value: unknown;
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino || opened.size !== initial.size) throw new UpdateFailure("local_state_invalid");
        const bytes = Buffer.alloc(initial.size + 1); let length = 0;
        while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, null); if (read.bytesRead === 0) break; length += read.bytesRead; }
        const current = await lstat(path); const final = await handle.stat();
        if (length !== initial.size || final.size !== initial.size || final.mtimeMs !== opened.mtimeMs || current.isSymbolicLink() || current.dev !== initial.dev || current.ino !== initial.ino) throw new UpdateFailure("local_state_invalid");
        value = JSON.parse(bytes.subarray(0, length).toString("utf8"));
      } finally { await handle.close(); }
      const job = normalizeJobRecord(value, entry.name);
      if (job === undefined) throw new UpdateFailure("local_state_invalid");
      if (["queued", "running", "cancelling", "unknown"].includes(job.status)) active++;
    }
    const after = await lstat(jobsRoot);
    if (after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs) throw new UpdateFailure("local_state_invalid");
    return { idle: active === 0, active };
  } catch (error) { throw error instanceof UpdateFailure ? error : new UpdateFailure("local_state_invalid"); }
}
