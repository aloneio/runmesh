import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { trustedWindowsEnvironment, trustedWindowsRoot } from "../windows-tools.js";
import type { JobProcessPort } from "./ports.js";

/** Internal terminator shape carries the non-exported ChildProcess identity. */
export type ProcessTerminator = (pid: number | null, expectedFingerprint?: string | null, expectedChild?: ChildProcess) => Promise<boolean>;

export async function inspectProcess(pid: number | null, expectedFingerprint: string | null): Promise<{ alive: boolean; fingerprintMatches: boolean | null }> {
  if (pid === null || pid <= 0) return { alive: false, fingerprintMatches: null };
  try { process.kill(pid, 0); } catch (error) { return { alive: (error as NodeJS.ErrnoException).code === "EPERM", fingerprintMatches: null }; }
  const observation = await linuxProcessObservation(pid);
  const fingerprint = observation?.starttime ?? null;
  // kill(pid, 0) also succeeds for an exited child that its parent has not
  // reaped. Container init processes may retain that zombie indefinitely;
  // recovery must release its slot while preserving the unknown exit outcome.
  return { alive: observation === null || !isDeadProcessState(observation.state),
    fingerprintMatches: expectedFingerprint === null || fingerprint === null ? null : fingerprint === expectedFingerprint };
}

/** Read Linux /proc/<pid>/stat field 22 (starttime); unavailable hosts return null. */
export function linuxProcessStartFingerprintSync(pid: number | null): string | null {
  return linuxProcessObservationSync(pid)?.starttime ?? null;
}

type LinuxProcessObservation = { readonly state: string; readonly starttime: string };

function parseLinuxProcessStat(value: string): LinuxProcessObservation | null {
  const close = value.lastIndexOf(")");
  if (close < 0) return null;
  const fields = value.slice(close + 2).trim().split(/\s+/);
  const state = fields[0], starttime = fields[19]; // fields after comm start at field 3; field 22 is index 19.
  return state === undefined || state.length !== 1 || starttime === undefined || !/^\d+$/.test(starttime) ? null : { state, starttime };
}

function isDeadProcessState(state: string): boolean { return state === "Z" || state === "X" || state === "x"; }

function linuxProcessObservationSync(pid: number | null): LinuxProcessObservation | null {
  if (process.platform !== "linux" || pid === null || pid <= 0) return null;
  try { return parseLinuxProcessStat(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return null; }
}

export async function linuxProcessStartFingerprint(pid: number | null): Promise<string | null> {
  return (await linuxProcessObservation(pid))?.starttime ?? null;
}

async function linuxProcessObservation(pid: number | null): Promise<LinuxProcessObservation | null> {
  if (process.platform !== "linux" || pid === null || pid <= 0) return null;
  try { return parseLinuxProcessStat(await readFile(`/proc/${pid}/stat`, "utf8")); } catch { return null; }
}

export async function terminateProcess(pid: number | null, expectedFingerprint: string | null = null, expectedChild?: ChildProcess): Promise<boolean> {
  if (pid === null || pid <= 0) return false;
  // A recovered Windows record has only a bare PID. Without the original
  // ChildProcess handle there is no portable creation-time identity proof, so
  // fail closed instead of taskkilling a potentially reused PID.
  if (process.platform === "win32") {
    if (expectedChild === undefined || !isTerminationTargetValid(pid, expectedFingerprint, expectedChild)) return false;
    return terminateWindowsProcessTree(pid);
  }
  // Re-check the identity inside the native terminator as well as in the
  // JobManager caller. The child can exit between the caller's async probe and
  // this synchronous signal call; fail closed instead of sending to a reused
  // process group.
  if (!isTerminationTargetValid(pid, expectedFingerprint, expectedChild)) return false;
  const target = -pid;
  try { process.kill(target, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  // Return after delivery rather than after the grace period so `close` cannot
  // race past cancellation classification. Before escalating, prove that the
  // original leader still exists. A bare PID is not sufficient after a
  // restart/reuse window: on Linux use /proc starttime, while local ChildProcess
  // handles provide the best available proof on other POSIX hosts. Recovered
  // jobs without either proof deliberately skip SIGKILL rather than risking an
  // unrelated process group.
  void new Promise((resolve) => setTimeout(resolve, 1_000)).then(() => {
    if (!isTerminationTargetValid(pid, expectedFingerprint, expectedChild)) return;
    try { process.kill(target, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }).catch(() => undefined);
  return true;
}

export function isTerminationTargetValid(pid: number, expectedFingerprint: string | null, expectedChild?: ChildProcess): boolean {
  if (expectedChild !== undefined && (expectedChild.pid !== pid || expectedChild.exitCode !== null || expectedChild.signalCode !== null)) return false;
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform === "linux") return expectedFingerprint !== null && linuxProcessStartFingerprintSync(pid) === expectedFingerprint;
  // There is no portable process-start fingerprint on these hosts. Recovered
  // jobs have no live handle and therefore cannot be safely escalated.
  return expectedChild !== undefined;
}

/** taskkill /T /F is Windows-specific best effort: protected/orphaned descendants may resist it. */
export async function terminateWindowsProcessTree(pid: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const systemRoot = trustedWindowsRoot();
    const killer = spawn(`${systemRoot}\\System32\\taskkill.exe`, ["/PID", String(pid), "/T", "/F"], {
      // A Runner may be invoked by an administrator from a writable working
      // directory. Use an absolute inbox utility path, a system cwd, and a
      // minimal environment so process-tree cancellation cannot be redirected
      // through PATH/current-directory executable shadowing.
      cwd: `${systemRoot}\\System32`,
      env: trustedWindowsEnvironment(systemRoot),
      stdio: "ignore",
      windowsHide: true,
    });
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => {
      // A stuck taskkill must not keep a cancellation/terminal state pending
      // forever. Killing the helper does not claim the target was terminated;
      // callers retain the durable cancelling/interrupted evidence instead.
      try { killer.kill(); } catch { /* helper already exited */ }
      finish(false);
    }, 10_000);
    killer.once("error", (error) => {
      if (settled) return;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") reject(new Error("taskkill is unavailable; Windows process-tree cancellation cannot be performed"));
      else reject(error);
      settled = true;
      clearTimeout(timeout);
    });
    killer.once("close", (code) => finish(code === 0));
  });
}

/** spawn stays synchronous; the caller attaches listeners before any await. */
export const nativeJobProcesses: JobProcessPort = Object.freeze({ spawn, inspectProcess, fingerprintSync: linuxProcessStartFingerprintSync, terminateProcess });
