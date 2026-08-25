import { hostname } from "node:os";
import { spawn } from "node:child_process";
import { LOCAL_RUNNER_OPERATION_TIMEOUT_MS, type JobMetadata } from "@remote-coding-runtime/protocol";
import type { RunnerConfig } from "./config.js";
import { GitService } from "./git-service.js";
import { FilesystemService } from "./filesystem.js";
import { JobManager, type JobEvent, type JobRecord } from "./jobs.js";
import { PatchService } from "./patch-service.js";
import { PathPolicy, PathPolicyError } from "./path-policy.js";
import { RpcRuntimeError } from "./errors.js";

export interface EnvironmentToolInfo { readonly available: boolean; readonly version?: string; }
export interface EnvironmentInfoOptions { readonly probe?: (command: string, args: readonly string[]) => Promise<string | undefined>; }

/** Cached, bounded local executable discovery. */
export class EnvironmentInfoService {
  private cached: Promise<Record<string, unknown>> | undefined;
  public constructor(private readonly options: EnvironmentInfoOptions = {}) {}
  public get(workspaces: readonly { readonly workspaceId: string; readonly readonly: boolean; readonly shell: boolean }[]): Promise<Record<string, unknown>> {
    this.cached ??= this.discover(workspaces);
    return this.cached;
  }
  private async discover(workspaces: readonly { readonly workspaceId: string; readonly readonly: boolean; readonly shell: boolean }[]): Promise<Record<string, unknown>> {
    const probe = this.options.probe ?? probeVersion;
    const entries = await Promise.all([
      discoveredTool(probe, "npm", ["--version"]),
      discoveredTool(probe, "pnpm", ["--version"]),
      firstDiscoveredTool(probe, [["python3", ["--version"]], ["python", ["--version"]]]),
      discoveredTool(probe, "git", ["--version"]),
      discoveredTool(probe, "go", ["version"]),
      discoveredTool(probe, "rustc", ["--version"]),
      discoveredTool(probe, "cargo", ["--version"]),
      discoveredTool(probe, "docker", ["--version"]),
    ] as const);
    const [npm, pnpm, python, git, go, rustc, cargo, docker] = entries;
    const tools: Record<string, EnvironmentToolInfo> = {
      node: { available: true, version: process.version }, npm, pnpm, python, git, go, rustc, cargo, docker,
    };
    return { platform: process.platform, architecture: process.arch, hostname: hostname(), shell: process.platform === "win32" ? process.env.ComSpec ?? null : process.env.SHELL ?? null, tools, workspaces: workspaces.map((workspace) => ({ workspace_id: workspace.workspaceId, readonly: workspace.readonly, shell: workspace.shell })) };
  }
}
async function discoveredTool(probe: (command: string, args: readonly string[]) => Promise<string | undefined>, command: string, args: readonly string[]): Promise<EnvironmentToolInfo> { const version = await probe(command, args); return version === undefined ? { available: false } : { available: true, version }; }
async function firstDiscoveredTool(probe: (command: string, args: readonly string[]) => Promise<string | undefined>, candidates: readonly (readonly [string, readonly string[]])[]): Promise<EnvironmentToolInfo> { for (const [command, args] of candidates) { const result = await discoveredTool(probe, command, args); if (result.available) return result; } return { available: false }; }
function probeVersion(command: string, args: readonly string[]): Promise<string | undefined> { return new Promise((resolve) => { let settled = false; let output = ""; const child = spawn(command, [...args], { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); const finish = (value: string | undefined): void => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); }; const timer = setTimeout(() => { child.kill("SIGKILL"); finish(undefined); }, 1_000); const collect = (chunk: Buffer): void => { output = `${output}${chunk.toString()}`.slice(0, 1_024); }; child.stdout?.on("data", collect); child.stderr?.on("data", collect); child.once("error", () => finish(undefined)); child.once("close", (code) => finish(code === 0 ? output.trim().slice(0, 512) || undefined : undefined)); }); }

export interface RunnerRuntimeOptions {
  readonly config: RunnerConfig;
  readonly stateDir?: string;
  readonly onJobEvent?: (event: JobEvent) => void;
  readonly environment?: EnvironmentInfoService;
}

/** RPC surface implemented entirely on the local runner; it never accepts a root path from a peer. */
export class RunnerRuntime {
  public readonly policy: PathPolicy;
  public readonly filesystem: FilesystemService;
  public readonly jobs: JobManager;
  public readonly git: GitService;
  private readonly patcher: PatchService;
  private readonly config: RunnerConfig;
  private readonly environment: EnvironmentInfoService;

