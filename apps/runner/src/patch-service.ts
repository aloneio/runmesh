import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, link, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative, sep, win32 } from "node:path";
import { PathPolicy, type PathSnapshot } from "./path-policy.js";
import { RpcRuntimeError } from "./errors.js";

const MAX_PATCH_BYTES = 1_048_576;
const MAX_TEXT_FILE_BYTES = 4 * 1_024 * 1_024;
const MAX_TOTAL_BASELINE_BYTES = 32 * 1_024 * 1_024;
const MAX_PATCH_LINES = 20_000;
const MAX_PATCH_OPERATIONS = 128;
const MAX_HUNKS = 512;
const MAX_HUNK_LINES = 4_096;
const MAX_MATCH_COMPARISONS = 2_000_000;
const MAX_PATH_ATTEMPTS = 16;
// Content replacement must never carry privilege-changing mode bits from an
// untrusted source file into the newly-created inode.  Ordinary rwx bits are
// still preserved so executable scripts retain their intended mode.
const REGULAR_FILE_MODE_MASK = 0o0777;
const SHA256 = /^[a-f0-9]{64}$/;

type PatchLineKind = "add" | "delete" | "context";
type PatchLine = { readonly kind: PatchLineKind; readonly text: string; readonly noNewline: boolean };
type Hunk = { readonly lines: readonly PatchLine[] };
type PatchOperation = {
  readonly kind: "add" | "update" | "delete" | "move";
  readonly path: string;
  readonly destination?: string;
  readonly lines: readonly PatchLine[];
  readonly hunks: readonly Hunk[];
};
type ResolvedOperation = PatchOperation & {
  readonly source?: ResolvedPath;
  readonly target?: ResolvedPath;
};
type ResolvedPath = {
  readonly path: string;
  readonly relativePath: string;
  readonly workspaceId: string;
};
type ResolvedPolicyPath = Awaited<ReturnType<PathPolicy["resolve"]>>;
type ParentBoundary = {
  readonly resolved: ResolvedPolicyPath;
  readonly snapshot: PathSnapshot;
};
type TargetBoundary = ParentBoundary;
type Baseline = {
  readonly path: ResolvedPath;
  readonly exists: boolean;
  readonly hash: string | null;
  readonly mode: number | null;
  readonly size: number | null;
  readonly bytes?: Buffer;
  /** Identity of the target's parent directory captured with the baseline. */
  readonly parentBoundary?: ParentBoundary;
  /** Identity of an existing target, preventing a Windows leaf swap from
   * being followed between lstat and open (where O_NOFOLLOW is unavailable). */
  readonly targetBoundary?: TargetBoundary;
};
type TextFile = {
  readonly bom: boolean;
  readonly newline: "\n" | "\r\n";
  readonly endsWithNewline: boolean;
  readonly lines: readonly string[];
};
type PlannedChange = {
  readonly path: ResolvedPath;
  readonly baseline: Baseline;
  readonly action: "write" | "delete";
  readonly bytes?: Buffer;
  readonly mode?: number;
};
type PreparedChange = PlannedChange & { readonly temporaryPath?: string };
type InstallState = {
  readonly change: PreparedChange;
  readonly backupPath?: string;
  backupMoved: boolean;
  installed: boolean;
  readonly installedHash?: string;
};
type RecoveryWarning = {
  readonly path: string;
  readonly backup_path?: string;
  readonly temporary_path?: string;
  readonly error: string;
};

