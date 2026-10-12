import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { LaunchdStopRecoveryFilesystem, ServiceCommandExecutor, ServiceMode } from "./contracts.js";
import { createDurableFile, syncDurableFile } from "./durable-file.js";
import { nativeProbeReliable } from "./probes.js";
import { exactFileStats, sameFileIdentity } from "../file-identity.js";

export type { LaunchdStopRecoveryFilesystem } from "./contracts.js";

const missing = (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
async function checkParents(path: string): Promise<void> {
  const parents: string[] = [];
  for (let parent = dirname(path); dirname(parent) !== parent; parent = dirname(parent)) parents.unshift(parent);
  for (const parent of parents) {
    const info = await lstat(parent);
    if (info.isSymbolicLink()) {
      if (parent !== "/var" || await realpath(parent) !== "/private/var") throw new Error("Runner stop recovery directory is aliased");
    } else if (!info.isDirectory()) throw new Error("Runner stop recovery parent is not a directory");
  }
}

export const hostLaunchdStopRecoveryFilesystem: LaunchdStopRecoveryFilesystem = {
  read: async path => {
    let handle;
    try {
      await checkParents(path);
      const before = exactFileStats(await lstat(path, { bigint: true }));
      if (!before.isFile() || before.isSymbolicLink() || before.size > 4096) throw new Error("Runner stop recovery record has an unsafe file type or size");
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const after = exactFileStats(await handle.stat({ bigint: true }));
      if (!after.isFile() || after.size > 4096 || !sameFileIdentity(before, after)) throw new Error("Runner stop recovery record changed while opening");
      const bytes = Buffer.alloc(4097);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > 4096) throw new Error("Runner stop recovery record is oversized");
      return bytes.subarray(0, offset).toString("utf8");
    } catch (error) { if (missing(error)) return undefined; throw error; }
    finally { await handle?.close(); }
  },
  create: async (path, text) => { await checkParents(path); await createDurableFile(path, text); },
  sync: async path => { await checkParents(path); await syncDurableFile(path); },
  remove: async path => { await checkParents(path); await unlink(path); },
};

export function readOnlyLaunchdStopRecoveryFilesystem(read: LaunchdStopRecoveryFilesystem["read"]): LaunchdStopRecoveryFilesystem {
  const unavailable = async () => { throw new Error("Runner stop requires durable recovery-record support"); };
  return { read, create: unavailable, sync: unavailable, remove: unavailable };
}

export async function launchdProcessExited(executor: ServiceCommandExecutor, pid: number): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Runner process identity is unavailable");
  const result = await executor.execute("ps", ["-p", String(pid), "-o", "pid="]);
  if (result.exitCode === 1 && !(result.stdout ?? "").trim() && !(result.stderr ?? "").trim()) return true;
  if (result.exitCode !== 0) throw new Error("Runner process exit could not be confirmed");
  return false;
}

export async function waitForLaunchdExit(executor: ServiceCommandExecutor, target: string, pid: number | undefined, options: { now?: () => number; delay?: (ms: number) => Promise<void> } = {}): Promise<void> {
  const now = options.now ?? Date.now;
  const delay = options.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now() + 5_000;
  while (true) {
    const registration = await executor.execute("launchctl", ["print", target]);
    if (!nativeProbeReliable(registration, "query")) throw new Error("launchd service state could not be verified");
    if (registration.exitCode !== 0 && (pid === undefined || pid === 0 || await launchdProcessExited(executor, pid))) return;
    if (now() >= deadline) throw new Error("launchd service or process did not stop before the cleanup deadline");
    await delay(100);
  }
}

export function createLaunchdStopRecovery(options: {
  executor: ServiceCommandExecutor;
  target: string;
  mode: ServiceMode;
  manifestPath: string;
  filesystem?: LaunchdStopRecoveryFilesystem;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
}) {
  const { executor, target, mode } = options;
  const filesystem = options.filesystem ?? hostLaunchdStopRecoveryFilesystem;
  // Shared with purge so changing entry points cannot forget an unfinished stop.
  const path = `${options.manifestPath}.purge-stop.json`;
  type Record = { text: string; pid: number };
  const read = async (): Promise<Record | undefined> => {
    const text = await filesystem.read(path);
    if (text === undefined) return undefined;
    let value: unknown;
    try { value = text.length > 4096 ? undefined : JSON.parse(text); } catch { value = undefined; }
    if (typeof value !== "object" || value === null || Array.isArray(value)
      || !("schema_version" in value) || value.schema_version !== 1
      || !("target" in value) || value.target !== target
      || !("mode" in value) || value.mode !== mode
      || !("pid" in value) || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0
      || Object.keys(value).some(key => !["schema_version", "target", "mode", "pid"].includes(key))) throw new Error("Runner stop recovery record is invalid; retain it for inspection");
    return { text, pid: Number(value.pid) };
  };
  const check = async (record: Record) => {
    if ((await read())?.text !== record.text) throw new Error("Runner stop recovery record changed");
  };
  const remove = async (record: Record) => { await check(record); await filesystem.remove(path); };
  const execute = async (args: readonly string[]) => {
    if ((await executor.execute("launchctl", args)).exitCode !== 0) throw new Error(`Runner service command failed: launchctl ${args[0]}`);
  };
  const stop = async ({ disable = false }: { disable?: boolean } = {}) => {
    let record = await read();
    const current = await executor.execute("launchctl", ["print", target]);
    if (!nativeProbeReliable(current, "query")) throw new Error("launchd service state could not be verified");
    const loaded = current.exitCode === 0;
    const rawPid = loaded ? /\bpid\s*=\s*(\d+)\b/u.exec(current.stdout ?? "")?.[1] : undefined;
    const pid = rawPid === undefined ? undefined : Number(rawPid);
    if ((pid !== undefined && (!Number.isSafeInteger(pid) || pid <= 0))
      || (loaded && /\bstate\s*=\s*running\b/u.test(current.stdout ?? "") && pid === undefined)) throw new Error("Runner process identity is unavailable");
    if (loaded && record !== undefined && record.pid !== pid) {
      if (!await launchdProcessExited(executor, record.pid)) throw new Error("Previous Runner process is still active");
      await remove(record); record = undefined;
    }
    if (pid !== undefined && record === undefined) {
      const text = JSON.stringify({ schema_version: 1, target, mode, pid }) + "\n";
      await filesystem.create(path, text);
      record = await read();
      if (record?.text !== text) throw new Error("Runner stop recovery record was not persisted");
    }
    if (record !== undefined) {
      await check(record); await filesystem.sync(path); await check(record);
    }
    if (disable) await execute(["disable", target]);
    if (loaded) await execute(["bootout", target]);
    await waitForLaunchdExit(executor, target, record?.pid, options);
    if (record !== undefined) await remove(record);
  };
  return { stop, recover: async () => { if (await read() !== undefined) await stop(); } };
}