  public constructor(options: RunnerRuntimeOptions) {
    this.config = options.config;
    this.environment = options.environment ?? new EnvironmentInfoService();
    this.policy = new PathPolicy(options.config.workspaces);
    this.filesystem = new FilesystemService(this.policy);
    this.git = new GitService(this.policy);
    this.patcher = new PatchService(this.policy);
    this.jobs = new JobManager({ policy: this.policy, runnerId: options.config.runnerId, maxConcurrentJobs: options.config.maxConcurrentJobs ?? 1, ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }), ...(options.onJobEvent === undefined ? {} : { onEvent: options.onJobEvent }) });
  }
  public async initialize(): Promise<void> { await this.jobs.initialize(); }
  public workspaceList(): Record<string, unknown> { return { workspaces: this.policy.list().map((workspace) => ({ workspace_id: workspace.workspaceId, readonly: workspace.readonly, shell: workspace.shell })) }; }
  public envInfo(): Promise<Record<string, unknown>> { return this.environment.get(this.policy.list()); }
  public async dispatch(method: string, input: unknown): Promise<unknown> {
    switch (method) {
      case "workspace.list": return this.workspaceList();
      case "env.info": return this.envInfo();
      case "fs.read": return this.filesystem.read(input);
      case "fs.list": return this.filesystem.list(input);
      case "fs.search": return this.filesystem.search(input);
      case "fs.apply_patch": return this.patcher.apply(input);
      case "fs.patch": { const params = object(input); this.policy.assertWritable(params.workspace_id); return this.patcher.apply(input); }
      case "git.status": return this.git.status(input);
      case "git.diff": return this.git.diff(input);
      case "exec.start": return this.jobs.start(input);
      case "exec.run": return this.run(input);
      case "job.list": return this.jobs.listReconciled(object(input));
      case "job.get": return this.jobs.getReconciled(object(input).job_id);
      case "job.logs": { const params = object(input); return this.jobs.logs(params.job_id, params); }
      case "job.cancel": return this.jobs.cancel(object(input).job_id);
      case "job.input": { const params = object(input); return this.jobs.input(params.job_id, params.data, params.close_stdin === true); }
      default: throw new RpcRuntimeError("method_not_found", `Unsupported method: ${method}`);
    }
  }
  public async syncJobs(): Promise<JobMetadata[]> {
    return (await this.jobs.listReconciled({ limit: 100 })).map((job) => ({ job_id: job.job_id, workspace_id: job.workspace_id, status: job.status, created_at_ms: job.created_at_ms, updated_at_ms: job.updated_at_ms, ...(job.created_by_client_id === null ? {} : { created_by_client_id: job.created_by_client_id }), runner_id: this.config.runnerId }));
  }
  private async run(input: unknown): Promise<Record<string, unknown>> {
    const params = object(input);
    const requested = params.wait_ms === undefined ? LOCAL_RUNNER_OPERATION_TIMEOUT_MS : positiveInteger(params.wait_ms, "wait_ms");
    if (requested > LOCAL_RUNNER_OPERATION_TIMEOUT_MS) throw new RpcRuntimeError("invalid_params", `wait_ms must be at most ${LOCAL_RUNNER_OPERATION_TIMEOUT_MS}`);
    const startParams = { ...params };
    delete startParams.wait_ms;
    const job = await this.jobs.start(startParams);
    const deadline = Date.now() + requested;
    while (Date.now() < deadline) { const current = this.jobs.get(job.job_id); if (!isActive(current)) return { job: current, completed: true, stdout: await this.jobs.logs(job.job_id, { stream: "stdout", limit: 16 * 1024, tail: true }), stderr: await this.jobs.logs(job.job_id, { stream: "stderr", limit: 16 * 1024, tail: true }) }; await delay(Math.min(50, deadline - Date.now())); }
    return { job: this.jobs.get(job.job_id), completed: false, wait_cap_ms: LOCAL_RUNNER_OPERATION_TIMEOUT_MS };
  }
}

export { RpcRuntimeError } from "./errors.js";
export function rpcError(error: unknown): { code: string; message: string; details?: Record<string, unknown> | undefined } { if (error instanceof PathPolicyError || error instanceof RpcRuntimeError) return { code: error.code, message: error.message.slice(0, 4_096), ...(error instanceof RpcRuntimeError && error.details === undefined ? {} : { details: (error as RpcRuntimeError).details }) }; return { code: "invalid_request", message: (error instanceof Error ? error.message : "request failed").slice(0, 4_096) || "request failed" }; }
function object(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RpcRuntimeError("invalid_params", "params must be an object"); return value as Record<string, unknown>; }
function positiveInteger(value: unknown, field: string): number { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new RpcRuntimeError("invalid_params", `${field} must be a positive integer`); return value as number; }
function isActive(job: JobRecord): boolean { return job.status === "queued" || job.status === "running" || job.status === "cancelling"; }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))); }