export interface ApplyPatchOptions {
  /** Test-only seam, invoked after durable temporary files and before baseline recheck. */
  readonly beforeCommit?: () => void | Promise<void>;
  /** Test-only seam, invoked before each filesystem install. */
  readonly beforeInstall?: (path: string, action: "write" | "delete") => void | Promise<void>;
  /** Test-only seam invoked after baseline/parent checks and immediately before install. */
  readonly beforeInstallCommit?: (path: string, action: "write" | "delete") => void | Promise<void>;
  /** Test-only seam for exercising retained-backup recovery reporting. */
  readonly beforeBackupCleanup?: (backupPath: string) => void | Promise<void>;
}

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

  public async apply(input: unknown): Promise<Record<string, unknown>> {
    const params = object(input);
    if (typeof params.patch !== "string") {
      throw new RpcRuntimeError("invalid_params", "patch must be a string");
    }
    if (Buffer.byteLength(params.patch, "utf8") > MAX_PATCH_BYTES) {
      throw new RpcRuntimeError("invalid_params", `patch must not exceed ${MAX_PATCH_BYTES} UTF-8 bytes`);
    }

    const parsed = parsePatch(params.patch);
    const workspaceId = params.workspace_id;
    const operations = await this.resolveOperations(workspaceId, parsed);
    rejectConflictingPaths(operations);
    const baselines = await this.captureBaselines(operations);
    await this.checkExpectedHashes(params, operations, baselines);
    const planned = this.stageChanges(operations, baselines);
    const prepared = await this.prepareChanges(planned);
    let warnings: readonly RecoveryWarning[] = [];

    try {
      await this.options.beforeCommit?.();
      await this.recheckBaselines(baselines);
      warnings = await this.installChanges(prepared);
    } catch (error) {
      await this.removeTemporary(prepared);
      throw error;
    }

    const changes = planned.map((change) => ({
      path: change.path.relativePath,
      status: change.action === "write" ? (change.baseline.exists ? "updated" : "created") : "deleted",
      before_hash: change.baseline.hash,
      after_hash: change.action === "write" ? hash(change.bytes as Buffer) : null,
      mode: change.action === "write" ? change.mode ?? null : null,
    }));
    const operationResults = operations.map((operation) => operationResult(operation, changes));
    return {
      workspace_id: operations[0]?.source?.workspaceId ?? operations[0]?.target?.workspaceId,
      changed_paths: changes,
      operations: operationResults,
      ...(warnings.length === 0 ? {} : { warnings }),
    };
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

function parsePatch(value: string): readonly PatchOperation[] {
  const lines = value.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  if (lines.length > MAX_PATCH_LINES) throw new RpcRuntimeError("invalid_patch", `patch has too many lines (maximum ${MAX_PATCH_LINES})`);
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines[0] !== "*** Begin Patch" || lines[lines.length - 1] !== "*** End Patch") {
    throw new RpcRuntimeError("invalid_patch", "patch must use *** Begin Patch and *** End Patch envelope");
  }
  const operations: PatchOperation[] = [];
  let index = 1;
  while (index < lines.length - 1) {
    const header = lines[index] as string;
    if (header === "") {
      index += 1;
      continue;
    }
    const add = header.match(/^\*\*\* Add File: (.+)$/);
    const update = header.match(/^\*\*\* Update File: (.+)$/);
    const remove = header.match(/^\*\*\* Delete File: (.+)$/);
    const move = header.match(/^\*\*\* Move File: (.+)$/);
    if (add !== null) {
      assertOperationLimit(operations);
      const body = parseAddBody(lines, index + 1);
      operations.push({ kind: "add", path: patchPath(add[1] as string), lines: body.lines, hunks: [] });
      index = body.next;
      continue;
    }
    if (update !== null) {
      assertOperationLimit(operations);
      const body = parseUpdateBody(lines, index + 1);
      operations.push({ kind: "update", path: patchPath(update[1] as string), ...(body.destination === undefined ? {} : { destination: patchPath(body.destination) }), lines: [], hunks: body.hunks });
      index = body.next;
      continue;
    }
    if (remove !== null) {
      assertOperationLimit(operations);
      const next = consumeToHeader(lines, index + 1, (line) => {
        if (line === "*** End of File") return true;
        if (line.startsWith("*** ")) throw new RpcRuntimeError("invalid_patch", "Delete File cannot contain a patch body");
        if (line !== "") throw new RpcRuntimeError("invalid_patch", "Delete File cannot contain a patch body");
        return true;
      });
      operations.push({ kind: "delete", path: patchPath(remove[1] as string), lines: [], hunks: [] });
      index = next;
      continue;
    }
    if (move !== null) {
      assertOperationLimit(operations);
      const body = parseMoveBody(lines, index + 1);
      operations.push({ kind: "move", path: patchPath(move[1] as string), destination: patchPath(body.destination), lines: [], hunks: body.hunks });
      index = body.next;
      continue;
    }
    throw new RpcRuntimeError("invalid_patch", `unexpected patch line: ${header.slice(0, 80)}`);
  }
  if (operations.length === 0) throw new RpcRuntimeError("invalid_patch", "patch contains no file operations");
  return operations;
}

