import { boundedCount } from "./git/values.js";
import { completeNulRecords } from "./git/projection.js";
import { DEFAULT_OUTPUT_BYTES } from "./git/limits.js";
import { fitDiffResult } from "./git/projection.js";
import { fitStatusResult } from "./git/projection.js";
import { git } from "./git/execution.js";
import { gitFailure } from "./git/values.js";
import type { GitServiceOptions } from "./git/public-contracts.js";
import { literalPathspec } from "./git/values.js";
import { MAX_PROCESS_OUTPUT_BYTES } from "./git/limits.js";
import { object } from "./git/values.js";
import { outputCap } from "./git/values.js";
import { parseStatus } from "./git/projection.js";
import { PathPolicy } from "./path-policy.js";
import { resolveGitPath } from "./git/values.js";
import { RpcRuntimeError } from "./errors.js";
import { safeRevision } from "./git/values.js";
import { utf8SafePrefix as internalUtf8SafePrefix, fitPrefix as internalFitPrefix } from "./git/projection.js";
import { trustedGitPathEntries as internalTrustedGitPathEntries } from "./git/trust.js";

/** Minimal, bounded git inspection surface. Arguments are fixed by the RPC, never caller supplied. */
export class GitService {
  public constructor(
    private readonly policy: PathPolicy,
    private readonly options: GitServiceOptions = {},
  ) {}

  public async status(input: unknown, deadline?: number): Promise<Record<string, unknown>> {
    const params = object(input);
    const workspace = this.policy.getWorkspace(params.workspace_id);
    const scope = await resolveGitPath(this.policy, params.workspace_id, params.path ?? ".");
    const outputLimit = outputCap(params.max_bytes, DEFAULT_OUTPUT_BYTES);
    const run = await git(
      scope.rootPath,
      // A repository controls its own `.git/config`.  In particular,
      // `core.fsmonitor` can name an arbitrary helper which Git executes
      // during `status`; read-only inspection must not turn into code
      // execution merely because a workspace is untrusted.  Override the
      // setting on the command line (after repository/system config loading)
      // while retaining Git's normal status parsing behavior.
      ["-c", "core.fsmonitor=false", "status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--", literalPathspec(scope.relativePath)],
      outputLimit,
      this.options,
      deadline,
    );
    if (run.status !== 0) throw gitFailure("git status failed", run);

    // Porcelain v2 is NUL-delimited. A capped read can end in the middle of a
    // path (or a rename pair), so parse only complete records.
    const complete = completeNulRecords(run.stdout);
    const parsed = parseStatus(complete.output);
    const baseTruncated = run.truncated || complete.truncated || parsed.truncated;
    const result = fitStatusResult({
      workspaceId: workspace.workspaceId,
      path: scope.relativePath,
      parsed,
      outputBytes: complete.output.byteLength,
      truncated: baseTruncated,
    });
    return result;
  }

  public async diff(input: unknown): Promise<Record<string, unknown>> {
    const params = object(input);
    const workspace = this.policy.getWorkspace(params.workspace_id);
    if (params.staged !== undefined && typeof params.staged !== "boolean") {
      throw new RpcRuntimeError("invalid_params", "staged must be a boolean");
    }
    const root = await resolveGitPath(this.policy, params.workspace_id, ".");
    const cap = outputCap(params.max_bytes, DEFAULT_OUTPUT_BYTES);
    // `git diff` may refresh the index before producing output; keep the same
    // repository-config execution guard as status (notably for core.fsmonitor).
    const args = ["-c", "core.fsmonitor=false", "diff", "--no-ext-diff", "--no-color", "--no-textconv"];
    if (params.staged === true) args.push("--cached");
    let requestedPath: string | undefined;
    if (params.path !== undefined) {
      const target = await resolveGitPath(this.policy, params.workspace_id, params.path);
      requestedPath = target.relativePath;
      args.push("--", literalPathspec(requestedPath));
    }
    const run = await git(root.rootPath, args, cap, this.options);
    // git diff uses 0 for ordinary textual diffs; reserve nonzero for execution errors.
    if (run.status !== 0) throw gitFailure("git diff failed", run);

    // Never turn an otherwise valid UTF-8 diff into a replacement character by
    // clipping a multi-byte character at the process output limit.
    const safeOutput = run.truncated ? utf8SafePrefix(run.stdout) : run.stdout;
    return fitDiffResult({
      workspaceId: workspace.workspaceId,
      ...(requestedPath === undefined ? {} : { requestedPath }),
      staged: params.staged === true,
      output: safeOutput,
      truncated: run.truncated || safeOutput.byteLength !== run.stdout.byteLength,
    });
  }

