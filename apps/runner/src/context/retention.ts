import { RpcRuntimeError } from "../errors.js";
import { scanContextStorage, verifyContextStorageFile, type ContextStorageFile } from "../context-storage.js";
import { MAX_REBUILD_FILES, MAX_REBUILD_BYTES, MAX_RECORD_BYTES, object, safeId, boundedInteger, parseRecord } from "./model.js";
import { nativeContextFiles } from "./files.js";
import { planContextRetention } from "./retention-plan.js";
import type { ContextRetentionPort, ContextFilePort } from "./ports.js";

export function pruneContext(input: unknown, assertAuthorized: () => void, ports: ContextRetentionPort, files: ContextFilePort = nativeContextFiles): Promise<Record<string, unknown>> {
    const params = object(input), workspaceId = safeId(params.workspace_id, "workspace_id");
    const keepDays = boundedInteger(params.keep_days, 1, 3650, "keep_days");
    const keepRevisions = boundedInteger(params.keep_revisions, 1, 1000, "keep_revisions");
    const maxDelete = params.max_delete === undefined ? 128 : boundedInteger(params.max_delete, 1, 128, "max_delete");
    if (params.apply !== undefined && typeof params.apply !== "boolean") throw new RpcRuntimeError("invalid_params", "apply must be a boolean");
    const apply = params.apply === true;
    if (apply !== (params.expected_plan_hash !== undefined) || (apply && (typeof params.expected_plan_hash !== "string" || !/^[a-f0-9]{64}$/u.test(params.expected_plan_hash)))) throw new RpcRuntimeError("invalid_params", "Apply requires the exact expected_plan_hash from a fresh preview; previews must omit it");
    const generation = params.policy_generation === undefined ? null : boundedInteger(params.policy_generation, 0, Number.MAX_SAFE_INTEGER, "policy_generation");
    return ports.serialize(workspaceId, async () => {
      assertAuthorized();
      const index = await ports.readIndex(workspaceId, true);
      const directory = ports.workspaceDir(workspaceId), inventory = await scanContextStorage(directory);
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
        const loaded = await files.readJsonBounded(ports.recordPath(workspaceId, file.contextId, file.revision), MAX_RECORD_BYTES);
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
      const { selected, summary } = planContextRetention({ workspaceId, generation, keepDays, keepRevisions, maxDelete, inventoryDigest: inventory.digest, candidates, preservedContexts: groups.size, scannedFiles, scannedBytes });
      const hash = summary.plan_hash;
      if (performance.now() > deadline) throw new RpcRuntimeError("context_scan_budget", "Context retention inspection exceeded its time budget; no records were removed");
      assertAuthorized();
      if (!apply) return summary;
      if (params.expected_plan_hash !== hash) throw new RpcRuntimeError("context_plan_changed", "The retention preview is stale; request and review a new preview");
      let deletedRecords = 0, deletedBytes = 0;
      for (const item of selected) {
        try {
          if (performance.now() > deadline) throw new RpcRuntimeError("context_scan_budget", "The retention time budget was exhausted");
          await verifyContextStorageFile(directory, item.file);
          const loaded = await files.readJsonBounded(ports.recordPath(workspaceId, item.file.contextId, item.file.revision), MAX_RECORD_BYTES);
          if (loaded.sha256 !== item.hash) throw new RpcRuntimeError("context_plan_changed", "A selected revision changed after preview");
          await verifyContextStorageFile(directory, item.latest);
          await verifyContextStorageFile(directory, item.file);
          // No intervening await between this current authorization check
          // and issuing the single-file deletion. OS-level races are not an
          // atomic multi-file transaction; preserve the current revision.
          assertAuthorized();
          await files.rm(ports.recordPath(workspaceId, item.file.contextId, item.file.revision));
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