function parseAddBody(lines: readonly string[], start: number): { readonly lines: readonly PatchLine[]; readonly next: number } {
  const body: PatchLine[] = [];
  let index = start;
  while (index < lines.length - 1 && !isOperationHeader(lines[index] as string)) {
    const line = lines[index] as string;
    if (line === "*** End of File") { index += 1; continue; }
    if (line === "\\ No newline at end of file") {
      markNoNewline(body);
      index += 1;
      continue;
    }
    if (!line.startsWith("+")) throw new RpcRuntimeError("invalid_patch", "Add File body may contain only added lines");
    if (body.length >= MAX_HUNK_LINES) throw new RpcRuntimeError("invalid_patch", `Add File has too many lines (maximum ${MAX_HUNK_LINES})`);
    body.push({ kind: "add", text: line.slice(1), noNewline: false });
    index += 1;
  }
  if (body.some((line) => line.noNewline) && body[body.length - 1]?.noNewline !== true) {
    throw new RpcRuntimeError("invalid_patch", "Add File no-newline marker is allowed only at the end of the file");
  }
  return { lines: body, next: index };
}

function parseMoveBody(lines: readonly string[], start: number): { readonly destination: string; readonly hunks: readonly Hunk[]; readonly next: number } {
  const destinationLine = lines[start];
  const destination = destinationLine?.match(/^\*\*\* Move to: (.+)$/);
  if (destination === null || destination === undefined) throw new RpcRuntimeError("invalid_patch", "Move File must be followed by *** Move to: path");
  const body = parseHunks(lines, start + 1);
  return { destination: destination[1] as string, hunks: body.hunks, next: body.next };
}

function parseUpdateBody(lines: readonly string[], start: number): { readonly destination?: string; readonly hunks: readonly Hunk[]; readonly next: number } {
  let index = start;
  let destination: string | undefined;
  if ((lines[index] as string | undefined)?.startsWith("*** Move to: ")) {
    destination = (lines[index] as string).slice("*** Move to: ".length);
    if (destination.length === 0) throw new RpcRuntimeError("invalid_patch", "Move to path is required");
    index += 1;
  }
  const body = parseHunks(lines, index);
  if (body.hunks.length === 0 && destination === undefined) throw new RpcRuntimeError("invalid_patch", "Update File requires at least one hunk");
  return { ...(destination === undefined ? {} : { destination }), hunks: body.hunks, next: body.next };
}

function parseHunks(lines: readonly string[], start: number): { readonly hunks: readonly Hunk[]; readonly next: number } {
  const hunks: Hunk[] = [];
  let index = start;
  while (index < lines.length - 1 && !isOperationHeader(lines[index] as string)) {
    const marker = lines[index] as string;
    if (marker === "*** End of File") { index += 1; continue; }
    if (marker === "*** End of File") { index += 1; continue; }
    if (!marker.startsWith("@@")) throw new RpcRuntimeError("invalid_patch", "Update or Move body must use @@ hunk markers");
    if (hunks.length >= MAX_HUNKS) throw new RpcRuntimeError("invalid_patch", `patch has too many hunks (maximum ${MAX_HUNKS})`);
    index += 1;
    const hunk: PatchLine[] = [];
    while (index < lines.length - 1 && !isOperationHeader(lines[index] as string) && !(lines[index] as string).startsWith("@@")) {
      const line = lines[index] as string;
      if (line === "\\ No newline at end of file") {
        markNoNewline(hunk);
      } else if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
        if (hunk.length >= MAX_HUNK_LINES) throw new RpcRuntimeError("invalid_patch", `hunk has too many lines (maximum ${MAX_HUNK_LINES})`);
        hunk.push({ kind: line[0] === "+" ? "add" : line[0] === "-" ? "delete" : "context", text: line.slice(1), noNewline: false });
      } else if (line === "*** End of File") {
        index += 1;
        break;
      } else {
        throw new RpcRuntimeError("invalid_patch", "invalid hunk line");
      }
      index += 1;
    }
    if (hunk.length === 0 || !hunk.some((line) => line.kind !== "add")) {
      throw new RpcRuntimeError("invalid_patch", "each hunk needs non-added context to match");
    }
    validateNoNewlineMarkers(hunk);
    hunks.push({ lines: hunk });
  }
  return { hunks, next: index };
}

function consumeToHeader(lines: readonly string[], start: number, consume: (line: string) => boolean): number {
  let index = start;
  while (index < lines.length - 1 && !isOperationHeader(lines[index] as string)) {
    consume(lines[index] as string);
    index += 1;
  }
  return index;
}

function assertOperationLimit(operations: readonly PatchOperation[]): void {
  if (operations.length >= MAX_PATCH_OPERATIONS) {
    throw new RpcRuntimeError("invalid_patch", `patch has too many operations (maximum ${MAX_PATCH_OPERATIONS})`);
  }
}

function isOperationHeader(line: string): boolean {
  return /^\*\*\* (?:Add|Update|Delete|Move) File: /.test(line);
}