  /** Internal-safe current commit observation used to age verification evidence. */
  public async head(input: unknown, deadline?: number): Promise<{ readonly workspace_id: string; readonly commit: string }> {
    const params = object(input);
    const workspace = this.policy.getWorkspace(params.workspace_id);
    const scope = await resolveGitPath(this.policy, params.workspace_id, ".");
    const run = await git(scope.rootPath, ["rev-parse", "--verify", "HEAD"], 128, this.options, deadline);
    if (run.status !== 0 || run.truncated) throw gitFailure("git HEAD inspection failed", run);
    const commit = run.stdout.toString("utf8").trim();
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(commit)) throw new RpcRuntimeError("git_unavailable", "git HEAD is not a valid commit identifier");
    return { workspace_id: workspace.workspaceId, commit };
  }

  /** Conservative sampled baseline, not a filesystem transaction. Never
   * treat a truncated/unavailable status or a moving HEAD as a clean tree. */
  public async observeBaseline(input: unknown): Promise<{ commit: string | null; working_tree_state: "clean" | "dirty" | "unknown" }> {
    let commit: string | null = null;
    const deadline = performance.now() + Math.min(this.options.timeoutMs ?? 1_500, 1_500);
    try {
      const params = object(input);
      commit = (await this.head(params, deadline)).commit;
      if (performance.now() >= deadline) return { commit, working_tree_state: "unknown" };
      const status = await this.status({ ...params, max_bytes: 32 * 1024 }, deadline);
      if (status.truncated !== false || !Array.isArray(status.entries) || performance.now() >= deadline) return { commit, working_tree_state: "unknown" };
      // Git status can hide tracked changes when the index has skip-worktree
      // or assume-unchanged flags. Do not certify such an observation as clean.
      const scope = await resolveGitPath(this.policy, params.workspace_id, ".");
      const flags = await git(scope.rootPath, ["ls-files", "-v", "-z", "--cached", "--", literalPathspec(scope.relativePath)], 64 * 1024, this.options, deadline);
      const flagRecords = flags.stdout.toString("utf8").split("\0");
      const terminated = flagRecords.pop() === "";
      if (flags.status !== 0 || flags.truncated || !terminated || flagRecords.some(record => !record.startsWith("H ")) || performance.now() >= deadline) return { commit, working_tree_state: "unknown" };
      const after = (await this.head(params, deadline)).commit;
      if (after !== commit || performance.now() >= deadline) return { commit: after, working_tree_state: "unknown" };
      return { commit, working_tree_state: status.entries.length === 0 ? "clean" : "dirty" };
    } catch { return { commit, working_tree_state: "unknown" }; }
  }

  public async log(input: unknown): Promise<Record<string, unknown>> {
    const params = object(input);
    const workspace = this.policy.getWorkspace(params.workspace_id);
    const scope = await resolveGitPath(this.policy, params.workspace_id, params.path ?? ".");
    const limit = boundedCount(params.limit, 20, 100);
    const cap = outputCap(params.max_bytes, DEFAULT_OUTPUT_BYTES);
    // -z terminates every tformat record with NUL. Do not trim/filter fields:
    // empty subjects are legal and must not shift the next commit's fields.
    const args = ["-c", "core.fsmonitor=false", "log", "-z", "--no-decorate", "--no-color", `-n${limit + 1}`, "--format=tformat:%H%x00%an%x00%aI%x00%s", "--", literalPathspec(scope.relativePath)];
    const run = await git(scope.rootPath, args, cap, this.options);
    if (run.status !== 0) throw gitFailure("git log failed", run);
    const fields = run.stdout.toString("utf8").split("\0");
    const partial = fields.pop() !== "" || fields.length % 4 !== 0;
    let truncated = run.truncated || partial;
    const commits: Record<string, unknown>[] = [];
    for (let i = 0; i + 3 < fields.length; i += 4) {
      const [oid = "", author = "", date = "", subject = ""] = fields.slice(i, i + 4);
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(oid)) throw new RpcRuntimeError("git_failed", "Git returned an invalid history record");
      if (commits.length >= limit) { truncated = true; break; }
      if (author.length > 512 || subject.length > 4096) truncated = true;
      commits.push({ oid, author: author.slice(0, 512), date: date.slice(0, 64), subject: subject.slice(0, 4096) });
    }
    const result = () => ({ workspace_id: workspace.workspaceId, path: scope.relativePath, commits, limit, truncated, output_bytes: run.stdout.byteLength });
    while (commits.length && Buffer.byteLength(JSON.stringify(result()), "utf8") > MAX_PROCESS_OUTPUT_BYTES) { commits.pop(); truncated = true; }
    return result();
  }

  public async show(input: unknown): Promise<Record<string, unknown>> {
    const params = object(input);
    const workspace = this.policy.getWorkspace(params.workspace_id);
    const scope = await resolveGitPath(this.policy, params.workspace_id, params.path ?? ".");
    const revision = safeRevision(params.revision);
    const cap = outputCap(params.max_bytes, DEFAULT_OUTPUT_BYTES);
    const run = await git(scope.rootPath, ["-c", "core.fsmonitor=false", "show", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--format=fuller", `${revision}:${scope.relativePath}`], cap, this.options);
    if (run.status !== 0) throw gitFailure("git show failed", run);
    const output = utf8SafePrefix(run.stdout).toString("utf8");
    return { workspace_id: workspace.workspaceId, path: scope.relativePath, revision, output, encoding: "utf-8", bytes: run.stdout.byteLength, truncated: run.truncated || output.length < run.stdout.toString("utf8").length };
  }

  public async blame(input: unknown): Promise<Record<string, unknown>> {
    const params = object(input);
    const workspace = this.policy.getWorkspace(params.workspace_id);
    const scope = await resolveGitPath(this.policy, params.workspace_id, params.path ?? ".");
    const start = boundedCount(params.start_line, 1, 1_000_000);
    const end = boundedCount(params.end_line, start, 1_000_000);
    if (end < start) throw new RpcRuntimeError("invalid_params", "end_line must be greater than or equal to start_line");
    const cap = outputCap(params.max_bytes, DEFAULT_OUTPUT_BYTES);
    const run = await git(scope.rootPath, ["-c", "core.fsmonitor=false", "blame", "--no-textconv", "--line-porcelain", "-L", `${start},${end}`, "--", scope.relativePath], cap, this.options);
    if (run.status !== 0) throw gitFailure("git blame failed", run);
    const output = utf8SafePrefix(run.stdout).toString("utf8");
    return { workspace_id: workspace.workspaceId, path: scope.relativePath, start_line: start, end_line: end, output, encoding: "utf-8", bytes: run.stdout.byteLength, truncated: run.truncated || output.length < run.stdout.toString("utf8").length };
  }

}

export type { GitServiceOptions } from "./git/public-contracts.js";




// Keep the public declaration surface independent of native adapter modules.
export function trustedGitPathEntries(worktree: string): string[] { return internalTrustedGitPathEntries(worktree); }
export function fitPrefix<T>(items: readonly T[], fits: (prefix: readonly T[]) => boolean): number { return internalFitPrefix(items, fits); }
export function utf8SafePrefix<T extends Uint8Array>(output: T): T { return internalUtf8SafePrefix(output); }
