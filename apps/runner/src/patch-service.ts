import { anchoredPath } from "./patch/files.js";
import { applyHunks } from "./patch/transform.js";
import type { ApplyPatchOptions } from "./patch/public-contracts.js";
import { assertExistingParent } from "./patch/files.js";
import { assertRpcResultFits } from "./rpc-budget.js";
import type { Baseline } from "./patch/contracts.js";
import { captureBaseline } from "./patch/files.js";
import { changePreview } from "./patch/preview.js";
import { changeReceipt } from "./patch/preview.js";
import { checkExpectedHash } from "./patch/values.js";
import { conflict } from "./patch/values.js";
import { dirname } from "node:path";
import { fsyncDirectory } from "./patch/files.js";
import { hash } from "./patch/values.js";
import { installNoReplace } from "./patch/files.js";
import type { InstallState } from "./patch/contracts.js";
import { isRecord } from "./patch/values.js";
import { jsonBytes } from "./rpc-budget.js";
import { MAX_PATCH_BYTES } from "./patch/limits.js";
import { MAX_RPC_RESULT_BYTES } from "./rpc-budget.js";
import { MAX_TOTAL_BASELINE_BYTES } from "./patch/limits.js";
import { message } from "./patch/values.js";
import { moveToBackup } from "./patch/files.js";
import { object } from "./patch/values.js";
import { operationResult } from "./patch/values.js";
import { parsePatch } from "./patch/parse.js";
import { parseText } from "./patch/transform.js";
import type { PatchOperation } from "./patch/contracts.js";
import { patchPreviewId } from "./patch/preview.js";
import { pathKey } from "./patch/values.js";
import { PathPolicy } from "./path-policy.js";
import type { PlannedChange } from "./patch/contracts.js";
import type { PreparedChange } from "./patch/contracts.js";
import type { RecoveryWarning } from "./patch/contracts.js";
import { REGULAR_FILE_MODE_MASK } from "./patch/limits.js";
import { rejectConflictingPaths } from "./patch/values.js";
import { renderAddedFile } from "./patch/transform.js";
import { requiredBaseline } from "./patch/values.js";
import { requiredPath } from "./patch/values.js";
import type { ResolvedOperation } from "./patch/contracts.js";
import type { ResolvedPath } from "./patch/contracts.js";
import { rm } from "node:fs/promises";
import { rollback } from "./patch/files.js";
import { RpcRuntimeError } from "./errors.js";
import { sameBaseline } from "./patch/files.js";
import { SHA256 } from "./patch/limits.js";
import { toResolved } from "./patch/values.js";
import { verifyParentBoundary } from "./patch/files.js";
import { verifyTargetBoundary } from "./patch/files.js";
import { withPatchCommitLock } from "./rpc-budget.js";
import { writeTemporary } from "./patch/files.js";

/**
 * Applies a small, context-checked patch as a transaction over one workspace.
 * The parser and installer are local implementations; no external patch tool is
 * invoked. Filesystem rename semantics are per-path atomic, with backups held
 * until the complete install succeeds.
 *
 * Node's portable fs promises API does not expose openat/renameat-style
 * directory-relative mutation (nor Windows reparse-safe directory handles).
 * Parent identities are therefore snapshotted, canonical paths are used for
 * staging/backup/install, and each path is verified before/after mutation.
 * A hostile local writer can still win the narrow interval between the final
 * verification and the kernel path syscall; deployments needing a strict
 * no-race guarantee must add an OS sandbox or native handle-relative adapter.
 */
export class PatchService {
  public constructor(
    private readonly policy: PathPolicy,
    private readonly options: ApplyPatchOptions = {},
  ) {}

