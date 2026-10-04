import type { JobRecord } from "./records.js";
import { occupiesProcessSlot } from "./records.js";
export interface RetainedJobPorts {
  current(): JobRecord | undefined;
  busy(): boolean;
  cachedBytes(): number | undefined;
  measureBytes(): Promise<number>;
  removeFiles(): Promise<void>;
  retire(bytes: number): void;
}

/** Recheck the exact snapshot after each asynchronous storage boundary. */
export async function removeRetainedJobIfCurrent(job: JobRecord, ports: RetainedJobPorts): Promise<boolean> {
  const canRemove = (): boolean => ports.current() === job && !occupiesProcessSlot(job) && !ports.busy();
  if (!canRemove()) return false;
  const size = ports.cachedBytes() ?? (await ports.measureBytes());
  if (!canRemove()) return false;
  await ports.removeFiles();
  if (!canRemove()) return false;
  ports.retire(size);
  return true;
}
