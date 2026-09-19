import { join } from "node:path";
import { RpcRuntimeError } from "../errors.js";
import { MAX_CONTEXTS, MAX_RECORD_BYTES, MAX_INDEX_BYTES, object, safeId, boundedInteger, parseIndex, parseRecord, isErrno, type ContextIndex, type ContextRecord, type CheckpointIntent } from "./model.js";
import { nativeContextFiles } from "./files.js";
import type { ContextRecordPort, ContextFilePort } from "./ports.js";

/** Same private paths and bounded file operations; the facade owns serialization. */
export class ContextRepository implements ContextRecordPort {
  public constructor(private readonly stateDir: string, private readonly contextsDir: string, private readonly files: ContextFilePort = nativeContextFiles) {}

  public async hasContextRecords(workspaceId: string): Promise<boolean> {
    const directory = await this.files.opendir(this.workspaceDir(workspaceId));
    let scanned = 0;
    for await (const item of directory) {
      if (++scanned > MAX_CONTEXTS * 2) throw new RpcRuntimeError("context_rebuild_budget", "Context directory inspection exceeded its budget");
      if (item.isDirectory() || item.isSymbolicLink()) return true;
    }
    return false;
  }

  public async readIndex(workspaceId: string, allowMissing: boolean): Promise<ContextIndex | undefined> {
    if (await this.files.pathExists(this.pendingPath(workspaceId))) throw new RpcRuntimeError("context_index_stale", "An interrupted checkpoint needs an explicit index rebuild; saved history is not known to be complete");
    const path = this.indexPath(workspaceId);
    try {
      const { value } = await this.files.readJsonBounded(path, MAX_INDEX_BYTES);
      return parseIndex(value, workspaceId);
    } catch (error) {
      if (allowMissing && isErrno(error, "ENOENT")) return undefined;
      if (isErrno(error, "ENOENT")) return undefined;
      if (error instanceof RpcRuntimeError) throw error;
      throw new RpcRuntimeError("context_index_corrupt", "context index is unavailable or invalid", { next_action: "rebuild_context_index" });
    }
  }

  public async readPending(workspaceId: string): Promise<CheckpointIntent | undefined> {
    try {
      const { value } = await this.files.readJsonBounded(this.pendingPath(workspaceId), 4096);
      const record = object(value);
      if (record.schema_version !== 1 || record.workspace_id !== workspaceId || typeof record.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(record.fingerprint)) throw new RpcRuntimeError("context_record_corrupt", "Pending checkpoint binding is invalid");
      return { schema_version: 1, workspace_id: workspaceId, context_id: safeId(record.context_id, "context_id"), revision: boundedInteger(record.revision, 1, Number.MAX_SAFE_INTEGER, "revision"), fingerprint: record.fingerprint };
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw new RpcRuntimeError("context_record_corrupt", "Pending checkpoint is invalid; preserve the state for operator recovery");
    }
  }

  public async clearPending(expected: CheckpointIntent): Promise<void> {
    const current = await this.readPending(expected.workspace_id);
    if (current === undefined || current.context_id !== expected.context_id || current.revision !== expected.revision || current.fingerprint !== expected.fingerprint) throw new RpcRuntimeError("context_index_stale", "Pending checkpoint ownership changed; no recovery record was removed");
    await this.files.rm(this.pendingPath(expected.workspace_id));
  }

  public async readRecord(workspaceId: string, contextId: string, revision: number): Promise<ContextRecord> {
    try {
      const { value } = await this.files.readJsonBounded(this.recordPath(workspaceId, contextId, revision), MAX_RECORD_BYTES);
      const record = parseRecord(value, workspaceId, contextId);
      if (record.revision !== revision) throw new RpcRuntimeError("context_record_corrupt", "Context record revision does not match its filename");
      return record;
    } catch (error) {
      if (isErrno(error, "ENOENT")) throw new RpcRuntimeError("context_record_missing", "context record is missing; rebuild the local index if this was unexpected");
      throw error;
    }
  }

  public async writeRecord(record: ContextRecord, assertAuthorized: () => void): Promise<void> {
    const directory = this.contextDir(record.workspace_id, record.context_id);
    await this.files.ensurePrivateDirectory(directory);
    const path = this.recordPath(record.workspace_id, record.context_id, record.revision);
    const data = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(data) > MAX_RECORD_BYTES) throw new RpcRuntimeError("context_record_too_large", "context checkpoint exceeds the local record budget");
    await this.files.writeImmutable(path, data, assertAuthorized);
  }

  public async writeIndex(index: ContextIndex, assertAuthorized: () => void = () => {}): Promise<void> {
    const workspaceDir = this.workspaceDir(index.workspace_id);
    await this.files.ensurePrivateDirectory(workspaceDir);
    const data = `${JSON.stringify(index)}\n`;
    if (Buffer.byteLength(data) > MAX_INDEX_BYTES) throw new RpcRuntimeError("context_index_too_large", "context index exceeds its local budget");
    await this.files.atomicReplace(this.indexPath(index.workspace_id), data, assertAuthorized);
  }

  public async ensureWritableWorkspace(workspaceId: string): Promise<void> {
    await this.files.ensurePrivateDirectory(this.stateDir, false);
    await this.files.ensurePrivateDirectory(this.contextsDir);
    await this.files.ensurePrivateDirectory(this.workspaceDir(workspaceId));
  }

  public workspaceDir(workspaceId: string): string { return join(this.contextsDir, workspaceId); }

  public contextDir(workspaceId: string, contextId: string): string { return join(this.workspaceDir(workspaceId), contextId); }

  public indexPath(workspaceId: string): string { return join(this.workspaceDir(workspaceId), "index.json"); }

  public pendingPath(workspaceId: string): string { return join(this.workspaceDir(workspaceId), ".pending-checkpoint.json"); }

  public recordPath(workspaceId: string, contextId: string, revision: number): string { return join(this.contextDir(workspaceId, contextId), `${revision}.json`); }
}