  /** Build the exact transaction plan without creating temp files or mutating the workspace. */
  public async preview(input: unknown): Promise<Record<string, unknown>> {
    const generation = this.policy.generation;
    const params = object(input);
    if (typeof params.patch !== "string") throw new RpcRuntimeError("invalid_params", "patch must be a string");
    if (Buffer.byteLength(params.patch, "utf8") > MAX_PATCH_BYTES) throw new RpcRuntimeError("invalid_params", `patch must not exceed ${MAX_PATCH_BYTES} UTF-8 bytes`);
    const parsed = parsePatch(params.patch);
    const workspace = this.policy.getWorkspace(params.workspace_id);
    const operations = await this.resolveOperations(params.workspace_id, parsed);
    rejectConflictingPaths(operations);
    const baselines = await this.captureBaselines(operations);
    await this.checkExpectedHashes(params, operations, baselines);
    const planned = this.stageChanges(operations, baselines);
    this.policy.assertGeneration(generation);
    const changes = planned.map(changeReceipt);
    const previewId = patchPreviewId(workspace.workspaceId, generation, params.patch, changes);
    const previews: Record<string, unknown>[] = [];
    let insertions = 0;
    let deletions = 0;
    let previewsTruncated = false;
    for (const change of planned) {
      const preview = changePreview(change);
      insertions += preview.insertions;
      deletions += preview.deletions;
      previews.push(preview);
      const candidate = { workspace_id: workspace.workspaceId, preview_id: previewId, changed_paths: changes, insertions, deletions, previews, previews_truncated: false };
      if (jsonBytes(candidate) > MAX_RPC_RESULT_BYTES - 1_024) { previews.pop(); previewsTruncated = true; break; }
    }
    const result = { workspace_id: workspace.workspaceId, preview_id: previewId, changed_paths: changes, insertions, deletions, previews, previews_truncated: previewsTruncated };
    assertRpcResultFits(result);
    return result;
  }

  public async apply(input: unknown): Promise<Record<string, unknown>> {
    const generation = this.policy.generation;
    const params = object(input);
    if (typeof params.patch !== "string") throw new RpcRuntimeError("invalid_params", "patch must be a string");
    if (Buffer.byteLength(params.patch, "utf8") > MAX_PATCH_BYTES) throw new RpcRuntimeError("invalid_params", `patch must not exceed ${MAX_PATCH_BYTES} UTF-8 bytes`);
    const parsed = parsePatch(params.patch);
    const workspace = this.policy.getWorkspace(params.workspace_id);
    const operations = await this.resolveOperations(params.workspace_id, parsed);
    rejectConflictingPaths(operations);
    const baselines = await this.captureBaselines(operations);
    await this.checkExpectedHashes(params, operations, baselines);
    const planned = this.stageChanges(operations, baselines);
    const changes = planned.map(changeReceipt);
    const previewId = patchPreviewId(workspace.workspaceId, generation, params.patch, changes);
    if (params.preview_id !== undefined && (typeof params.preview_id !== "string" || !SHA256.test(params.preview_id))) throw new RpcRuntimeError("invalid_params", "preview_id must be a SHA-256 identifier");
    if (typeof params.preview_id === "string" && params.preview_id !== previewId) throw conflict("baseline_changed", "preview no longer matches the current patch baseline", { expected_preview_id: params.preview_id, actual_preview_id: previewId });
    const result: Record<string, unknown> = {
      workspace_id: workspace.workspaceId,
      preview_id: previewId,
      changed_paths: changes,
      operations: operations.map((operation) => operationResult(operation, changes)),
    };
    // Validate the exact success tree BEFORE creating temporary files or
    // committing. Reserve 16 KiB for bounded recovery warnings.
    assertRpcResultFits(result, 32 * 1024);
    const prepared = await this.prepareChanges(planned);
    try {
      await this.options.beforeCommit?.();
      return await withPatchCommitLock(workspace.rootPath, async () => {
        this.policy.assertGeneration(generation);
        await this.recheckBaselines(baselines);
        this.policy.assertGeneration(generation);
        const warnings = await this.installChanges(prepared);
        if (warnings.length > 0) {
          const retained: RecoveryWarning[] = [];
          result.warnings = retained;
          result.warning_count = warnings.length;
          result.warnings_truncated = true;
          for (const warning of warnings) {
            retained.push({ ...warning });
            if (jsonBytes(result) > MAX_RPC_RESULT_BYTES) { retained.pop(); break; }
          }
          result.warnings_truncated = retained.length !== warnings.length;
        }
        return result;
      });
    } catch (error) { await this.removeTemporary(prepared); throw error; }
  }

