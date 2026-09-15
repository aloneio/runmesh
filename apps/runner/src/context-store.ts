import { randomUUID } from "node:crypto";
import { isAbsolute, join, parse, resolve } from "node:path";
import { RpcRuntimeError } from "./errors.js";
import { defaultRunnerStateDir } from "./state-path.js";
import { contextStorageLimits, contextStorageSummary, scanContextStorage, type ContextStorageLimits } from "./context-storage.js";
import { ContextRepository } from "./context/repository.js";
import { nativeContextFiles } from "./context/files.js";
import type { ContextFilePort, ContextRecordPort } from "./context/ports.js";
import { pruneContext } from "./context/retention.js";
import { rebuildContext } from "./context/recovery.js";
import { CONTEXT_SCHEMA_VERSION, INDEX_SCHEMA_VERSION, MAX_RECORD_BYTES, MAX_INDEX_BYTES, MAX_CONTEXTS, workspaceIdFrom, object, safeId, boundedString, boundedInteger, boundedIntegerString, normalizeCheckpoint, conflict, emptyIndex, latestForTurn, semanticFingerprint, checkpointFingerprint, indexEntry, indexProjection, type ContextRecord, type ContextIndex, type CheckpointIntent } from "./context/model.js";
export type { ContextEvidence, ContextRecord } from "./context/model.js";

// One Runner owns a state directory. Share in-process serialization across
// reconstructed service instances; immutable writes remain exclusive.
const contextWrites = new Map<string, Promise<void>>();

/** @internal Trusted internal dependencies only; durable formats and serialization stay owned here. */
export interface ContextStoreDependencies { readonly repository?: ContextRecordPort; readonly files?: ContextFilePort }

export interface ContextStoreOptions { readonly stateDir?: string; readonly storageLimits?: Partial<ContextStorageLimits> }

/**
 * Explicit, workspace-scoped handoff storage. Read-only methods never create
 * directories, indexes or records; checkpoint/rebuild/prune explicitly mutate state.
 */
export class ContextStore {
  private readonly repository: ContextRecordPort;
  private readonly files: ContextFilePort;
  private readonly stateDir: string;
  private readonly contextsDir: string;
  private readonly storageLimits: ContextStorageLimits;

  public constructor(options?: ContextStoreOptions);
  /** @internal Trusted internal adapter injection is not part of the package API. */
  public constructor(options: ContextStoreOptions, dependencies: ContextStoreDependencies);
  public constructor(options: ContextStoreOptions = {}, dependencies: ContextStoreDependencies = {}) {
    this.files = dependencies.files ?? nativeContextFiles;
    this.storageLimits = contextStorageLimits(options.storageLimits);
    this.stateDir = options.stateDir ?? defaultRunnerStateDir();
    if (!isAbsolute(this.stateDir) || this.stateDir.length === 0 || this.stateDir.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(this.stateDir) || resolve(this.stateDir) === parse(resolve(this.stateDir)).root) {
      throw new Error("stateDir must be an absolute non-root path without control characters");
    }
    this.contextsDir = join(this.stateDir, "contexts");
    this.repository = dependencies.repository ?? new ContextRepository(this.stateDir, this.contextsDir, this.files);
  }

  public async bootstrap(input: unknown): Promise<Record<string, unknown>> {
    const workspaceId = workspaceIdFrom(input);
    const index = await this.readIndex(workspaceId, true);
    if (index === undefined || index.records.length === 0) return { workspace_id: workspaceId, state: "missing", context: null };
    const latest = [...index.records].sort((left, right) => right.updated_at_ms - left.updated_at_ms || right.revision - left.revision)[0];
    if (latest === undefined) return { workspace_id: workspaceId, state: "missing", context: null };
    const record = await this.readRecord(workspaceId, latest.context_id, latest.revision);
    return { workspace_id: workspaceId, state: "ready", context: record };
  }

