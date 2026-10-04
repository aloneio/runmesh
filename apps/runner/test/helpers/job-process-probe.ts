import { nativeJobProcesses } from "../../src/jobs/process.js";
import type { ChildProcess } from "node:child_process";
import type { JobProcessPort } from "../../src/jobs/ports.js";

/** Capture native children at the spawn port, without inspecting JobManager. */
export function createJobProcessProbe() {
  const children: ChildProcess[] = [];
  const processes: JobProcessPort = {
    ...nativeJobProcesses,
    spawn: ((...args: Parameters<JobProcessPort["spawn"]>) => {
      const child = nativeJobProcesses.spawn(...args);
      children.push(child);
      return child;
    }) as JobProcessPort["spawn"]
  };
  return {
    processes,
    children
  };
}