  private async resolveOperations(workspaceId: unknown, operations: readonly PatchOperation[]): Promise<readonly ResolvedOperation[]> {
    const resolved: ResolvedOperation[] = [];
    for (const operation of operations) {
      if (operation.kind === "add") {
        resolved.push({ ...operation, target: toResolved(await this.policy.resolve(workspaceId, operation.path, "write")) });
      } else if (operation.kind === "update") {
        const source = toResolved(await this.policy.resolve(workspaceId, operation.path, "write"));
        const target = operation.destination === undefined
          ? source
          : toResolved(await this.policy.resolve(workspaceId, operation.destination, "write"));
        resolved.push({ ...operation, source, target });
      } else if (operation.kind === "delete") {
        resolved.push({ ...operation, source: toResolved(await this.policy.resolve(workspaceId, operation.path, "write")) });
      } else {
        if (operation.destination === undefined) {
          throw new RpcRuntimeError("invalid_patch", "Move File requires a Move to path");
        }
        resolved.push({
          ...operation,
          source: toResolved(await this.policy.resolve(workspaceId, operation.path, "write")),
          target: toResolved(await this.policy.resolve(workspaceId, operation.destination, "write")),
        });
      }
    }
    return resolved;
  }

  private async captureBaselines(operations: readonly ResolvedOperation[]): Promise<ReadonlyMap<string, Baseline>> {
    const paths = new Map<string, ResolvedPath>();
    for (const operation of operations) {
      if (operation.source !== undefined) paths.set(pathKey(operation.source.relativePath), operation.source);
      if (operation.target !== undefined) paths.set(pathKey(operation.target.relativePath), operation.target);
    }
    const captured = new Map<string, Baseline>();
    let totalBytes = 0;
    for (const path of paths.values()) {
      const baseline = await captureBaseline(path, this.policy);
      totalBytes += baseline.bytes?.byteLength ?? 0;
      if (totalBytes > MAX_TOTAL_BASELINE_BYTES) {
        throw new RpcRuntimeError("file_too_large", `patch baseline files exceed ${MAX_TOTAL_BASELINE_BYTES} bytes in total`);
      }
      captured.set(pathKey(path.relativePath), baseline);
    }

    for (const operation of operations) {
      const source = operation.source === undefined ? undefined : captured.get(pathKey(operation.source.relativePath));
      const target = operation.target === undefined ? undefined : captured.get(pathKey(operation.target.relativePath));
      if ((operation.kind === "update" || operation.kind === "delete" || operation.kind === "move") && (source === undefined || !source.exists)) {
        throw conflict("missing_file", `source file does not exist: ${operation.path}`, { path: operation.path });
      }
      if (operation.kind === "add" && target?.exists) {
        throw conflict("target_exists", `Add File target already exists: ${operation.path}`, { path: operation.path });
      }
      if ((operation.kind === "move" || (operation.kind === "update" && operation.destination !== undefined)) && target?.exists) {
        throw conflict("target_exists", `move target already exists: ${operation.destination}`, { path: operation.destination as string });
      }
    }
    return captured;
  }

  private async checkExpectedHashes(
    params: Record<string, unknown>,
    operations: readonly ResolvedOperation[],
    baselines: ReadonlyMap<string, Baseline>,
  ): Promise<void> {
    const expectedHashes = params.expected_hashes;
    if (expectedHashes !== undefined) {
      if (!isRecord(expectedHashes) || Object.keys(expectedHashes).length > 256) {
        throw new RpcRuntimeError("invalid_params", "expected_hashes must be an object with at most 256 paths");
      }
      for (const [userPath, expected] of Object.entries(expectedHashes)) {
        const resolved = toResolved(await this.policy.resolve(params.workspace_id, userPath, "write"));
        const baseline = baselines.get(pathKey(resolved.relativePath));
        if (baseline === undefined) {
          throw new RpcRuntimeError("invalid_params", `expected_hashes path is not changed by patch: ${userPath}`);
        }
        checkExpectedHash(expected, baseline, userPath);
      }
    }
    if (params.expected_hash !== undefined) {
      if (operations.length !== 1) {
        throw new RpcRuntimeError("invalid_params", "expected_hash requires a patch with exactly one operation");
      }
      const operation = operations[0] as ResolvedOperation;
      const primary = operation.source ?? operation.target;
      if (primary === undefined) throw new RpcRuntimeError("invalid_params", "patch has no target");
      const baseline = baselines.get(pathKey(primary.relativePath));
      if (baseline === undefined) throw new RpcRuntimeError("invalid_params", "patch has no baseline");
      checkExpectedHash(params.expected_hash, baseline, primary.relativePath);
    }
  }