  public async read(input: unknown): Promise<Record<string, unknown>> {
    const params = object(input);
    const workspaceId = safeId(params.workspace_id, "workspace_id");
    const contextId = safeId(params.context_id, "context_id");
    const index = await this.readIndex(workspaceId, true);
    if (index === undefined) return { workspace_id: workspaceId, state: "missing", context: null };
    const entry = index.records.find((candidate) => candidate.context_id === contextId);
    if (entry === undefined) return { workspace_id: workspaceId, state: "missing", context: null };
    const revision = params.revision === undefined ? entry.revision : boundedInteger(params.revision, 1, Number.MAX_SAFE_INTEGER, "revision");
    const record = await this.readRecord(workspaceId, contextId, revision);
    return { workspace_id: workspaceId, state: "ready", context: record };
  }

  public async search(input: unknown): Promise<Record<string, unknown>> {
    const params = object(input);
    const workspaceId = safeId(params.workspace_id, "workspace_id");
    const query = boundedString(params.query, "query", 1, 512).toLocaleLowerCase();
    const limit = params.limit === undefined ? 20 : boundedInteger(params.limit, 1, 50, "limit");
    const offset = params.cursor === undefined ? 0 : boundedIntegerString(params.cursor, 0, MAX_CONTEXTS, "cursor");
    const index = await this.readIndex(workspaceId, true);
    if (index === undefined) return { workspace_id: workspaceId, query, results: [], next_cursor: null, scanned_records: 0, state: "missing" };
    const matches = index.records.filter((entry) => entry.search_text.includes(query)).sort((left, right) => right.updated_at_ms - left.updated_at_ms || right.revision - left.revision);
    const page = matches.slice(offset, offset + limit).map(indexProjection);
    const next = offset + page.length;
    return { workspace_id: workspaceId, query, results: page, next_cursor: next < matches.length ? String(next) : null, scanned_records: index.records.length, state: "ready" };
  }

  public storage(input: unknown): Promise<Record<string, unknown>> {
    const workspaceId = workspaceIdFrom(input);
    return this.serialize(workspaceId, async () => ({ workspace_id: workspaceId, ...contextStorageSummary(await scanContextStorage(this.workspaceDir(workspaceId)), this.storageLimits) }));
  }

  /** Only superseded revisions may be pruned. The current index/record never
   * changes, so an interrupted unlink batch needs a new preview, not journal
   * replay or a fabricated all-files transaction. No automatic retention. */
  public async prune(input: unknown, assertAuthorized: () => void = () => {}): Promise<Record<string, unknown>> {
    return pruneContext(input, assertAuthorized, { serialize: (workspaceId, action) => this.serialize(workspaceId, action),
      readIndex: (...args) => this.readIndex(...args),
      workspaceDir: (...args) => this.workspaceDir(...args),
      recordPath: (...args) => this.recordPath(...args) }, this.files);
  }

