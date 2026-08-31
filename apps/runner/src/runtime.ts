import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { LOCAL_RUNNER_OPERATION_TIMEOUT_MS } from "@aloneio/runmesh-protocol";
import type { RunnerConfig } from "./config.js";
import { GitService } from "./git-service.js";
import { FilesystemService } from "./filesystem.js";
import { JobManager, type JobEvent, type JobRecord } from "./jobs.js";
import { PatchService } from "./patch-service.js";
import { PathPolicy, PathPolicyError } from "./path-policy.js";
import { RpcRuntimeError } from "./errors.js";
import type { JobMetadata } from "./protocol-types.js";
import type { HostPlatform } from "./platform-types.js";

export interface ShellRuntime {
  readonly kind: "bash" | "powershell";
  readonly executable: string;
  readonly version?: string | undefined;
  readonly buildInvocation: (command: string) => { readonly file: string; readonly args: readonly string[] };
}

export interface ShellRuntimeOptions {
  readonly platform?: HostPlatform;
  readonly probe?: (command: string, args: readonly string[]) => Promise<string | undefined>;
}

// PowerShell cold-starts are materially slower than the other local probes on
// Windows (especially on CI or a freshly provisioned host). Keep generic tool
// discovery fast, but give shell discovery enough time to avoid reporting a
// false `shell_unavailable` result while the executable is still starting.
const GENERAL_PROBE_TIMEOUT_MS = 1_000;
const SHELL_PROBE_TIMEOUT_MS = 5_000;