function patchPath(value: string): string {
  if (value.length === 0 || value.length > 4_096) throw new RpcRuntimeError("invalid_patch", "patch path is invalid");
  return value;
}

function markNoNewline(lines: PatchLine[]): void {
  const last = lines[lines.length - 1];
  if (last === undefined || last.noNewline) throw new RpcRuntimeError("invalid_patch", "no-newline marker must follow one patch line");
  (last as { noNewline: boolean }).noNewline = true;
}

function validateNoNewlineMarkers(lines: readonly PatchLine[]): void {
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.noNewline && index !== lines.length - 1) {
      throw new RpcRuntimeError("invalid_patch", "no-newline marker is allowed only at the end of a hunk");
    }
  }
}

function applyHunks(file: TextFile, hunks: readonly Hunk[], path: string): Buffer {
  if (hunks.length === 0) throw new RpcRuntimeError("invalid_patch", `Update File requires a hunk: ${path}`);
  type Match = { readonly start: number; readonly end: number; readonly hunk: Hunk };
  const matches: Match[] = [];
  let comparisons = 0;
  for (const hunk of hunks) {
    const old = hunk.lines.filter((line) => line.kind !== "add");
    const found = findMatches(file.lines, old, file.endsWithNewline, MAX_MATCH_COMPARISONS - comparisons);
    comparisons += found.comparisons;
    if (comparisons > MAX_MATCH_COMPARISONS) throw new RpcRuntimeError("invalid_patch", "patch context matching exceeded its work limit");
    const candidates = found.matches;
    if (candidates.length === 0) {
      throw conflict("hunk_not_found", `hunk context was not found exactly once: ${path}`, { path });
    }
    if (candidates.length > 1) {
      throw conflict("hunk_ambiguous", `hunk context matched more than once: ${path}`, { path, matches: candidates.length });
    }
    const start = candidates[0] as number;
    matches.push({ start, end: start + old.length, hunk });
  }
  const ordered = [...matches].sort((left, right) => left.start - right.start);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1] as Match;
    const current = ordered[index] as Match;
    if (current.start < previous.end) {
      throw conflict("hunk_overlap", `hunks overlap in ${path}`, { path });
    }
  }

  const output: string[] = [];
  let cursor = 0;
  let endsWithNewline = file.endsWithNewline;
  for (const match of ordered) {
    output.push(...file.lines.slice(cursor, match.start));
    const replacement = match.hunk.lines.filter((line) => line.kind !== "delete");
    output.push(...replacement.map((line) => line.text));
    if (match.end === file.lines.length) {
      const last = replacement[replacement.length - 1];
      if (last?.noNewline) endsWithNewline = false;
      else if (replacement.length > 0) endsWithNewline = true;
      else endsWithNewline = false;
    }
    cursor = match.end;
  }
  output.push(...file.lines.slice(cursor));
  return renderText({ ...file, lines: output, endsWithNewline });
}

function findMatches(lines: readonly string[], old: readonly PatchLine[], endsWithNewline: boolean, budget: number): { readonly matches: readonly number[]; readonly comparisons: number } {
  if (old.length === 0) return { matches: [], comparisons: 0 };
  const matches: number[] = [];
  let comparisons = 0;
  for (let start = 0; start + old.length <= lines.length; start += 1) {
    let match = true;
    for (let offset = 0; offset < old.length; offset += 1) {
      comparisons += 1;
      if (comparisons > budget) return { matches, comparisons };
      const expected = old[offset] as PatchLine;
      if (lines[start + offset] !== expected.text) { match = false; break; }
      if (expected.noNewline && (start + offset !== lines.length - 1 || endsWithNewline)) { match = false; break; }
    }
    if (match) matches.push(start);
  }
  return { matches, comparisons };
}

function renderAddedFile(lines: readonly PatchLine[]): Buffer {
  if (lines.some((line) => line.kind !== "add")) throw new RpcRuntimeError("invalid_patch", "Add File contains invalid line type");
  if (lines.length === 0) return Buffer.alloc(0);
  const final = lines[lines.length - 1];
  return Buffer.from(`${lines.map((line) => line.text).join("\n")}${final?.noNewline ? "" : "\n"}`, "utf8");
}