  public checkpoint(input: unknown, assertAuthorized: () => void = () => {}): Promise<Record<string, unknown>> {
    const params = object(input);
    const workspaceId = safeId(params.workspace_id, "workspace_id");
    return this.serialize(workspaceId, async () => {
      assertAuthorized();
      const normalized = normalizeCheckpoint(params, workspaceId);
      await this.ensureWritableWorkspace(workspaceId);
      const savedIndex = await this.readIndex(workspaceId, false);
      if (savedIndex === undefined && await this.hasContextRecords(workspaceId)) throw new RpcRuntimeError("context_index_missing", "Existing context records need an explicit index rebuild before another checkpoint");
      const index = savedIndex ?? emptyIndex(workspaceId);
      const sameTurn = index.records.filter((entry) => entry.turn_id === normalized.turnId);
      if (normalized.contextId === null && sameTurn.length > 1) throw conflict("context_turn_conflict", "More than one context uses this turn; select an explicit context_id");
      const current = normalized.contextId === null ? latestForTurn(index, normalized.turnId) : index.records.find((entry) => entry.context_id === normalized.contextId);
      if (normalized.contextId !== null && current === undefined) throw conflict("context_revision_conflict", "The requested context does not exist");
      if (current !== undefined && current.turn_id !== normalized.turnId) throw conflict("context_turn_conflict", "context belongs to a different turn");
      const previous = current === undefined ? undefined : await this.readRecord(workspaceId, current.context_id, current.revision);
      if (previous !== undefined && previous.fingerprint !== current!.fingerprint) throw new RpcRuntimeError("context_index_corrupt", "Context index does not match its immutable record");
      if (current !== undefined && await this.files.pathExists(this.recordPath(workspaceId, current.context_id, current.revision + 1))) throw new RpcRuntimeError("context_index_stale", "A newer context record exists; rebuild the derived index before writing");
      // Content equality excludes collection time, not the evidence's actual
      // identity/status. A last-write retry may carry its original parent
      // revision; an older or conflicting write must still fail.
      const sameContent = previous !== undefined && semanticFingerprint(normalized) === semanticFingerprint(normalizeCheckpoint({
        ...previous, policy_generation: previous.policy_generation ?? undefined,
      }, workspaceId));
      const compatibleRevision = normalized.expectedRevision === null || normalized.expectedRevision === current?.revision || normalized.expectedRevision === previous?.supersedes_revision || (previous?.revision === 1 && normalized.expectedRevision === 0);
      if (sameContent && compatibleRevision) { assertAuthorized(); return { workspace_id: workspaceId, deduplicated: true, context: previous }; }
      if (normalized.expectedRevision !== null && normalized.expectedRevision !== (current?.revision ?? 0)) throw conflict("context_revision_conflict", "context revision changed", { expected_revision: normalized.expectedRevision, actual_revision: current?.revision ?? 0 });
      const contextId = current?.context_id ?? `ctx-${randomUUID()}`;
      const fingerprint = checkpointFingerprint(normalized);
      const now = Date.now();
      const revision = (current?.revision ?? 0) + 1;
      const reviewState: ContextRecord["review_state"] = normalized.missingChecks.length > 0 ? "incomplete" : normalized.evidence.some((item) => item.status === "observed") ? "evidence_backed" : "claimed";
      const record: ContextRecord = {
        schema_version: CONTEXT_SCHEMA_VERSION,
        context_id: contextId,
        workspace_id: workspaceId,
        revision,
        supersedes_revision: current?.revision ?? null,
        turn_id: normalized.turnId,
        fingerprint,
        created_at_ms: previous?.created_at_ms ?? now,
        updated_at_ms: now,
        policy_generation: normalized.policyGeneration,
        base_commit: normalized.baseCommit,
        base_commit_status: normalized.baseCommitStatus,
        base_worktree_state: normalized.baseWorktreeState,
        goal: normalized.goal,
        decisions: normalized.decisions,
        evidence: normalized.evidence,
        open_risks: normalized.openRisks,
        missing_checks: normalized.missingChecks,
        next_actions: normalized.nextActions,
        review_state: reviewState,
      };
      const entry = indexEntry(record);
      const records = index.records.filter((item) => item.context_id !== contextId);
      records.push(entry);
      if (records.length > this.storageLimits.maxContexts) throw new RpcRuntimeError("context_storage_full", "Context count limit reached; existing history was not evicted");
      const nextIndex: ContextIndex = { schema_version: INDEX_SCHEMA_VERSION, workspace_id: workspaceId, rebuilt_at_ms: index.rebuilt_at_ms, records };
      if (Buffer.byteLength(JSON.stringify(record)) + 1 > MAX_RECORD_BYTES) throw new RpcRuntimeError("context_record_too_large", "Context checkpoint exceeds the local record budget");
      if (Buffer.byteLength(JSON.stringify(nextIndex)) + 1 > MAX_INDEX_BYTES) throw new RpcRuntimeError("context_index_too_large", "Context index exceeds its local budget");
      const usage = await scanContextStorage(this.workspaceDir(workspaceId));
      if (usage.files.length + 1 > this.storageLimits.maxRecords || usage.bytes + Buffer.byteLength(JSON.stringify(record)) + 1 > this.storageLimits.maxBytes || usage.contexts + (current === undefined ? 1 : 0) > this.storageLimits.maxContexts) throw new RpcRuntimeError("context_storage_full", "Context storage budget reached; inspect storage and explicitly review retention before adding a new revision");
      // Persist the intent first, including for a new turn beside an existing
      // index. An interrupted write must not generate another random context.
      const intent: CheckpointIntent = { schema_version: 1, workspace_id: workspaceId, context_id: contextId, revision, fingerprint };
      await this.files.writeImmutable(this.pendingPath(workspaceId), `${JSON.stringify(intent)}\n`, assertAuthorized);
      try { await this.writeRecord(record, assertAuthorized); }
      catch (error) {
        if (!await this.files.pathExists(this.recordPath(workspaceId, contextId, revision))) {
          await this.clearPending(intent);
          throw error;
        }
        throw new RpcRuntimeError("context_index_stale", "Checkpoint outcome needs an explicit index rebuild before another write", { context_id: contextId, revision });
      }
      try { await this.writeIndex(nextIndex, assertAuthorized); await this.clearPending(intent); }
      catch { throw new RpcRuntimeError("context_index_stale", "Checkpoint record was committed but its derived index was not updated; rebuild the index, then retry the same input", { context_id: contextId, revision }); }
      return { workspace_id: workspaceId, deduplicated: false, context: record };
    });
  }

