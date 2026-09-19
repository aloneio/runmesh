import { basename } from "node:path";
import { nativeJobFiles } from "../../src/jobs/storage.js";
import type { JobRecord } from "../../src/jobs/records.js";
import type { JobFilePort } from "../../src/jobs/ports.js";

/** Faults occur at the supported atomic-file port, not JobManager.persist. */
export function createJobFileFaults(): {
  write: (record: JobRecord, commit: () => Promise<void>) => Promise<void>;
  readonly files: JobFilePort;
} {
  const faults = {
    write: async (_record: JobRecord, commit: () => Promise<void>) => commit(),
    files: { ...nativeJobFiles } as JobFilePort,
  };
  faults.files = { ...nativeJobFiles, atomicJson: async (path, value) => {
    const commit = () => nativeJobFiles.atomicJson(path, value);
    if (basename(path) !== "meta.json") return commit();
    return faults.write(value as JobRecord, commit);
  } };
  return faults;
}