  private stageChanges(
    operations: readonly ResolvedOperation[],
    baselines: ReadonlyMap<string, Baseline>,
  ): readonly PlannedChange[] {
    const planned = new Map<string, PlannedChange>();
    for (const operation of operations) {
      const source = operation.source === undefined ? undefined : requiredBaseline(baselines, operation.source);
      const target = operation.target === undefined ? undefined : requiredBaseline(baselines, operation.target);
      if (operation.kind === "add") {
        const destination = requiredPath(operation.target);
        planned.set(pathKey(destination.relativePath), {
          path: destination,
          baseline: requiredBaseline(baselines, destination),
          action: "write",
          bytes: renderAddedFile(operation.lines),
          mode: 0o644,
        });
        continue;
      }
      if (operation.kind === "delete") {
        const sourcePath = requiredPath(operation.source);
        parseText(source?.bytes as Buffer, sourcePath.relativePath);
        planned.set(pathKey(sourcePath.relativePath), { path: sourcePath, baseline: source as Baseline, action: "delete" });
        continue;
      }
      const sourcePath = requiredPath(operation.source);
      const destination = requiredPath(operation.target);
      const sourceText = parseText(source?.bytes as Buffer, sourcePath.relativePath);
      const content = operation.kind === "move" && operation.hunks.length === 0
        ? (source?.bytes as Buffer)
        : applyHunks(sourceText, operation.hunks, sourcePath.relativePath);
      const sourceMode = source?.mode;
      if (sourceMode === null || sourceMode === undefined) throw conflict("missing_file", `source file does not exist: ${operation.path}`);
      // A pure rename preserves the existing inode and therefore its mode is
      // intentional.  Any operation that writes a replacement inode must
      // clear setuid/setgid/sticky bits; otherwise a privileged source file
      // could make a remote content edit install a privileged executable.
      const replacementMode = operation.kind === "move" && operation.hunks.length === 0
        ? sourceMode
        : sourceMode & REGULAR_FILE_MODE_MASK;
      planned.set(pathKey(destination.relativePath), {
        path: destination,
        baseline: target as Baseline,
        action: "write",
        bytes: content,
        mode: replacementMode,
      });
      if (pathKey(sourcePath.relativePath) !== pathKey(destination.relativePath)) {
        planned.set(pathKey(sourcePath.relativePath), { path: sourcePath, baseline: source as Baseline, action: "delete" });
      }
    }
    return [...planned.values()];
  }

  private async prepareChanges(changes: readonly PlannedChange[]): Promise<readonly PreparedChange[]> {
    const prepared: PreparedChange[] = [];
    try {
      for (const change of changes) {
        if (change.action === "delete") {
          prepared.push(change);
          continue;
        }
        // The central policy has already checked every target ancestry. The
        // parent directory must exist: implicit directory creation would turn
        // a path-policy race into an unreviewed write surface.
        await assertExistingParent(change.path.path, change.baseline.parentBoundary);
        await verifyParentBoundary(this.policy, change.baseline.parentBoundary);
        const temporaryPath = await writeTemporary(change.path.path, change.bytes as Buffer, change.mode ?? 0o644, this.policy, change.baseline.parentBoundary);
        prepared.push({ ...change, temporaryPath });
      }
      return prepared;
    } catch (error) {
      await this.removeTemporary(prepared);
      throw error;
    }
  }

  private async recheckBaselines(baselines: ReadonlyMap<string, Baseline>): Promise<void> {
    for (const baseline of baselines.values()) await this.recheckBaseline(baseline);
  }

  private async recheckBaseline(baseline: Baseline): Promise<void> {
    // Resolve through the central policy again immediately before mutations,
    // so a newly introduced symlink or readonly restriction is not bypassed.
    await verifyParentBoundary(this.policy, baseline.parentBoundary);
    const refreshed = await this.policy.resolve(baseline.path.workspaceId, baseline.path.relativePath, "write");
    if (refreshed.path !== baseline.path.path) {
      throw conflict("baseline_changed", `path changed while patch was prepared: ${baseline.path.relativePath}`, { path: baseline.path.relativePath });
    }
    const current = await captureBaseline(baseline.path, this.policy);
    if (!sameBaseline(baseline, current)) {
      throw conflict("baseline_changed", `file changed while patch was prepared: ${baseline.path.relativePath}`, {
        path: baseline.path.relativePath,
        expected_hash: baseline.hash,
        actual_hash: current.hash,
        expected_exists: baseline.exists,
        actual_exists: current.exists,
      });
    }
  }