function parseText(bytes: Buffer, path: string): TextFile {
  if (bytes.byteLength > MAX_TEXT_FILE_BYTES) throw new RpcRuntimeError("file_too_large", `text file exceeds ${MAX_TEXT_FILE_BYTES} bytes: ${path}`);
  const bom = bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bom ? bytes.subarray(3) : bytes);
  } catch {
    throw new RpcRuntimeError("not_utf8", `file is not valid UTF-8 text: ${path}`, { path });
  }
  const crlf = text.includes("\r\n");
  const lf = /(^|[^\r])\n/.test(text);
  if (crlf && lf) throw new RpcRuntimeError("mixed_newlines", `file has mixed newline styles: ${path}`, { path });
  if (text.includes("\r") && !crlf) throw new RpcRuntimeError("mixed_newlines", `file has unsupported carriage returns: ${path}`, { path });
  const newline: "\n" | "\r\n" = crlf ? "\r\n" : "\n";
  const endsWithNewline = text.endsWith(newline);
  const lines = text.length === 0 ? [] : text.split(newline);
  if (endsWithNewline) lines.pop();
  return { bom, newline, endsWithNewline, lines };
}

function renderText(file: TextFile): Buffer {
  if (file.lines.length === 0) return file.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0);
  return Buffer.from(`${file.bom ? "\ufeff" : ""}${file.lines.join(file.newline)}${file.endsWithNewline ? file.newline : ""}`, "utf8");
}

