import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, opendir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { RpcRuntimeError } from "./errors.js";
import { defaultRunnerStateDir } from "./state-path.js";
import { contextStorageLimits, contextStorageSummary, scanContextStorage, verifyContextStorageFile, checkContextDirectory, sameStorageStamp, type ContextStorageLimits, type ContextStorageFile } from "./context-storage.js";

const CONTEXT_SCHEMA_VERSION = 2;
const INDEX_SCHEMA_VERSION = 1;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_CONTEXTS = 256;
const MAX_REBUILD_FILES = 4_096;
const MAX_REBUILD_BYTES = 32 * 1024 * 1024;
const MAX_REBUILD_ENTRIES = 8_192;
const MAX_REBUILD_DURATION_MS = 4_000;
const NOFOLLOW = process.platform === "win32" ? 0 : constants.O_NOFOLLOW ?? 0;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
// One Runner owns a state directory. Share in-process serialization across
// reconstructed service instances; immutable writes remain exclusive.
const contextWrites = new Map<string, Promise<void>>();
const SAFE_COMMIT = /^[0-9a-fA-F]{7,64}$/u;

export type ContextEvidence = {
  readonly kind: "job" | "test" | "commit" | "note";
  readonly status: "claimed" | "observed";
  readonly job_id?: string;
  readonly job_status?: string;
  readonly exit_code?: number | null;
  readonly ref?: string;
  readonly summary?: string;
  readonly observed_at_ms?: number;
};

export type ContextRecord = {
  readonly schema_version: 1 | 2;
  readonly context_id: string;
  readonly workspace_id: string;
  readonly revision: number;
  readonly supersedes_revision: number | null;
  readonly turn_id: string;
  readonly fingerprint: string;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
  readonly policy_generation: number | null;
  readonly base_commit: string | null;
  readonly base_commit_status: "claimed" | "observed" | null;
  readonly base_worktree_state: "clean" | "dirty" | "unknown";
  readonly goal: string;
  readonly decisions: readonly string[];
  readonly evidence: readonly ContextEvidence[];
  readonly open_risks: readonly string[];
  readonly missing_checks: readonly string[];
  readonly next_actions: readonly string[];
  readonly review_state: "incomplete" | "claimed" | "evidence_backed";
};

type ContextIndexEntry = {
  readonly context_id: string;
  readonly revision: number;
  readonly turn_id: string;
  readonly fingerprint: string;
  readonly updated_at_ms: number;
  readonly base_commit: string | null;
  readonly goal: string;
  readonly review_state: ContextRecord["review_state"];
  readonly search_text: string;
};

type ContextIndex = {
  readonly schema_version: 1;
  readonly workspace_id: string;
  readonly rebuilt_at_ms: number | null;
  readonly records: readonly ContextIndexEntry[];
};

type CheckpointIntent = {
  readonly schema_version: 1;
  readonly workspace_id: string;
  readonly context_id: string;
  readonly revision: number;
  readonly fingerprint: string;
};

export interface ContextStoreOptions { readonly stateDir?: string; readonly storageLimits?: Partial<ContextStorageLimits> }

/**
 * Explicit, workspace-scoped handoff storage. Read-only methods never create
 * directories, indexes or records; only checkpoint/rebuild mutate local state.
 */
export class ContextStore {
  private readonly stateDir: string;
  private readonly contextsDir: string;
  private readonly storageLimits: ContextStorageLimits;


