import type { opendir, rm } from "node:fs/promises";
import type { ContextRecord, ContextIndex, CheckpointIntent } from "./model.js";
export interface ContextFilePort {
  readJsonBounded(path: string, maxBytes: number): Promise<{ readonly value: unknown; readonly bytes: number; readonly sha256: string }>;
  writeImmutable(path: string, data: string, assertAuthorized: () => void): Promise<void>;
  atomicReplace(path: string, data: string, assertAuthorized: () => void): Promise<void>;
  ensurePrivateDirectory(path: string, privateMode?: boolean): Promise<void>;
  assertPrivateDirectory(path: string, label: string): Promise<void>;
  pathExists(path: string): Promise<boolean>;
  readonly opendir: typeof opendir;
  readonly rm: typeof rm;
}
export interface ContextRecordPort {
  hasContextRecords(workspaceId: string): Promise<boolean>;
  readIndex(workspaceId: string, allowMissing: boolean): Promise<ContextIndex | undefined>;
  readPending(workspaceId: string): Promise<CheckpointIntent | undefined>;
  clearPending(expected: CheckpointIntent): Promise<void>;
  readRecord(workspaceId: string, contextId: string, revision: number): Promise<ContextRecord>;
  writeRecord(record: ContextRecord, assertAuthorized: () => void): Promise<void>;
  writeIndex(index: ContextIndex, assertAuthorized?: () => void): Promise<void>;
  ensureWritableWorkspace(workspaceId: string): Promise<void>;
  workspaceDir(workspaceId: string): string;
  contextDir(workspaceId: string, contextId: string): string;
  indexPath(workspaceId: string): string;
  pendingPath(workspaceId: string): string;
  recordPath(workspaceId: string, contextId: string, revision: number): string;
}
export interface ContextSerialPort {
  serialize<T>(workspaceId: string, action: () => Promise<T>): Promise<T>;
}
export type ContextRetentionPort = ContextSerialPort & Pick<ContextRecordPort, "readIndex" | "workspaceDir" | "recordPath">;
export type ContextRecoveryPort = ContextSerialPort & Pick<ContextRecordPort, "workspaceDir" | "recordPath" | "readPending" | "readRecord" | "writeIndex" | "clearPending">;
