import { join } from "node:path";
import { RpcRuntimeError } from "../errors.js";
import { INDEX_SCHEMA_VERSION, MAX_CONTEXTS, MAX_REBUILD_FILES, MAX_REBUILD_BYTES, MAX_REBUILD_ENTRIES, MAX_REBUILD_DURATION_MS, MAX_RECORD_BYTES, SAFE_ID, workspaceIdFrom, parseRecord, indexEntry, type ContextIndexEntry, type ContextRecord } from "./model.js";
import { nativeContextFiles } from "./files.js";
import type { ContextRecoveryPort, ContextFilePort } from "./ports.js";

// Checkpoint creation reserves ctx-<randomUUID()> names for record directories.
// A substituted file at that name is history evidence, not an unrelated file.
const GENERATED_CONTEXT_ID = /^ctx-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Explicit index recovery; it never upgrades or repairs immutable records. */
export function rebuildContext(input: unknown, assertAuthorized: () => void, ports: ContextRecoveryPort, files: ContextFilePort = nativeContextFiles): Promise<Record<string, unknown>> {
    const workspaceId = workspaceIdFrom(input);
    return ports.serialize(workspaceId, async () => {
      assertAuthorized();
      const workspaceDir = ports.workspaceDir(workspaceId);
      if (!await files.pathExists(workspaceDir)) return { workspace_id: workspaceId, rebuilt: false, records: 0, state: "missing" };
      await files.assertPrivateDirectory(workspaceDir, "context workspace directory");
      const pending = await ports.readPending(workspaceId);
      const entries = await files.opendir(workspaceDir);
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
        if ((!item.isDirectory() && !item.isSymbolicLink() && !GENERATED_CONTEXT_ID.test(item.name)) || !SAFE_ID.test(item.name) || item.name === "." || item.name === "..") continue;
        const contextDir = join(workspaceDir, item.name);
        // A linked or replaced context may hide saved history. Let the existing
        // directory boundary reject it instead of publishing an incomplete index.
        await files.assertPrivateDirectory(contextDir, "context record directory");
        const revisions = await files.opendir(contextDir);
        let latest: ContextRecord | undefined;
        for await (const revisionFile of revisions) {
          consumeEntry();
          // Relevant revision names must pass the bounded file reader even
          // when their entry type changed; skipping one can select an older
          // revision as current. Unrelated names remain outside this scan.
          if (!/^\d+\.json$/u.test(revisionFile.name)) continue;
          scannedFiles += 1;
          if (scannedFiles > MAX_REBUILD_FILES) throw new RpcRuntimeError("context_rebuild_budget", "context rebuild file budget was exhausted");
          const path = join(contextDir, revisionFile.name);
          const { value, bytes } = await files.readJsonBounded(path, MAX_RECORD_BYTES);
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
      if (pending !== undefined && await files.pathExists(ports.recordPath(workspaceId, pending.context_id, pending.revision))) {
        const committed = await ports.readRecord(workspaceId, pending.context_id, pending.revision);
        if (committed.fingerprint !== pending.fingerprint) throw new RpcRuntimeError("context_record_corrupt", "Pending checkpoint and immutable record disagree");
        if (!records.some(record => record.context_id === pending.context_id && record.revision >= pending.revision)) throw new RpcRuntimeError("context_rebuild_budget", "Pending checkpoint cannot fit in the rebuilt index");
      }
      if (performance.now() > deadline) throw new RpcRuntimeError("context_rebuild_budget", "Context rebuild time budget was exhausted before index publication");
      const rebuiltAtMs = Date.now();
      await ports.writeIndex({ schema_version: INDEX_SCHEMA_VERSION, workspace_id: workspaceId, rebuilt_at_ms: rebuiltAtMs, records }, assertAuthorized);
      if (pending !== undefined) await ports.clearPending(pending);
      return { workspace_id: workspaceId, rebuilt: true, records: records.length, scanned_files: scannedFiles, scanned_bytes: scannedBytes, rebuilt_at_ms: rebuiltAtMs };
    });
  }