async function captureBaseline(path: ResolvedPath, policy?: PathPolicy): Promise<Baseline> {
  const parentBoundary = policy === undefined ? undefined : await captureParentBoundary(policy, path);
  let targetBoundary: TargetBoundary | undefined;
  const targetResolved: ResolvedPolicyPath | undefined = policy === undefined ? undefined : { workspace: policy.getWorkspace(path.workspaceId), path: path.path };
  if (policy !== undefined) {
    try {
      const snapshot = await policy.snapshot(targetResolved as ResolvedPolicyPath);
      targetBoundary = { resolved: targetResolved as ResolvedPolicyPath, snapshot };
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }
  try {
    const opened = await readRegularFileCapped(path.path, path.relativePath, policy, parentBoundary, targetBoundary, targetResolved);
    const finalTargetSnapshot = opened.targetSnapshot ?? targetBoundary?.snapshot;
    const finalTargetBoundary = targetResolved === undefined || finalTargetSnapshot === undefined
      ? undefined
      : { resolved: targetResolved, snapshot: finalTargetSnapshot };
    return {
      path, exists: true, hash: hash(opened.bytes), mode: opened.mode, size: opened.size, bytes: opened.bytes,
      ...(parentBoundary === undefined ? {} : { parentBoundary }),
      ...(finalTargetBoundary === undefined ? {} : { targetBoundary: finalTargetBoundary }),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      if (policy !== undefined) await verifyParentBoundary(policy, parentBoundary);
      return {
        path, exists: false, hash: null, mode: null, size: null,
        ...(parentBoundary === undefined ? {} : { parentBoundary }),
      };
    }
    if (code === "ELOOP") throw new RpcRuntimeError("symlink_write", `symlink paths are not allowed: ${path.relativePath}`);
    throw error;
  }
}

async function readRegularFileCapped(
  path: string,
  relativePath: string,
  policy?: PathPolicy,
  parentBoundary?: ParentBoundary,
  targetBoundary?: TargetBoundary,
  targetResolved?: ResolvedPolicyPath,
): Promise<{ readonly bytes: Buffer; readonly mode: number; readonly size: number; readonly targetSnapshot?: PathSnapshot }> {
  const handle = await openNoFollow(path);
  try {
    const info = await handle.stat();
    if (policy !== undefined) await verifyParentBoundary(policy, parentBoundary);
    let targetSnapshot = targetBoundary?.snapshot;
    if (policy !== undefined && targetResolved !== undefined) {
      // Always perform a post-open target snapshot, even when the initial
      // target was absent. This prevents a Windows leaf symlink created in the
      // lstat/open interval from being followed as an apparently new file.
      const currentTarget = await policy.snapshot(targetResolved);
      if (targetBoundary !== undefined && !sameSnapshotIdentity(currentTarget, targetBoundary.snapshot)) {
        throw new RpcRuntimeError("path_changed", `file changed while it was opened: ${relativePath}`);
      }
      targetSnapshot = currentTarget;
    }
    if (targetSnapshot !== undefined && (info.dev !== targetSnapshot.device || info.ino !== targetSnapshot.inode)) {
      throw new RpcRuntimeError("path_changed", `file changed while it was opened: ${relativePath}`);
    }
    if (!info.isFile()) throw new RpcRuntimeError("invalid_path", `path is not a regular file: ${relativePath}`);
    // Inspect through the opened descriptor before allocating. This prevents a
    // large file swapped in after a path lstat from bypassing the cap.
    if (info.size > MAX_TEXT_FILE_BYTES) throw new RpcRuntimeError("file_too_large", `file exceeds ${MAX_TEXT_FILE_BYTES} bytes: ${relativePath}`);
    const buffer = Buffer.allocUnsafe(MAX_TEXT_FILE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_TEXT_FILE_BYTES) throw new RpcRuntimeError("file_too_large", `file exceeds ${MAX_TEXT_FILE_BYTES} bytes: ${relativePath}`);
    return { bytes: Buffer.from(buffer.subarray(0, offset)), mode: info.mode & 0o7777, size: offset, ...(targetSnapshot === undefined ? {} : { targetSnapshot }) };
  } finally {
    await handle.close();
  }
}

async function openNoFollow(path: string): Promise<Awaited<ReturnType<typeof open>>> {
  try {
    // O_NOFOLLOW closes the final-component race on POSIX. Windows has no
    // portable Node flag for this, so lstat is retained as a best-effort leaf
    // guard and the parent snapshot is verified around every operation.
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new RpcRuntimeError("symlink_write", "symlink paths are not allowed");
    return await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error instanceof RpcRuntimeError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new RpcRuntimeError("symlink_write", "symlink paths are not allowed");
    throw error;
  }
}

async function captureParentBoundary(policy: PathPolicy, path: ResolvedPath): Promise<ParentBoundary> {
  const parentRelative = dirname(path.relativePath).replace(/\\/g, "/") || ".";
  let resolved: Awaited<ReturnType<PathPolicy["resolve"]>>;
  try {
    resolved = await policy.resolve(path.workspaceId, parentRelative, "write");
  } catch (error) {
    if (isErrno(error, "ENOENT")) throw conflict("invalid_path", "target parent directory does not exist", { path: path.relativePath });
    throw error;
  }
  let snapshot: PathSnapshot;
  try {
    snapshot = await policy.snapshot(resolved);
  } catch (error) {
    if (isErrno(error, "ENOENT")) throw conflict("invalid_path", "target parent directory does not exist", { path: path.relativePath });
    throw error;
  }
  if (snapshot.type !== "directory") throw conflict("invalid_path", `target parent directory is not a directory: ${parentRelative}`, { path: path.relativePath });
  return { resolved, snapshot };
}

async function verifyParentBoundary(policy: PathPolicy | undefined, boundary: ParentBoundary | undefined): Promise<void> {
  if (policy !== undefined && boundary !== undefined) await policy.verifySnapshot(boundary.resolved, boundary.snapshot);
}

async function verifyTargetBoundary(policy: PathPolicy | undefined, boundary: TargetBoundary | undefined): Promise<void> {
  if (policy !== undefined && boundary !== undefined) await policy.verifySnapshot(boundary.resolved, boundary.snapshot);
}

function sameBaseline(left: Baseline, right: Baseline): boolean {
  return left.exists === right.exists && left.hash === right.hash && left.mode === right.mode && left.size === right.size
    && sameParentBoundary(left.parentBoundary, right.parentBoundary)
    && sameParentBoundary(left.targetBoundary, right.targetBoundary);
}

function sameParentBoundary(left: ParentBoundary | undefined, right: ParentBoundary | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return sameSnapshotIdentity(left.snapshot, right.snapshot);
}

function sameSnapshotIdentity(left: PathSnapshot, right: PathSnapshot): boolean {
  return sameCanonicalPath(left.canonicalPath, right.canonicalPath)
    && left.device === right.device && left.inode === right.inode
    && (left.rootCanonicalPath === undefined || right.rootCanonicalPath === undefined || sameCanonicalPath(left.rootCanonicalPath, right.rootCanonicalPath))
    && (left.rootDevice === undefined || right.rootDevice === undefined || left.rootDevice === right.rootDevice)
    && (left.rootInode === undefined || right.rootInode === undefined || left.rootInode === right.rootInode);
}

function sameCanonicalPath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase()
    : left === right;
}

function checkExpectedHash(value: unknown, baseline: Baseline, path: string): void {
  if (value !== null && (typeof value !== "string" || !SHA256.test(value))) {
    throw new RpcRuntimeError("invalid_params", `expected hash for ${path} must be a lowercase SHA-256 hex digest or null`);
  }
  if (value !== baseline.hash) {
    throw conflict("expected_hash_mismatch", `expected hash does not match baseline: ${path}`, {
      path,
      expected_hash: value as string | null,
      actual_hash: baseline.hash,
    });
  }
}