  public constructor(options: ContextStoreOptions = {}) {
    this.storageLimits = contextStorageLimits(options.storageLimits);
    this.stateDir = options.stateDir ?? defaultRunnerStateDir();
    if (!isAbsolute(this.stateDir) || this.stateDir.length === 0 || this.stateDir.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(this.stateDir) || resolve(this.stateDir) === parse(resolve(this.stateDir)).root) {
      throw new Error("stateDir must be an absolute non-root path without control characters");
    }
    this.contextsDir = join(this.stateDir, "contexts");
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
    const params = object(input), workspaceId = safeId(params.workspace_id, "workspace_id");
    const keepDays = boundedInteger(params.keep_days, 1, 3650, "keep_days");
    const keepRevisions = boundedInteger(params.keep_revisions, 1, 1000, "keep_revisions");
    const maxDelete = params.max_delete === undefined ? 128 : boundedInteger(params.max_delete, 1, 128, "max_delete");
    if (params.apply !== undefined && typeof params.apply !== "boolean") throw new RpcRuntimeError("invalid_params", "apply must be a boolean");
    const apply = params.apply === true;
    if (apply !== (params.expected_plan_hash !== undefined) || (apply && (typeof params.expected_plan_hash !== "string" || !/^[a-f0-9]{64}$/u.test(params.expected_plan_hash)))) throw new RpcRuntimeError("invalid_params", "Apply requires the exact expected_plan_hash from a fresh preview; previews must omit it");
    const generation = params.policy_generation === undefined ? null : boundedInteger(params.policy_generation, 0, Number.MAX_SAFE_INTEGER, "policy_generation");
    return this.serialize(workspaceId, async () => {
      assertAuthorized();
      const index = await this.readIndex(workspaceId, true);
      const directory = this.workspaceDir(workspaceId), inventory = await scanContextStorage(directory);
      if (index === undefined && inventory.files.length > 0) throw new RpcRuntimeError("context_index_missing", "Rebuild the index before planning retention");
      const deadline = performance.now() + 4000;
      let scannedBytes = 0, scannedFiles = 0;
      const groups = new Map<string, ContextStorageFile[]>();
      for (const file of inventory.files) { const group = groups.get(file.contextId) ?? []; group.push(file); groups.set(file.contextId, group); }
      if (index !== undefined && (index.records.length !== groups.size || new Set(index.records.map(record => record.context_id)).size !== groups.size)) throw new RpcRuntimeError("context_index_stale", "The index does not cover the stored contexts; preserve the records and rebuild before retention");
      const candidates: { file: ContextStorageFile; hash: string; latest: ContextStorageFile }[] = [];
      const readChecked = async (file: ContextStorageFile) => {
        if (++scannedFiles > MAX_REBUILD_FILES || performance.now() > deadline || scannedBytes + file.stamp.size > MAX_REBUILD_BYTES) throw new RpcRuntimeError("context_scan_budget", "Context retention inspection exceeded its budget; no records were removed");
        await verifyContextStorageFile(directory, file);
        const loaded = await readJsonBounded(this.recordPath(workspaceId, file.contextId, file.revision), MAX_RECORD_BYTES);
        scannedBytes += loaded.bytes;
        const record = parseRecord(loaded.value, workspaceId, file.contextId);
        if (record.revision !== file.revision) throw new RpcRuntimeError("context_record_corrupt", "Context revision does not match its filename");
        await verifyContextStorageFile(directory, file);
        return { record, hash: loaded.sha256 };
      };
      const cutoff = Date.now() - keepDays * 86400000;
      for (const [contextId, group] of groups) {
        group.sort((a, b) => b.revision - a.revision);
        const latest = group[0]!;
        const entry = index?.records.find(record => record.context_id === contextId);
        if (entry?.revision !== latest.revision) throw new RpcRuntimeError("context_index_stale", "Stored revision and index differ; rebuild before retention");
        const current = await readChecked(latest);
        if (entry.fingerprint !== current.record.fingerprint) throw new RpcRuntimeError("context_index_corrupt", "Index and current record disagree");
        for (const file of group.slice(keepRevisions)) {
          const loaded = await readChecked(file);
          if (loaded.record.updated_at_ms < cutoff) candidates.push({ file, hash: loaded.hash, latest });
        }
      }
      candidates.sort((a, b) => a.file.contextId < b.file.contextId ? -1 : a.file.contextId > b.file.contextId ? 1 : a.file.revision - b.file.revision);
      const selected = candidates.slice(0, maxDelete);
      const hash = createHash("sha256").update(JSON.stringify({ schema: 1, workspaceId, generation, keepDays, keepRevisions, maxDelete, inventory: inventory.digest, selected: selected.map(item => [item.file.contextId, item.file.revision, item.hash]) })).digest("hex");
      const summary = { workspace_id: workspaceId, retention_schema: 1, applied: false, complete: true, plan_hash: hash,
        keep_days: keepDays, keep_revisions: keepRevisions, max_delete: maxDelete,
        candidate_records: selected.length, candidate_bytes: selected.reduce((sum, item) => sum + item.file.stamp.size, 0),
        eligible_records: candidates.length, preserved_contexts: groups.size, has_more: selected.length < candidates.length,
        scanned_files: scannedFiles, scanned_bytes: scannedBytes, deleted_records: 0, deleted_bytes: 0 };
      if (performance.now() > deadline) throw new RpcRuntimeError("context_scan_budget", "Context retention inspection exceeded its time budget; no records were removed");
      assertAuthorized();
      if (!apply) return summary;
      if (params.expected_plan_hash !== hash) throw new RpcRuntimeError("context_plan_changed", "The retention preview is stale; request and review a new preview");
      let deletedRecords = 0, deletedBytes = 0;
      for (const item of selected) {
        try {
          if (performance.now() > deadline) throw new RpcRuntimeError("context_scan_budget", "The retention time budget was exhausted");
          await verifyContextStorageFile(directory, item.file);
          const loaded = await readJsonBounded(this.recordPath(workspaceId, item.file.contextId, item.file.revision), MAX_RECORD_BYTES);
          if (loaded.sha256 !== item.hash) throw new RpcRuntimeError("context_plan_changed", "A selected revision changed after preview");
          await verifyContextStorageFile(directory, item.latest);
          await verifyContextStorageFile(directory, item.file);
          // No intervening await between this current authorization check
          // and issuing the single-file deletion. OS-level races are not an
          // atomic multi-file transaction; preserve the current revision.
          assertAuthorized();
          await rm(this.recordPath(workspaceId, item.file.contextId, item.file.revision));
          deletedRecords += 1; deletedBytes += item.file.stamp.size;
        } catch (error) {
          if (deletedRecords > 0) throw new RpcRuntimeError("context_prune_partial", "Retention stopped after some old revisions were removed; inspect storage and create a new preview, do not assume rollback", { deleted_records: deletedRecords, deleted_bytes: deletedBytes });
          if (error instanceof RpcRuntimeError || (error instanceof Error && "code" in error && error.code === "stale_policy")) throw error;
          throw new RpcRuntimeError("context_plan_changed", "Retention could not safely remove the reviewed revision; preserve storage and request a new preview");
        }
      }
      return { ...summary, applied: true, deleted_records: deletedRecords, deleted_bytes: deletedBytes };
    });
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
      if (current !== undefined && await pathExists(this.recordPath(workspaceId, current.context_id, current.revision + 1))) throw new RpcRuntimeError("context_index_stale", "A newer context record exists; rebuild the derived index before writing");
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
      await writeImmutable(this.pendingPath(workspaceId), `${JSON.stringify(intent)}\n`, assertAuthorized);
      try { await this.writeRecord(record, assertAuthorized); }
      catch (error) {
        if (!await pathExists(this.recordPath(workspaceId, contextId, revision))) {
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
    const workspaceId = workspaceIdFrom(input);
    return this.serialize(workspaceId, async () => {
      assertAuthorized();
      const workspaceDir = this.workspaceDir(workspaceId);
      if (!await pathExists(workspaceDir)) return { workspace_id: workspaceId, rebuilt: false, records: 0, state: "missing" };
      await assertPrivateDirectory(workspaceDir, "context workspace directory");
      const pending = await this.readPending(workspaceId);
      const entries = await opendir(workspaceDir);
      const records: ContextIndexEntry[] = [];
      let scannedFiles = 0;
      let scannedBytes = 0;
      let scannedEntries = 0;
      const deadline = performance.now() + MAX_REBUILD_DURATION_MS;
      const consumeEntry = (): void => {
        if (++scannedEntries > MAX_REBUILD_ENTRIES || performance.now() > deadline) throw new RpcRuntimeError("context_rebuild_budget", "Context rebuild directory or time budget was exhausted");
      };
      for await (const item of entries) {
        consumeEntry();
        if (!item.isDirectory() || !SAFE_ID.test(item.name) || item.name === "." || item.name === "..") continue;
        const contextDir = join(workspaceDir, item.name);
        await assertPrivateDirectory(contextDir, "context record directory");
        const revisions = await opendir(contextDir);
        let latest: ContextRecord | undefined;
        for await (const revisionFile of revisions) {
          consumeEntry();
          if (!revisionFile.isFile() || !/^\d+\.json$/u.test(revisionFile.name)) continue;
          scannedFiles += 1;
          if (scannedFiles > MAX_REBUILD_FILES) throw new RpcRuntimeError("context_rebuild_budget", "context rebuild file budget was exhausted");
          const path = join(contextDir, revisionFile.name);
          const { value, bytes } = await readJsonBounded(path, MAX_RECORD_BYTES);
          scannedBytes += bytes;
          if (scannedBytes > MAX_REBUILD_BYTES) throw new RpcRuntimeError("context_rebuild_budget", "context rebuild byte budget was exhausted");
          const record = parseRecord(value, workspaceId, item.name);
          if (String(record.revision) + ".json" !== revisionFile.name) throw new RpcRuntimeError("context_record_corrupt", "Context record revision does not match its filename");
          if (latest === undefined || record.revision > latest.revision) latest = record;
        }
        if (latest !== undefined) records.push(indexEntry(latest));
      }
      records.sort((left, right) => right.updated_at_ms - left.updated_at_ms);
      if (records.length > MAX_CONTEXTS) throw new RpcRuntimeError("context_storage_full", "Rebuild would silently hide stored contexts; preserve and archive them explicitly instead");
      if (pending !== undefined && await pathExists(this.recordPath(workspaceId, pending.context_id, pending.revision))) {
        const committed = await this.readRecord(workspaceId, pending.context_id, pending.revision);
        if (committed.fingerprint !== pending.fingerprint) throw new RpcRuntimeError("context_record_corrupt", "Pending checkpoint and immutable record disagree");
        if (!records.some(record => record.context_id === pending.context_id && record.revision >= pending.revision)) throw new RpcRuntimeError("context_rebuild_budget", "Pending checkpoint cannot fit in the rebuilt index");
      }
      if (performance.now() > deadline) throw new RpcRuntimeError("context_rebuild_budget", "Context rebuild time budget was exhausted before index publication");
      const rebuiltAtMs = Date.now();
      await this.writeIndex({ schema_version: INDEX_SCHEMA_VERSION, workspace_id: workspaceId, rebuilt_at_ms: rebuiltAtMs, records }, assertAuthorized);
      if (pending !== undefined) await this.clearPending(pending);
      return { workspace_id: workspaceId, rebuilt: true, records: records.length, scanned_files: scannedFiles, scanned_bytes: scannedBytes, rebuilt_at_ms: rebuiltAtMs };
    });
  }

  private async hasContextRecords(workspaceId: string): Promise<boolean> {
    const directory = await opendir(this.workspaceDir(workspaceId));
    let scanned = 0;
    for await (const item of directory) {
      if (++scanned > MAX_CONTEXTS * 2) throw new RpcRuntimeError("context_rebuild_budget", "Context directory inspection exceeded its budget");
      if (item.isDirectory() || item.isSymbolicLink()) return true;
    }
    return false;
  }

  private async readIndex(workspaceId: string, allowMissing: boolean): Promise<ContextIndex | undefined> {
    if (await pathExists(this.pendingPath(workspaceId))) throw new RpcRuntimeError("context_index_stale", "An interrupted checkpoint needs an explicit index rebuild; saved history is not known to be complete");
    const path = this.indexPath(workspaceId);
    try {
      const { value } = await readJsonBounded(path, MAX_INDEX_BYTES);
      return parseIndex(value, workspaceId);
    } catch (error) {
      if (allowMissing && isErrno(error, "ENOENT")) return undefined;
      if (isErrno(error, "ENOENT")) return undefined;
      if (error instanceof RpcRuntimeError) throw error;
      throw new RpcRuntimeError("context_index_corrupt", "context index is unavailable or invalid", { next_action: "rebuild_context_index" });
    }
  }

  private async readPending(workspaceId: string): Promise<CheckpointIntent | undefined> {
    try {
      const { value } = await readJsonBounded(this.pendingPath(workspaceId), 4096);
      const record = object(value);
      if (record.schema_version !== 1 || record.workspace_id !== workspaceId || typeof record.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(record.fingerprint)) throw new RpcRuntimeError("context_record_corrupt", "Pending checkpoint binding is invalid");
      return { schema_version: 1, workspace_id: workspaceId, context_id: safeId(record.context_id, "context_id"), revision: boundedInteger(record.revision, 1, Number.MAX_SAFE_INTEGER, "revision"), fingerprint: record.fingerprint };
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw new RpcRuntimeError("context_record_corrupt", "Pending checkpoint is invalid; preserve the state for operator recovery");
    }
  }

  private async clearPending(expected: CheckpointIntent): Promise<void> {
    const current = await this.readPending(expected.workspace_id);
    if (current === undefined || current.context_id !== expected.context_id || current.revision !== expected.revision || current.fingerprint !== expected.fingerprint) throw new RpcRuntimeError("context_index_stale", "Pending checkpoint ownership changed; no recovery record was removed");
    await rm(this.pendingPath(expected.workspace_id));
  }

  private async readRecord(workspaceId: string, contextId: string, revision: number): Promise<ContextRecord> {
    try {
      const { value } = await readJsonBounded(this.recordPath(workspaceId, contextId, revision), MAX_RECORD_BYTES);
      const record = parseRecord(value, workspaceId, contextId);
      if (record.revision !== revision) throw new RpcRuntimeError("context_record_corrupt", "Context record revision does not match its filename");
      return record;
    } catch (error) {
      if (isErrno(error, "ENOENT")) throw new RpcRuntimeError("context_record_missing", "context record is missing; rebuild the local index if this was unexpected");
      throw error;
    }
  }

  private async writeRecord(record: ContextRecord, assertAuthorized: () => void): Promise<void> {
    const directory = this.contextDir(record.workspace_id, record.context_id);
    await ensurePrivateDirectory(directory);
    const path = this.recordPath(record.workspace_id, record.context_id, record.revision);
    const data = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(data) > MAX_RECORD_BYTES) throw new RpcRuntimeError("context_record_too_large", "context checkpoint exceeds the local record budget");
    await writeImmutable(path, data, assertAuthorized);
  }

  private async writeIndex(index: ContextIndex, assertAuthorized: () => void = () => {}): Promise<void> {
    const workspaceDir = this.workspaceDir(index.workspace_id);
    await ensurePrivateDirectory(workspaceDir);
    const data = `${JSON.stringify(index)}\n`;
    if (Buffer.byteLength(data) > MAX_INDEX_BYTES) throw new RpcRuntimeError("context_index_too_large", "context index exceeds its local budget");
    await atomicReplace(this.indexPath(index.workspace_id), data, assertAuthorized);
  }

  private async ensureWritableWorkspace(workspaceId: string): Promise<void> {
    await ensurePrivateDirectory(this.stateDir, false);
    await ensurePrivateDirectory(this.contextsDir);
    await ensurePrivateDirectory(this.workspaceDir(workspaceId));
  }

  private workspaceDir(workspaceId: string): string { return join(this.contextsDir, workspaceId); }
  private contextDir(workspaceId: string, contextId: string): string { return join(this.workspaceDir(workspaceId), contextId); }
  private indexPath(workspaceId: string): string { return join(this.workspaceDir(workspaceId), "index.json"); }
  private pendingPath(workspaceId: string): string { return join(this.workspaceDir(workspaceId), ".pending-checkpoint.json"); }
  private recordPath(workspaceId: string, contextId: string, revision: number): string { return join(this.contextDir(workspaceId, contextId), `${revision}.json`); }

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

type NormalizedCheckpoint = {
  readonly contextId: string | null;
  readonly turnId: string;
  readonly expectedRevision: number | null;
  readonly policyGeneration: number | null;
  readonly baseCommit: string | null;
  readonly baseCommitStatus: "claimed" | "observed" | null;
  readonly baseWorktreeState: "clean" | "dirty" | "unknown";
  readonly goal: string;
  readonly decisions: readonly string[];
  readonly evidence: readonly ContextEvidence[];
  readonly openRisks: readonly string[];
  readonly missingChecks: readonly string[];
  readonly nextActions: readonly string[];
};

function normalizeCheckpoint(params: Record<string, unknown>, workspaceId: string): NormalizedCheckpoint {
  if (params.workspace_id !== workspaceId) throw new RpcRuntimeError("invalid_params", "workspace_id changed while normalizing checkpoint");
  const contextId = params.context_id === undefined ? null : safeId(params.context_id, "context_id");
  const turnId = safeId(params.turn_id, "turn_id");
  const expectedRevision = params.expected_revision === undefined ? null : boundedInteger(params.expected_revision, 0, Number.MAX_SAFE_INTEGER, "expected_revision");
  const policyGeneration = params.policy_generation === undefined ? null : boundedInteger(params.policy_generation, 0, Number.MAX_SAFE_INTEGER, "policy_generation");
  const baseCommit = params.base_commit === undefined || params.base_commit === null ? null : boundedString(params.base_commit, "base_commit", 7, 64);
  if (baseCommit !== null && !SAFE_COMMIT.test(baseCommit)) throw new RpcRuntimeError("invalid_params", "base_commit is invalid");
  const baseCommitStatus = baseCommit === null ? null : params.base_commit_status === "observed" ? "observed" : "claimed";
  return {
    contextId,
    turnId,
    expectedRevision,
    policyGeneration,
    baseCommit,
    baseCommitStatus,
    baseWorktreeState: params.base_worktree_state === "clean" || params.base_worktree_state === "dirty" ? params.base_worktree_state : "unknown",
    goal: boundedString(params.goal, "goal", 1, 4_096),
    decisions: stringList(params.decisions, "decisions", 64, 2_048),
    evidence: evidenceList(params.evidence),
    openRisks: stringList(params.open_risks, "open_risks", 64, 2_048),
    missingChecks: stringList(params.missing_checks, "missing_checks", 64, 2_048),
    nextActions: stringList(params.next_actions, "next_actions", 64, 2_048),
  };
}

function evidenceList(value: unknown): readonly ContextEvidence[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) throw new RpcRuntimeError("invalid_params", "evidence must be a bounded array");
  return value.map((item) => {
    const source = object(item);
    if (!["job", "test", "commit", "note"].includes(String(source.kind))) throw new RpcRuntimeError("invalid_params", "evidence kind is invalid");
    if (source.status !== "claimed" && source.status !== "observed") throw new RpcRuntimeError("invalid_params", "evidence status is invalid");
    const evidence: Record<string, unknown> = { kind: source.kind, status: source.status };
    if (source.job_id !== undefined) evidence.job_id = safeId(source.job_id, "evidence.job_id");
    if (source.job_status !== undefined) evidence.job_status = boundedString(source.job_status, "evidence.job_status", 1, 64);
    if (source.exit_code === null || (typeof source.exit_code === "number" && Number.isSafeInteger(source.exit_code))) evidence.exit_code = source.exit_code;
    else if (source.exit_code !== undefined) throw new RpcRuntimeError("invalid_params", "evidence.exit_code is invalid");
    if (source.ref !== undefined) evidence.ref = boundedString(source.ref, "evidence.ref", 1, 256);
    if (source.summary !== undefined) evidence.summary = boundedString(source.summary, "evidence.summary", 1, 1_024);
    if (source.observed_at_ms !== undefined) evidence.observed_at_ms = boundedInteger(source.observed_at_ms, 0, Number.MAX_SAFE_INTEGER, "evidence.observed_at_ms");
    return evidence as ContextEvidence;
  });
}

function checkpointFingerprint(value: NormalizedCheckpoint, version: 1 | 2 = CONTEXT_SCHEMA_VERSION): string {
  // The v1 layout is frozen for reads of old records. New v2 records also
  // protect observation source, policy and worktree state in their digest.
  const original = { turn_id: value.turnId, base_commit: value.baseCommit, goal: value.goal, decisions: value.decisions, evidence: value.evidence, open_risks: value.openRisks, missing_checks: value.missingChecks, next_actions: value.nextActions };
  const payload = version === 1 ? original : { ...original, policy_generation: value.policyGeneration, base_commit_status: value.baseCommitStatus, base_worktree_state: value.baseWorktreeState };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
function semanticFingerprint(value: NormalizedCheckpoint): string {
  return checkpointFingerprint({ ...value, evidence: value.evidence.map(({ observed_at_ms: _observed, ...fact }) => fact) });
}

function indexEntry(record: ContextRecord): ContextIndexEntry {
  const evidence = record.evidence.flatMap((item) => [item.summary ?? "", item.ref ?? "", item.job_id ?? ""]);
  return {
    context_id: record.context_id,
    revision: record.revision,
    turn_id: record.turn_id,
    fingerprint: record.fingerprint,
    updated_at_ms: record.updated_at_ms,
    base_commit: record.base_commit,
    goal: record.goal,
    review_state: record.review_state,
    search_text: [record.goal, ...record.decisions, ...record.open_risks, ...record.missing_checks, ...record.next_actions, ...evidence, record.base_commit ?? ""].join("\n").toLocaleLowerCase().slice(0, 32 * 1024),
  };
}

function indexProjection(entry: ContextIndexEntry): Record<string, unknown> {
  return { context_id: entry.context_id, revision: entry.revision, turn_id: entry.turn_id, updated_at_ms: entry.updated_at_ms, base_commit: entry.base_commit, goal: entry.goal, review_state: entry.review_state };
}

function latestForTurn(index: ContextIndex, turnId: string): ContextIndexEntry | undefined {
  return index.records.filter((entry) => entry.turn_id === turnId).sort((left, right) => right.revision - left.revision || right.updated_at_ms - left.updated_at_ms)[0];
}

function emptyIndex(workspaceId: string): ContextIndex { return { schema_version: INDEX_SCHEMA_VERSION, workspace_id: workspaceId, rebuilt_at_ms: null, records: [] }; }

function parseIndex(value: unknown, workspaceId: string): ContextIndex {
  const source = object(value);
  if (source.schema_version !== INDEX_SCHEMA_VERSION || source.workspace_id !== workspaceId || !Array.isArray(source.records) || source.records.length > MAX_CONTEXTS) throw new RpcRuntimeError("context_index_corrupt", "context index schema or workspace binding is invalid");
  const records = source.records.map((item) => {
    const entry = object(item);
    const contextId = safeId(entry.context_id, "context_id");
    const turnId = safeId(entry.turn_id, "turn_id");
    const fingerprint = boundedString(entry.fingerprint, "fingerprint", 64, 64);
    if (!/^[a-f0-9]{64}$/u.test(fingerprint)) throw new RpcRuntimeError("context_index_corrupt", "context index fingerprint is invalid");
    const baseCommit = entry.base_commit === null ? null : boundedString(entry.base_commit, "base_commit", 7, 64);
    if (baseCommit !== null && !SAFE_COMMIT.test(baseCommit)) throw new RpcRuntimeError("context_index_corrupt", "context index commit is invalid");
    if (entry.review_state !== "incomplete" && entry.review_state !== "claimed" && entry.review_state !== "evidence_backed") throw new RpcRuntimeError("context_index_corrupt", "context index review state is invalid");
    return {
      context_id: contextId,
      revision: boundedInteger(entry.revision, 1, Number.MAX_SAFE_INTEGER, "revision"),
      turn_id: turnId,
      fingerprint,
      updated_at_ms: boundedInteger(entry.updated_at_ms, 0, Number.MAX_SAFE_INTEGER, "updated_at_ms"),
      base_commit: baseCommit,
      goal: boundedString(entry.goal, "goal", 1, 4_096),
      review_state: entry.review_state,
      search_text: boundedString(entry.search_text, "search_text", 0, 32 * 1024),
    } satisfies ContextIndexEntry;
  });
  return { schema_version: INDEX_SCHEMA_VERSION, workspace_id: workspaceId, rebuilt_at_ms: source.rebuilt_at_ms === null ? null : boundedInteger(source.rebuilt_at_ms, 0, Number.MAX_SAFE_INTEGER, "rebuilt_at_ms"), records };
}

function parseRecord(value: unknown, workspaceId: string, contextId: string): ContextRecord {
  const source = object(value);
  if ((source.schema_version !== 1 && source.schema_version !== CONTEXT_SCHEMA_VERSION) || source.workspace_id !== workspaceId || source.context_id !== contextId) throw new RpcRuntimeError("context_record_corrupt", "context record binding is invalid");
  if (source.schema_version === 2 && !["clean", "dirty", "unknown"].includes(String(source.base_worktree_state))) throw new RpcRuntimeError("context_record_corrupt", "Context worktree observation is invalid");
  const normalized = normalizeCheckpoint({
    workspace_id: workspaceId,
    context_id: contextId,
    turn_id: source.turn_id,
    expected_revision: source.revision,
    policy_generation: source.policy_generation ?? undefined,
    base_commit: source.base_commit,
    base_commit_status: source.base_commit_status,
    base_worktree_state: source.base_worktree_state,
    goal: source.goal,
    decisions: source.decisions,
    evidence: source.evidence,
    open_risks: source.open_risks,
    missing_checks: source.missing_checks,
    next_actions: source.next_actions,
  }, workspaceId);
  const fingerprint = boundedString(source.fingerprint, "fingerprint", 64, 64);
  if (!/^[a-f0-9]{64}$/u.test(fingerprint) || checkpointFingerprint(normalized, source.schema_version as 1 | 2) !== fingerprint) throw new RpcRuntimeError("context_record_corrupt", "context record fingerprint is invalid");
  const review = source.review_state;
  if (review !== "incomplete" && review !== "claimed" && review !== "evidence_backed") throw new RpcRuntimeError("context_record_corrupt", "context review state is invalid");
  return {
    schema_version: source.schema_version as 1 | 2,
    context_id: contextId,
    workspace_id: workspaceId,
    revision: boundedInteger(source.revision, 1, Number.MAX_SAFE_INTEGER, "revision"),
    supersedes_revision: source.supersedes_revision === null ? null : boundedInteger(source.supersedes_revision, 1, Number.MAX_SAFE_INTEGER, "supersedes_revision"),
    turn_id: normalized.turnId,
    fingerprint,
    created_at_ms: boundedInteger(source.created_at_ms, 0, Number.MAX_SAFE_INTEGER, "created_at_ms"),
    updated_at_ms: boundedInteger(source.updated_at_ms, 0, Number.MAX_SAFE_INTEGER, "updated_at_ms"),
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
    review_state: review,
  };
}

async function readJsonBounded(path: string, maxBytes: number): Promise<{ readonly value: unknown; readonly bytes: number; readonly sha256: string }> {
  await assertRegularParent(path);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new RpcRuntimeError("context_record_corrupt", "context file is not a bounded regular file");
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const finalInfo = await handle.stat();
    if (!finalInfo.isFile() || !sameStorageStamp(info, finalInfo) || finalInfo.size > maxBytes) throw new RpcRuntimeError("context_record_corrupt", "context file changed or exceeds its budget");
    const data = Buffer.alloc(finalInfo.size);
    let offset = 0;
    let attempts = 0;
    while (offset < data.byteLength) {
      if (++attempts > 64) throw new RpcRuntimeError("context_scan_budget", "Context read exceeded its bounded partial-read attempts");
      const { bytesRead } = await handle.read(data, offset, data.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (!sameStorageStamp(after, finalInfo) || offset !== data.byteLength) throw new RpcRuntimeError("context_record_corrupt", "context file changed while reading");
    let value: unknown;
    try { value = JSON.parse(data.toString("utf8")); } catch { throw new RpcRuntimeError("context_record_corrupt", "Context record is not valid JSON"); }
    return { value, bytes: data.byteLength, sha256: createHash("sha256").update(data).digest("hex") };
  } finally { await handle.close(); }
}

async function writeImmutable(path: string, data: string, assertAuthorized: () => void): Promise<void> {
  await assertRegularParent(path);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    assertAuthorized();
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    created = true;
    assertAuthorized();
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    if (isErrno(error, "EEXIST")) throw conflict("context_revision_conflict", "context revision already exists");
    if (created) await rm(path, { force: true }).catch(() => undefined);
    throw error;
  } finally { await handle?.close().catch(() => undefined); }
}

async function atomicReplace(path: string, data: string, assertAuthorized: () => void): Promise<void> {
  await assertRegularParent(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    assertAuthorized();
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}

async function ensurePrivateDirectory(path: string, privateMode = true): Promise<void> {
  const normalized = resolve(path);
  const root = parse(normalized).root;
  const components = relative(root, normalized).split(sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = join(current, component);
    let info = await lstat(current).catch((error: unknown) => isErrno(error, "ENOENT") ? undefined : Promise.reject(error));
    if (info === undefined) { await mkdir(current, { mode: 0o700 }); info = await lstat(current); }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new RpcRuntimeError("context_storage_unsafe", "context state directory is not a regular directory");
    if (current === normalized && process.platform !== "win32") {
      if (!privateMode && (info.mode & 0o022) !== 0) throw new RpcRuntimeError("context_storage_unsafe", "Runner state directory is writable by group or others");
      if (privateMode && (info.mode & 0o077) !== 0) {
        await chmod(current, 0o700);
        const tightened = await lstat(current);
        if ((tightened.mode & 0o077) !== 0) throw new RpcRuntimeError("context_storage_unsafe", "context directory could not be made private");
      }
    }
  }
}

async function assertPrivateDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new RpcRuntimeError("context_storage_unsafe", `${label} is not a regular directory`);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new RpcRuntimeError("context_storage_unsafe", `${label} is not private`);
}

async function assertRegularParent(path: string): Promise<void> {
  await checkContextDirectory(dirname(path));
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (isErrno(error, "ENOENT")) return false; throw error; }
}

function workspaceIdFrom(input: unknown): string { return safeId(object(input).workspace_id, "workspace_id"); }
function object(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RpcRuntimeError("invalid_params", "parameters must be an object"); return value as Record<string, unknown>; }
function safeId(value: unknown, field: string): string { if (typeof value !== "string" || !SAFE_ID.test(value)) throw new RpcRuntimeError("invalid_params", `${field} is invalid`); return value; }
function boundedString(value: unknown, field: string, min: number, max: number): string { if (typeof value !== "string" || value.length < min || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new RpcRuntimeError("invalid_params", `${field} is invalid`); return value; }
function boundedInteger(value: unknown, min: number, max: number, field: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new RpcRuntimeError("invalid_params", `${field} is invalid`); return value; }
function boundedIntegerString(value: unknown, min: number, max: number, field: string): number { if (typeof value !== "string" || !/^\d+$/u.test(value)) throw new RpcRuntimeError("invalid_params", `${field} is invalid`); const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new RpcRuntimeError("invalid_params", `${field} is invalid`); return parsed; }
function stringList(value: unknown, field: string, maxItems: number, maxLength: number): readonly string[] { if (value === undefined) return []; if (!Array.isArray(value) || value.length > maxItems) throw new RpcRuntimeError("invalid_params", `${field} must be a bounded array`); return value.map((item) => boundedString(item, field, 1, maxLength)); }
function isErrno(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { readonly code?: unknown }).code === code; }
function conflict(code: string, message: string, details?: Record<string, unknown>): RpcRuntimeError { return new RpcRuntimeError(code, message, details); }