export async function discoverShellRuntime(options: ShellRuntimeOptions = {}): Promise<ShellRuntime | undefined> {
  const platform = options.platform ?? process.platform;
  const probe = options.probe ?? ((command, args) => probeVersion(command, args, SHELL_PROBE_TIMEOUT_MS));
  const candidates = platform === "win32"
    ? [["pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"]] as const, ["powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"]] as const]
    : [["/bin/bash", ["--version"]] as const, ["/usr/bin/bash", ["--version"]] as const];
  for (const [executable, args] of candidates) {
    const version = await probe(executable, args);
    if (version === undefined) continue;
    if (platform === "win32") return { kind: "powershell", executable, ...(version === undefined ? {} : { version: version.trim().slice(0, 512) }), buildInvocation: (command) => ({ file: executable, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] }) };
    return { kind: "bash", executable, ...(version === undefined ? {} : { version: version.trim().split("\n", 1)[0]?.slice(0, 512) }), buildInvocation: (command) => ({ file: executable, args: ["-lc", command] }) };
  }
  return undefined;
}

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
function probeVersion(command: string, args: readonly string[], timeoutMs = GENERAL_PROBE_TIMEOUT_MS): Promise<string | undefined> { return new Promise((resolve) => { let settled = false; let output = ""; const child = spawn(command, [...args], { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); const finish = (value: string | undefined): void => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); }; const timer = setTimeout(() => { child.kill("SIGKILL"); finish(undefined); }, timeoutMs); const collect = (chunk: Buffer): void => { output = `${output}${chunk.toString()}`.slice(0, 1_024); }; child.stdout?.on("data", collect); child.stderr?.on("data", collect); child.once("error", () => finish(undefined)); child.once("close", (code) => finish(code === 0 ? output.trim().slice(0, 512) || undefined : undefined)); }); }

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
  private shellRuntime: ShellRuntime | undefined;
  private readonly environment: EnvironmentInfoService;

  public constructor(options: RunnerRuntimeOptions) {
    this.config = options.config;
    this.environment = options.environment ?? new EnvironmentInfoService();
    this.policy = new PathPolicy(options.config.workspaces);
    this.filesystem = new FilesystemService(this.policy);
    this.git = new GitService(this.policy);
    this.patcher = new PatchService(this.policy);
    this.jobs = new JobManager({ policy: this.policy, runnerId: options.config.runnerId, maxConcurrentJobs: options.config.maxConcurrentJobs ?? 1, ...(options.config.maxRetainedJobs === undefined ? {} : { maxRetainedJobs: options.config.maxRetainedJobs }), ...(options.config.maxLogBytesPerJob === undefined ? {} : { maxLogBytesPerJob: options.config.maxLogBytesPerJob }), ...(options.config.maxTotalLogBytes === undefined ? {} : { maxTotalLogBytes: options.config.maxTotalLogBytes }), ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }), ...(options.onJobEvent === undefined ? {} : { onEvent: options.onJobEvent }) });
  }
  public async initialize(): Promise<void> {
    await this.jobs.initialize();
    this.shellRuntime = await discoverShellRuntime();
    if (this.shellRuntime === undefined) return;
  }
  public getShellRuntime(): ShellRuntime | undefined { return this.shellRuntime; }
  public applyPolicy(workspaces: readonly import("./config.js").WorkspaceConfig[]): void {
    this.policy.replace(workspaces);
  }
  public workspaceList(): Record<string, unknown> { return { workspaces: this.policy.list().filter((workspace) => workspace.permissions?.read !== false).map((workspace) => ({ workspace_id: workspace.workspaceId, readonly: workspace.readonly, shell: workspace.shell, enabled: true, permissions: workspace.permissions ?? { read: true, edit: !workspace.readonly, shell: workspace.shell, job_control: workspace.shell } })) }; }
  public syncWorkspaceMetadata(): Array<{ workspace_id: string; persistence: "persistent"; labels: Record<string, string> }> {
    return this.policy.list().filter((workspace) => workspace.permissions?.read !== false).map((workspace) => ({ workspace_id: workspace.workspaceId, persistence: "persistent" as const, labels: {} }));
  }
  public async envInfo(): Promise<Record<string, unknown>> {
    const info = await this.environment.get(this.policy.list().filter((workspace) => workspace.permissions?.read !== false));
    const shell = this.shellRuntime;
    return { ...info, shell: shell === undefined ? { available: false } : { available: true, kind: shell.kind, version: shell.version } };
  }
  public async dispatch(method: string, input: unknown): Promise<unknown> {
    const params = object(input);
    switch (method) {
      case "workspace.list": return this.workspaceList();
      case "env.info": return this.envInfo();
      case "fs.stat": {
        this.policy.assertPermission(params.workspace_id, "read");
        return this.filesystem.stat(params);
      }
      case "fs.read": this.policy.assertPermission(params.workspace_id, "read"); return this.filesystem.read(params);
      case "fs.list": this.policy.assertPermission(params.workspace_id, "read"); return this.filesystem.list(params);
      case "fs.search": this.policy.assertPermission(params.workspace_id, "read"); return this.filesystem.search(params);
      case "fs.apply_patch": this.policy.assertPermission(params.workspace_id, "edit"); return this.patcher.apply(params);
      case "fs.patch": this.policy.assertWritable(params.workspace_id); return this.patcher.apply(params);
      case "git.status": this.policy.assertPermission(params.workspace_id, "read"); return this.git.status(params);
      case "git.diff": this.policy.assertPermission(params.workspace_id, "read"); return this.git.diff(params);
      case "exec.start": return this.startJob(params);
      case "exec.run": return this.run(params);
      case "job.list": this.assertJobsReadable(params.workspace_id); return this.jobs.listReconciled(params);
      case "job.get": { const job = this.jobs.get(params.job_id); this.policy.assertPermission(job.workspace_id, "read"); return this.jobs.getReconciled(params.job_id); }
      case "job.logs": { const job = this.jobs.get(params.job_id); this.policy.assertPermission(job.workspace_id, "read"); return this.jobs.logs(job.job_id, params); }
      case "job.cancel": { const job = this.jobs.get(params.job_id); this.assertJobControl(job.workspace_id); return this.jobs.cancel(job.job_id); }
      case "job.input": { const job = this.jobs.get(params.job_id); this.assertJobControl(job.workspace_id); return this.jobs.input(job.job_id, params.data, params.close_stdin === true); }
      default: throw new RpcRuntimeError("method_not_found", `Unsupported method: ${method}`);
    }
  }
  public async syncJobs(): Promise<JobMetadata[]> {
    const jobs = await this.jobs.listReconciled({ limit: 100 });
    await this.jobs.flushPersistence();
    return jobs.map((job) => ({ job_id: job.job_id, workspace_id: job.workspace_id, status: job.status, created_at_ms: job.created_at_ms, updated_at_ms: job.updated_at_ms, ...(job.created_by_client_id === null ? {} : { created_by_client_id: job.created_by_client_id }), runner_id: this.config.runnerId }));
  }
  private assertJobsReadable(workspaceId: unknown): void {
    if (workspaceId === undefined) {
      for (const workspace of this.policy.list()) this.policy.assertPermission(workspace.workspaceId, "read");
      return;
    }
    this.policy.assertPermission(workspaceId, "read");
  }
  private assertJobControl(workspaceId: string): void {
    const workspace = this.policy.assertPermission(workspaceId, "read");
    if (workspace.permissions !== undefined && !workspace.permissions.job_control) throw new RpcRuntimeError("permission_denied", "job control is disabled for this workspace");
  }
  private async startJob(input: unknown): Promise<import("./jobs.js").JobRecord> {
    const params = object(input); const workspace = this.policy.getWorkspace(params.workspace_id);
    this.policy.assertPermission(workspace.workspaceId, "read");
    if (workspace.permissions !== undefined && (!workspace.permissions.edit || workspace.permissions.shell === false || workspace.permissions.job_control === false)) throw new RpcRuntimeError("permission_denied", "Host shell requires read, edit, and job_control permissions");
     if (params.shell === true && this.shellRuntime === undefined) throw new RpcRuntimeError("shell_unavailable", "the configured Host shell runtime is unavailable");
    const shellParams = params.shell === true && typeof params.command === "string" && this.shellRuntime !== undefined ? { ...params, shell_runtime: this.shellRuntime.buildInvocation(params.command) } : params;
    return this.jobs.start(shellParams);
  }
  private async run(input: unknown): Promise<Record<string, unknown>> {
    const params = object(input);
    const requested = params.wait_ms === undefined ? LOCAL_RUNNER_OPERATION_TIMEOUT_MS : positiveInteger(params.wait_ms, "wait_ms");
    if (requested > LOCAL_RUNNER_OPERATION_TIMEOUT_MS) throw new RpcRuntimeError("invalid_params", `wait_ms must be at most ${LOCAL_RUNNER_OPERATION_TIMEOUT_MS}`);
    const startParams = { ...params };
    delete startParams.wait_ms;
    const job = await this.startJob(startParams);
    const deadline = Date.now() + requested;
    while (Date.now() < deadline) { const current = this.jobs.get(job.job_id); if (!isActive(current)) return { job: current, completed: true, stdout: await this.jobs.logs(job.job_id, { stream: "stdout", limit: 16 * 1024, tail: true }), stderr: await this.jobs.logs(job.job_id, { stream: "stderr", limit: 16 * 1024, tail: true }) }; await delay(Math.min(50, deadline - Date.now())); }
    return { job: this.jobs.get(job.job_id), completed: false, wait_cap_ms: LOCAL_RUNNER_OPERATION_TIMEOUT_MS };
  }
}

export { RpcRuntimeError } from "./errors.js";
export function rpcError(error: unknown): { code: string; message: string; details?: Record<string, unknown> | undefined } { if (error instanceof Error && error.message === "stale_policy") return { code: "stale_policy", message: "RPC policy revision is stale" }; if (error instanceof PathPolicyError || error instanceof RpcRuntimeError) return { code: error.code, message: error.message.slice(0, 4_096), ...(error instanceof RpcRuntimeError && error.details === undefined ? {} : { details: (error as RpcRuntimeError).details }) }; return { code: "invalid_request", message: (error instanceof Error ? error.message : "request failed").slice(0, 4_096) || "request failed" }; }
function object(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RpcRuntimeError("invalid_params", "params must be an object"); return value as Record<string, unknown>; }
function positiveInteger(value: unknown, field: string): number { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new RpcRuntimeError("invalid_params", `${field} must be a positive integer`); return value as number; }
function isActive(job: JobRecord): boolean { return job.status === "queued" || job.status === "running" || job.status === "cancelling"; }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))); }