  private async installChanges(changes: readonly PreparedChange[]): Promise<readonly RecoveryWarning[]> {
    const states: InstallState[] = changes.map((change) => ({ change, backupMoved: false, installed: false }));
    try {
      for (const state of states) {
        await this.options.beforeInstall?.(state.change.path.relativePath, state.change.action);
        const change = state.change;
        // Earlier paths may have been installed while a later caller changes a
        // baseline. Re-read the current path immediately before moving its
        // original so the rollback never restores over a new external write.
        await this.recheckBaseline(change.baseline);
        if (change.action === "write") await assertExistingParent(change.path.path, change.baseline.parentBoundary);
        await verifyParentBoundary(this.policy, change.baseline.parentBoundary);
        await verifyTargetBoundary(this.policy, change.baseline.targetBoundary);
        await this.options.beforeInstallCommit?.(change.path.relativePath, change.action);
        // The commit seam models a local rename/junction race immediately
        // before the first mutating syscall. Re-checking the parent identity
        // closes that deterministic window; the remaining race between this
        // check and a path-based syscall is documented below.
        await verifyParentBoundary(this.policy, change.baseline.parentBoundary);
        await verifyTargetBoundary(this.policy, change.baseline.targetBoundary);
        if (change.baseline.exists) {
          const backupPath = await moveToBackup(change.path.path, this.policy, change.baseline.parentBoundary, change.baseline.targetBoundary);
          state.backupMoved = true;
          (state as { backupPath?: string }).backupPath = backupPath;
        }
        if (change.action === "write") {
          // link(2) is exclusive: it refuses a new target created after the
          // original moved to its backup, unlike rename() which overwrites it.
          await installNoReplace(change.temporaryPath as string, change.path.path, this.policy, change.baseline.parentBoundary);
          state.installed = true;
          (state as { installedHash?: string }).installedHash = hash(change.bytes as Buffer);
        } else {
          state.installed = true;
        }
        await verifyParentBoundary(this.policy, change.baseline.parentBoundary);
        await fsyncDirectory(dirname(anchoredPath(change.path.path, change.baseline.parentBoundary)), this.policy, change.baseline.parentBoundary);
      }
    } catch (error) {
      const recovery = await rollback(states, this.policy);
      await this.removeTemporary(changes);
      if (recovery.length > 0) {
        throw new RpcRuntimeError("patch_rollback_failed", "patch installation failed and rollback was incomplete", {
          install_error: message(error),
          recovery,
        });
      }
      throw new RpcRuntimeError("patch_install_failed", "patch installation failed; all changes were rolled back", {
        install_error: message(error),
      });
    }

    const warnings: RecoveryWarning[] = [];
    for (const state of states) {
      if (state.backupPath !== undefined) {
        try {
          await this.options.beforeBackupCleanup?.(state.backupPath);
          await verifyParentBoundary(this.policy, state.change.baseline.parentBoundary);
          await rm(state.backupPath, { force: true });
        } catch (error) {
          warnings.push({ path: state.change.path.relativePath, backup_path: state.backupPath, error: message(error) });
        }
      }
      await fsyncDirectory(dirname(anchoredPath(state.change.path.path, state.change.baseline.parentBoundary)), this.policy, state.change.baseline.parentBoundary);
    }
    return warnings;
  }

  private async removeTemporary(changes: readonly PreparedChange[]): Promise<void> {
    await Promise.all(changes.map(async (change) => {
      if (change.temporaryPath !== undefined) {
        // If the parent identity no longer matches, leave the temporary file
        // for operator cleanup rather than deleting an attacker-selected path.
        await verifyParentBoundary(this.policy, change.baseline.parentBoundary)
          .then(() => rm(change.temporaryPath as string, { force: true }))
          .catch(() => undefined);
      }
    }));
  }
}

export type { ApplyPatchOptions } from "./patch/public-contracts.js";
