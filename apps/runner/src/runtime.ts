import type { JobMetadata } from "@remote-coding-runtime/protocol";
import type { RunnerConfig } from "./config.js";
import { GitService } from "./git-service.js";
import { FilesystemService } from "./filesystem.js";
import { JobManager, type JobEvent, type JobRecord } from "./jobs.js";
import { PatchService } from "./patch-service.js";
import { PathPolicy, PathPolicyError } from "./path-policy.js";
import { RpcRuntimeError } from "./errors.js";

export interface RunnerRuntimeOptions {
  readonly config: RunnerConfig;
  readonly stateDir?: string;
  readonly onJobEvent?: (event: JobEvent) => void;
}

/** RPC surface implemented entirely on the local runner; it never accepts a root path from a peer. */
export class RunnerRuntime {
  public readonly policy: PathPolicy;
  public readonly filesystem: FilesystemService;
  public readonly jobs: JobManager;
  public readonly git: GitService;
  private readonly patcher: PatchService;
  private readonly config: RunnerConfig;

  public constructor(options: RunnerRuntimeOptions) {
    this.config = options.config;
    this.policy = new PathPolicy(options.config.workspaces);
    this.filesystem = new FilesystemService(this.policy);
    this.git = new GitService(this.policy);
    this.patcher = new PatchService(this.policy);
    this.jobs = new JobManager({ policy: this.policy, runnerId: options.config.runnerId, maxConcurrentJobs: options.config.maxConcurrentJobs ?? 1, ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }), ...(options.onJobEvent === undefined ? {} : { onEvent: options.onJobEvent }) });
  }
  public async initialize(): Promise<void> { await this.jobs.initialize(); }
  public workspaceList(): Record<string, unknown> {
    return { workspaces: this.policy.list().map((workspace) => ({ workspace_id: workspace.workspaceId, readonly: workspace.readonly, shell: workspace.shell })) };
  }
  public envInfo(): Record<string, unknown> {
    return { platform: process.platform, architecture: process.arch, node: process.version, workspaces: this.policy.list().map((workspace) => ({ workspace_id: workspace.workspaceId, readonly: workspace.readonly, shell: workspace.shell })) };
  }
  public async dispatch(method: string, input: unknown): Promise<unknown> {
    switch (method) {
      case "workspace.list": return this.workspaceList();
      case "env.info": return this.envInfo();
      case "fs.read": return this.filesystem.read(input);
      case "fs.list": return this.filesystem.list(input);
      case "fs.search": return this.filesystem.search(input);
      case "fs.apply_patch": return this.patcher.apply(input);
      // Deprecated compatibility alias. It delegates to the transactional,
      // baseline-checked implementation and never accepts whole-file content.
      case "fs.patch": {
        const params = object(input);
        this.policy.assertWritable(params.workspace_id);
        return this.patcher.apply(input);
      }
      case "git.status": return this.git.status(input);
      case "git.diff": return this.git.diff(input);
      case "exec.start": return this.jobs.start(input);
      case "exec.run": return this.run(input);
      case "job.get": return this.jobs.get(object(input).job_id);
      case "job.logs": { const params = object(input); return this.jobs.logs(params.job_id, params); }
      case "job.cancel": return this.jobs.cancel(object(input).job_id);
      case "job.input": { const params = object(input); return this.jobs.input(params.job_id, params.data, params.close_stdin === true); }
      default: throw new RpcRuntimeError("method_not_found", `Unsupported method: ${method}`);
    }
  }
  public syncJobs(): JobMetadata[] {
    return this.jobs.list().map((job) => ({ job_id: job.job_id, workspace_id: job.workspace_id, status: job.status, created_at_ms: job.created_at_ms, updated_at_ms: job.updated_at_ms, runner_id: this.config.runnerId }));
  }
  private async run(input: unknown): Promise<Record<string, unknown>> {
    const params = object(input);
    const requested = params.wait_ms === undefined ? 8_000 : positiveInteger(params.wait_ms, "wait_ms");
    // The bridge uses a 10s deadline. Stay strictly below it so completion has
    // time to traverse the local socket before the Worker request expires.
    if (requested > 8_000) throw new RpcRuntimeError("invalid_params", "wait_ms must be at most 8000");
    const job = await this.jobs.start(params);
    const deadline = Date.now() + requested;
    while (Date.now() < deadline) {
      const current = this.jobs.get(job.job_id);
      if (!isActive(current)) return { job: current, completed: true, stdout: await this.jobs.logs(job.job_id, { stream: "stdout", limit: 16 * 1024, tail: true }), stderr: await this.jobs.logs(job.job_id, { stream: "stderr", limit: 16 * 1024, tail: true }) };
      await delay(Math.min(50, deadline - Date.now()));
    }
    return { job: this.jobs.get(job.job_id), completed: false, wait_cap_ms: 8_000 };
  }
}

export { RpcRuntimeError } from "./errors.js";
export function rpcError(error: unknown): { code: string; message: string; details?: Record<string, unknown> | undefined } {
  if (error instanceof PathPolicyError || error instanceof RpcRuntimeError) return { code: error.code, message: error.message.slice(0, 4_096), ...(error instanceof RpcRuntimeError && error.details === undefined ? {} : { details: (error as RpcRuntimeError).details }) };
  return { code: "invalid_request", message: (error instanceof Error ? error.message : "request failed").slice(0, 4_096) || "request failed" };
}
function object(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RpcRuntimeError("invalid_params", "params must be an object"); return value as Record<string, unknown>; }
function positiveInteger(value: unknown, field: string): number { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new RpcRuntimeError("invalid_params", `${field} must be a positive integer`); return value as number; }
function isActive(job: JobRecord): boolean { return job.status === "queued" || job.status === "running" || job.status === "cancelling"; }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))); }