async function writeTemporary(target: string, bytes: Buffer, mode: number, policy?: PathPolicy, parentBoundary?: ParentBoundary): Promise<string> {
  // Anchor temporary creation to the canonical parent captured with the
  // baseline. If the lexical ancestor is replaced by a junction between the
  // check and open(), this path either remains the original directory or fails
  // closed; it cannot silently create the staging file in the junction target.
  const anchoredTarget = anchoredPath(target, parentBoundary);
  const temporary = `${anchoredTarget}.remote-coding-runtime-${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), mode);
  try {
    if (policy !== undefined) await verifyParentBoundary(policy, parentBoundary);
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close();
  }
  return temporary;
}

async function moveToBackup(target: string, policy?: PathPolicy, parentBoundary?: ParentBoundary, targetBoundary?: TargetBoundary): Promise<string> {
  const anchoredTarget = anchoredPath(target, parentBoundary);
  for (let attempt = 0; attempt < MAX_PATH_ATTEMPTS; attempt += 1) {
    const backupPath = backupName(anchoredTarget);
    let linked = false;
    try {
      if (policy !== undefined) await verifyParentBoundary(policy, parentBoundary);
      await verifyTargetBoundary(policy, targetBoundary);
      // link(2) creates the backup exclusively, unlike rename which would
      // silently replace a pre-existing (possibly attacker-created) name.
      // The source and backup share the same parent/filesystem, so this is a
      // durable equivalent to moving the original before installation.
      await link(anchoredTarget, backupPath);
      linked = true;
      if (policy !== undefined) await verifyParentBoundary(policy, parentBoundary);
      await verifyTargetBoundary(policy, targetBoundary);
      await rm(anchoredTarget, { force: false });
      if (policy !== undefined) await verifyParentBoundary(policy, parentBoundary);
      return backupPath;
    } catch (error) {
      if (linked) {
        try {
          if (policy !== undefined) await verifyParentBoundary(policy, parentBoundary);
          await rm(backupPath, { force: false });
        } catch (cleanupError) {
          throw new RpcRuntimeError("patch_rollback_failed", "could not remove a backup after installation failed", {
            recovery: [{ path: anchoredTarget, backup_path: backupPath, error: message(cleanupError) }],
          });
        }
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new RpcRuntimeError("patch_install_failed", "could not reserve an exclusive backup path");
}

async function assertExistingParent(target: string, parentBoundary?: ParentBoundary): Promise<void> {
  const anchoredTarget = anchoredPath(target, parentBoundary);
  let info;
  try {
    info = await lstat(dirname(anchoredTarget));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw conflict("invalid_path", "target parent directory does not exist");
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw conflict("invalid_path", "target parent directory is not a regular directory");
}

async function installNoReplace(temporaryPath: string, target: string, policy?: PathPolicy, parentBoundary?: ParentBoundary): Promise<void> {
  if (policy !== undefined) await verifyParentBoundary(policy, parentBoundary);
  await link(temporaryPath, anchoredPath(target, parentBoundary));
  if (policy !== undefined) await verifyParentBoundary(policy, parentBoundary);
  await rm(temporaryPath, { force: false });
}

async function rollback(states: readonly InstallState[], policy?: PathPolicy): Promise<Record<string, unknown>[]> {
  const failures: Record<string, unknown>[] = [];
  for (const state of [...states].reverse()) {
    if (!state.backupMoved && !state.installed) continue;
    const { change } = state;
    try {
      await verifyParentBoundary(policy, change.baseline.parentBoundary);
      const current = await captureBaseline(change.path, policy);
      if (state.backupMoved) {
        // Do not erase a post-baseline writer during recovery. Retain the
        // backup and return its exact recovery path to the caller instead.
        if (current.exists && (!state.installed || current.hash !== state.installedHash)) {
          throw new Error("target changed after patch installation");
        }
        if (current.exists) await rm(anchoredPath(change.path.path, change.baseline.parentBoundary), { force: false });
        await verifyParentBoundary(policy, change.baseline.parentBoundary);
        await rename(state.backupPath as string, anchoredPath(change.path.path, change.baseline.parentBoundary));
      } else if (state.installed && change.action === "write") {
        if (!current.exists || current.hash !== state.installedHash) throw new Error("target changed after patch installation");
        await verifyParentBoundary(policy, change.baseline.parentBoundary);
        await rm(anchoredPath(change.path.path, change.baseline.parentBoundary), { force: false });
      }
      await fsyncDirectory(dirname(anchoredPath(change.path.path, change.baseline.parentBoundary)), policy, change.baseline.parentBoundary);
    } catch (error) {
      failures.push({
        path: change.path.relativePath,
        action: change.action,
        ...(state.backupPath === undefined ? {} : { backup_path: state.backupPath }),
        ...(change.temporaryPath === undefined ? {} : { temporary_path: change.temporaryPath }),
        error: message(error),
      });
    }
  }
  return failures;
}

async function fsyncDirectory(directory: string, policy?: PathPolicy, parentBoundary?: ParentBoundary): Promise<void> {
  let handle;
  try {
    if (policy !== undefined) await verifyParentBoundary(policy, parentBoundary);
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Some platforms do not permit syncing a directory. Data correctness does
    // not depend on this best-effort durability barrier.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function anchoredPath(target: string, parentBoundary: ParentBoundary | undefined): string {
  if (parentBoundary === undefined) return target;
  return join(parentBoundary.snapshot.canonicalPath, basename(target));
}

function toResolved(value: { workspace: { workspaceId: string; rootPath: string }; path: string }): ResolvedPath {
  return {
    path: value.path,
    relativePath: relative(value.workspace.rootPath, value.path).split(sep).join("/"),
    workspaceId: value.workspace.workspaceId,
  };
}

function rejectConflictingPaths(operations: readonly ResolvedOperation[]): void {
  const sources = new Set<string>();
  const targets = new Set<string>();
  for (const operation of operations) {
    if (operation.source !== undefined) {
      const key = pathKey(operation.source.relativePath);
      if (sources.has(key)) throw new RpcRuntimeError("invalid_patch", `duplicate source path: ${operation.source.relativePath}`);
      sources.add(key);
    }
    if (operation.target !== undefined) {
      const key = pathKey(operation.target.relativePath);
      if (targets.has(key)) throw new RpcRuntimeError("invalid_patch", `duplicate target path: ${operation.target.relativePath}`);
      targets.add(key);
    }
  }
  for (const operation of operations) {
    if (operation.source !== undefined && operation.target === undefined && targets.has(pathKey(operation.source.relativePath))) {
      throw new RpcRuntimeError("invalid_patch", "patch source and target paths conflict");
    }
    if (operation.source === undefined || operation.target === undefined || pathKey(operation.source.relativePath) === pathKey(operation.target.relativePath)) continue;
    if (targets.has(pathKey(operation.source.relativePath)) || sources.has(pathKey(operation.target.relativePath))) {
      throw new RpcRuntimeError("invalid_patch", "patch source and target paths conflict");
    }
  }
}

function operationResult(operation: ResolvedOperation, changes: readonly Record<string, unknown>[]): Record<string, unknown> {
  const paths = [operation.source?.relativePath, operation.target?.relativePath]
    .filter((path): path is string => path !== undefined)
    .map(pathKey);
  return {
    operation: operation.kind === "update" && operation.destination !== undefined ? "move" : operation.kind,
    path: operation.source?.relativePath ?? operation.target?.relativePath,
    ...(operation.destination === undefined ? {} : { destination: operation.target?.relativePath }),
    status: "applied",
    results: changes.filter((change) => typeof change.path === "string" && paths.includes(pathKey(change.path))),
  };
}

function requiredBaseline(baselines: ReadonlyMap<string, Baseline>, path: ResolvedPath): Baseline {
  const baseline = baselines.get(pathKey(path.relativePath));
  if (baseline === undefined) throw new Error("missing staged baseline");
  return baseline;
}
function requiredPath(path: ResolvedPath | undefined): ResolvedPath {
  if (path === undefined) throw new Error("missing resolved path");
  return path;
}
function hash(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function conflict(code: string, messageText: string, details: Record<string, unknown> = {}): RpcRuntimeError { return new RpcRuntimeError(code, messageText, details); }
function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new RpcRuntimeError("invalid_params", "params must be an object");
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function message(error: unknown): string { return error instanceof Error ? error.message.slice(0, 1_024) : "filesystem operation failed"; }
function backupName(path: string): string { return `${path}.remote-coding-runtime-${randomUUID()}.bak`; }
/**
 * Windows path lookup is case-insensitive and trims trailing dots/spaces on
 * ordinary NTFS components. Keep internal transaction keys aligned with that
 * lookup so aliases such as `Foo`/`foo` cannot bypass conflict detection or
 * cause two staged changes to target one inode. POSIX keeps case-sensitive
 * semantics intact.
 */
function pathKey(path: string): string {
  const normalized = path.replace(/[\\/]+/g, "/");
  if (process.platform !== "win32") return normalized;
  return normalized.split("/").map((part) => part.replace(/[ .]+$/u, "")).join("/").toLowerCase();
}
function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { readonly code?: unknown }).code === code;
}
