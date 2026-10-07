import { lstat, readdir } from "node:fs/promises";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { maintenanceJobState, safeMaintenanceJobId, MAX_MAINTENANCE_METADATA_BYTES, MAX_MAINTENANCE_JOB_RECORDS } from "../maintenance-contract.js";
import { UpdateFailure, type LocalJobDrainObservation } from "./contracts.js";
import { readMetadataJson } from "./metadata-file.js";

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
    if (entries.length > MAX_MAINTENANCE_JOB_RECORDS) throw new UpdateFailure("local_state_invalid");
    let active = 0;
    for (const entry of entries) {
      if (!safeMaintenanceJobId(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) throw new UpdateFailure("local_state_invalid");
      const path = join(jobsRoot, entry.name, "meta.json");
      await regularDirectory(dirname(path));
      const initial = await lstat(path);
      const value = await readMetadataJson(path, initial, { maxBytes: MAX_MAINTENANCE_METADATA_BYTES, errorCode: "local_state_invalid" });
      const job = maintenanceJobState(value, entry.name);
      if (job === undefined) throw new UpdateFailure("local_state_invalid");
      if (job.active) active++;
    }
    const after = await lstat(jobsRoot);
    if (after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs) throw new UpdateFailure("local_state_invalid");
    return { idle: active === 0, active };
  } catch (error) { throw error instanceof UpdateFailure ? error : new UpdateFailure("local_state_invalid"); }
}
