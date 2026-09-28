import type { JobRecord } from "./records.js";
import type { ChildProcess, spawn } from "node:child_process";
import type { FileHandle, lstat, rm, readdir } from "node:fs/promises";

/** Internal platform ports, not wire capabilities or public CLI options. */
export interface JobFilePort {
  ensureJobStorageDirectories(stateDir: string, jobsDir: string): Promise<void>;
  ensureDirectoryPath(path: string, label: string, privateMode: boolean): Promise<void>;
  openJobLog(path: string, mode: "read" | "append"): Promise<FileHandle>;
  appendJobLog(path: string, data: Buffer): Promise<void>;
  safeFileSize(path: string): Promise<number>;
  atomicJson(path: string, value: unknown): Promise<void>;
  readJson<T>(path: string): Promise<T>;
  readonly lstat: typeof lstat;
  readonly rm: typeof rm;
  readonly readdir: typeof readdir;
}
export interface JobProcessPort {
  readonly spawn: typeof spawn;
  inspectProcess(pid: number | null, expectedFingerprint: string | null): Promise<{ alive: boolean; fingerprintMatches: boolean | null }>;
  fingerprintSync(pid: number | null): string | null;
  terminateProcess(pid: number | null, expectedFingerprint?: string | null, expectedChild?: ChildProcess): Promise<boolean>;
}
export interface JobLogScope {
  readonly cursorOwner: string;
  readonly jobsDir: string;
  readonly runnerId: string;
  generation(): number;
  assertGeneration(generation: number): void;
  logPath(jobId: string, stream: "stdout" | "stderr"): string;
}
export type JobLogFilePort = Pick<JobFilePort, "openJobLog" | "lstat">;

/** @internal Coordination around enqueue/completion, not a storage owner.
 * The supplied enqueue callback retains JobManager's serialization and stale
 * snapshot guards. Trusted tests can pause before enqueue or after durability. */
export interface JobPersistencePort {
  write(record: Readonly<JobRecord>, enqueue: () => Promise<void>): Promise<void>;
}