  public rebuild(input: unknown, assertAuthorized: () => void = () => {}): Promise<Record<string, unknown>> {
    return rebuildContext(input, assertAuthorized, { serialize: (workspaceId, action) => this.serialize(workspaceId, action),
      workspaceDir: (...args) => this.workspaceDir(...args),
      recordPath: (...args) => this.recordPath(...args),
      readPending: (...args) => this.readPending(...args),
      readRecord: (...args) => this.readRecord(...args),
      writeIndex: (...args) => this.writeIndex(...args),
      clearPending: (...args) => this.clearPending(...args) }, this.files);
  }

  private hasContextRecords(workspaceId: string): Promise<boolean> { return this.repository.hasContextRecords(workspaceId); }

  private readIndex(workspaceId: string, allowMissing: boolean): Promise<ContextIndex | undefined> { return this.repository.readIndex(workspaceId, allowMissing); }

  private readPending(workspaceId: string): Promise<CheckpointIntent | undefined> { return this.repository.readPending(workspaceId); }

  private clearPending(expected: CheckpointIntent): Promise<void> { return this.repository.clearPending(expected); }

  private readRecord(workspaceId: string, contextId: string, revision: number): Promise<ContextRecord> { return this.repository.readRecord(workspaceId, contextId, revision); }

  private writeRecord(record: ContextRecord, assertAuthorized: () => void): Promise<void> { return this.repository.writeRecord(record, assertAuthorized); }

  private writeIndex(index: ContextIndex, assertAuthorized: () => void = () => {}): Promise<void> { return this.repository.writeIndex(index, assertAuthorized); }

  private ensureWritableWorkspace(workspaceId: string): Promise<void> { return this.repository.ensureWritableWorkspace(workspaceId); }

  private workspaceDir(workspaceId: string): string { return this.repository.workspaceDir(workspaceId); }

  private pendingPath(workspaceId: string): string { return this.repository.pendingPath(workspaceId); }
  private recordPath(workspaceId: string, contextId: string, revision: number): string { return this.repository.recordPath(workspaceId, contextId, revision); }

  private serialize<T>(workspaceId: string, action: () => Promise<T>): Promise<T> {
    const path = resolve(this.workspaceDir(workspaceId));
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    const prior = contextWrites.get(key) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(action);
    const marker = run.then(() => undefined, () => undefined);
    contextWrites.set(key, marker);
    return run.finally(() => { if (contextWrites.get(key) === marker) contextWrites.delete(key); });
  }
}
