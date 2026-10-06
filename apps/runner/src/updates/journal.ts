import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RunnerUpdateOperationSchema } from "@aloneio/runmesh-protocol";
import { isExactUpdateVersion, UPDATE_ERRORS, UPDATE_IDENTIFIER, UpdateFailure } from "./contracts.js";
import type { UpdateJournal, UpdateJournalPort } from "./contracts.js";

const absent = (error: unknown): boolean => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export async function assertManagerDirectory(path: string, create = false): Promise<void> {
  if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error; });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" && ((info.mode & 0o022) !== 0 || info.uid !== process.getuid?.()))) throw new UpdateFailure("local_state_invalid");
}

export async function readManagerJson(path: string): Promise<unknown | undefined> {
  let info;
  try { info = await lstat(path); } catch (error) { if (absent(error)) return undefined; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 64 * 1024 || (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) throw new UpdateFailure("local_state_invalid");
  const handle = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) throw new UpdateFailure("local_state_invalid");
    const bytes = Buffer.alloc(info.size + 1); let offset = 0;
    while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, null); if (read.bytesRead === 0) break; offset += read.bytesRead; }
    const after = await handle.stat(); const current = await lstat(path);
    if (offset !== info.size || after.mtimeMs !== opened.mtimeMs || after.size !== info.size || current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino) throw new UpdateFailure("local_state_invalid");
    return JSON.parse(bytes.subarray(0, offset).toString("utf8"));
  } finally { await handle.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicJson(directory: string, name: string, value: unknown): Promise<void> {
  await assertManagerDirectory(directory);
  const path = join(directory, name);
  // Refuse to replace an unexpected link or unprotected pre-existing file.
  await readManagerJson(path);
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, path); await syncDirectory(directory); }
  catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}

function parseJournal(value: unknown): UpdateJournal {
  if (!object(value) || value.schema_version !== 1 || !UPDATE_IDENTIFIER.test(String(value.manager_id))) throw new UpdateFailure("local_state_invalid");
  if (value.recovery_identity !== undefined && (typeof value.recovery_identity !== "string" || !/^[a-f0-9]{64}$/u.test(value.recovery_identity))) throw new UpdateFailure("local_state_invalid");
  const operation = RunnerUpdateOperationSchema.safeParse(value.operation);
  if (!operation.success || operation.data.manager_id !== value.manager_id) throw new UpdateFailure("local_state_invalid");
  const release = (candidate: unknown): boolean => object(candidate) && typeof candidate.version === "string" && isExactUpdateVersion(candidate.version)
    && typeof candidate.directory === "string" && candidate.directory.length <= 4096 && !/[\0\r\n]/u.test(candidate.directory);
  if (!release(value.previous) || (value.next !== undefined && !release(value.next))) throw new UpdateFailure("local_state_invalid");
  const phases = ["claimed", "staged", "draining", "stopping", "switching", "starting", "checking", "rolling_back", "succeeded", "rolled_back", "failed", "recovery_required"];
  if (!phases.includes(String(value.phase)) || (value.error_code !== undefined && !UPDATE_ERRORS.includes(value.error_code as typeof UPDATE_ERRORS[number]))) throw new UpdateFailure("local_state_invalid");
  const service = value.service;
  if (!object(service) || service.schema_version !== 1 || !["linux", "darwin", "win32"].includes(String(service.platform)) || !["user", "system"].includes(String(service.mode))
    || typeof service.registered !== "boolean" || typeof service.active !== "boolean" || typeof service.enabled !== "boolean" || typeof service.enablement !== "string" || service.enablement.length > 128
    || (service.pid !== undefined && (!Number.isSafeInteger(service.pid) || Number(service.pid) < 0))) throw new UpdateFailure("local_state_invalid");
  return value as unknown as UpdateJournal;
}

export class FileUpdateJournal implements UpdateJournalPort {
  public constructor(private readonly directory: string) {}
  public async load(): Promise<UpdateJournal | undefined> {
    await assertManagerDirectory(this.directory);
    const value = await readManagerJson(join(this.directory, "active-operation.json"));
    return value === undefined ? undefined : parseJournal(value);
  }
  public async save(journal: UpdateJournal): Promise<void> { await atomicJson(this.directory, "active-operation.json", parseJournal(journal)); }
  public async complete(journal: UpdateJournal): Promise<void> {
    await atomicJson(this.directory, "last-operation.json", parseJournal(journal));
    await unlink(join(this.directory, "active-operation.json")); await syncDirectory(this.directory);
  }
}

export async function loadManagerId(directory: string): Promise<string> {
  await assertManagerDirectory(directory);
  const path = join(directory, "manager-id.json");
  const previous = await readManagerJson(path);
  if (previous !== undefined) {
    if (!object(previous) || previous.schema_version !== 1 || typeof previous.manager_id !== "string" || !UPDATE_IDENTIFIER.test(previous.manager_id)) throw new UpdateFailure("local_state_invalid");
    return previous.manager_id;
  }
  const id = `manager_${randomUUID()}`;
  await atomicJson(directory, "manager-id.json", { schema_version: 1, manager_id: id });
  return id;
}
