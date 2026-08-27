import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExecutionMode } from "./service.js";
import type { WorkspaceOption } from "./config.js";

export type ProfileExecutionMode = ExecutionMode | "migration_required";

export interface StoredWorkspace {
  readonly id: string;
  readonly path: string;
  readonly writable: boolean;
  readonly shell: boolean;
}
export interface RunnerProfile {
  readonly version: 1;
  readonly server_url: string;
  readonly runner_id: string;
  readonly token: string;
  readonly workspaces: readonly StoredWorkspace[];
  readonly max_concurrent_jobs?: number;
  /** Development-only persisted allowance for loopback ws:// profiles. */
  readonly insecure_local?: boolean;
  /** Machine service identity. Omitted pre-release profiles require explicit migration before service installation. */
  readonly execution_mode?: ProfileExecutionMode;
}
export interface ProfileStoreOptions { readonly baseDir?: string; readonly filePath?: string; readonly platform?: NodeJS.Platform; readonly home?: string; }
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_WORKSPACES = 64;

export function profileDirectory(options: ProfileStoreOptions = {}): string {
  if (options.baseDir !== undefined) return options.baseDir;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  if (platform === "win32") return join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "RemoteCodingRunner");
  if (platform === "darwin") return join(home, "Library", "Application Support", "RemoteCodingRunner");
  return join(home, ".remote-coding-runner");
}
export function profilePath(options: ProfileStoreOptions = {}): string {
  if (options.filePath !== undefined) return options.filePath;
  // A per-process explicit profile path keeps service and integration launches
  // isolated without making profiles relative to the current workspace.
  if (options.baseDir === undefined && process.env.CODING_RUNNER_PROFILE !== undefined) return process.env.CODING_RUNNER_PROFILE;
  return join(profileDirectory(options), "profile.json");
}

export class ProfileStore {
  private readonly path: string;
  public constructor(options: ProfileStoreOptions = {}) { this.path = profilePath(options); }
  public get filePath(): string { return this.path; }
  public async load(): Promise<RunnerProfile | undefined> {
    const raw = await readFile(this.path, "utf8").catch((error: unknown) => { if (isErrno(error, "ENOENT")) return undefined; throw error; });
    if (raw === undefined) return undefined;
    let value: unknown;
    try { value = JSON.parse(raw) as unknown; } catch { throw new Error("runner profile is not valid JSON"); }
    return validateProfile(value);
  }
  public async save(profile: RunnerProfile): Promise<void> {
    const valid = validateProfile(profile);
    if (valid === undefined) throw new Error("runner profile is invalid");
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try { await chmod(directory, 0o700); } catch { /* Windows has no POSIX mode */ }
    const temporary = join(directory, `.profile-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    await writeFile(temporary, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600 });
    try { await chmod(temporary, 0o600); } catch { /* Windows has no POSIX mode */ }
    await rename(temporary, this.path);
    try { await chmod(this.path, 0o600); } catch { /* Windows has no POSIX mode */ }
  }
  public async remove(): Promise<void> { await rm(this.path, { force: true }); }
  public async permissions(): Promise<{ readonly directory_mode?: number; readonly file_mode?: number }> {
    const result: { directory_mode?: number; file_mode?: number } = {};
    const directory = await stat(dirname(this.path)).catch(() => undefined);
    const file = await stat(this.path).catch(() => undefined);
    if (directory !== undefined) result.directory_mode = directory.mode & 0o777;
    if (file !== undefined) result.file_mode = file.mode & 0o777;
    return result;
  }
}

export function validateProfile(value: unknown): RunnerProfile | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || !validServerUrl(item.server_url, item.insecure_local === true) || !validString(item.runner_id, 1, 128) || !SAFE_ID.test(item.runner_id as string) || !validString(item.token, 16, 4_096)) return undefined;
  if (!Array.isArray(item.workspaces) || item.workspaces.length > MAX_WORKSPACES) return undefined;
  const workspaces: StoredWorkspace[] = [];
  const seen = new Set<string>();
  for (const entry of item.workspaces) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
    const workspace = entry as Record<string, unknown>;
    if (!validString(workspace.id, 1, 128) || !SAFE_ID.test(workspace.id as string) || seen.has(workspace.id as string) || !validString(workspace.path, 1, 4_096) || typeof workspace.writable !== "boolean" || typeof workspace.shell !== "boolean") return undefined;
    if ((workspace.path as string).includes("\0")) return undefined;
    seen.add(workspace.id as string);
    workspaces.push({ id: workspace.id as string, path: workspace.path as string, writable: workspace.writable, shell: workspace.shell });
  }
  const executionMode: ProfileExecutionMode | undefined = item.execution_mode === undefined ? "migration_required" : validExecutionMode(item.execution_mode) ? item.execution_mode : undefined;
  if (executionMode === undefined) return undefined;
  const resultBase = { version: 1 as const, server_url: item.server_url as string, runner_id: item.runner_id as string, token: item.token as string, workspaces };
  if (executionMode === "migration_required") {
    const result: RunnerProfile = { ...resultBase, ...(item.insecure_local === true ? { insecure_local: true } : {}) };
    return withMaxConcurrentJobs(result, item.max_concurrent_jobs);
  }
  const result: RunnerProfile = { ...resultBase, ...(item.insecure_local === true ? { insecure_local: true } : {}), execution_mode: executionMode };
  return withMaxConcurrentJobs(result, item.max_concurrent_jobs);
}
function validExecutionMode(value: unknown): value is ExecutionMode { return value === "dedicated_user" || value === "privileged_host"; }
function withMaxConcurrentJobs(profile: RunnerProfile, value: unknown): RunnerProfile | undefined {
  if (value === undefined) return profile;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 64) return undefined;
  return { ...profile, max_concurrent_jobs: value };
}
function validString(value: unknown, min: number, max: number): value is string { return typeof value === "string" && value.length >= min && value.length <= max && !/[\r\n]/.test(value); }
function validServerUrl(value: unknown, insecureLocal: boolean): value is string {
  if (!validString(value, 2, 2_048)) return false;
  try {
    const url = new URL(value);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    return url.protocol === "wss:" || (url.protocol === "ws:" && loopback && insecureLocal);
  } catch { return false; }
}
function isErrno(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code; }

export function profileExecutionMode(profile: RunnerProfile | undefined): ProfileExecutionMode | undefined {
  if (profile === undefined) return undefined;
  return profile.execution_mode ?? "migration_required";
}
export function workspaceOptions(profile: RunnerProfile): Array<WorkspaceOption & { readonly: boolean; shell: boolean }> {
  return profile.workspaces.map((workspace) => ({ workspaceId: workspace.id, rootPath: workspace.path, readonly: !workspace.writable, shell: workspace.shell }));
}
export function redactedProfile(profile: RunnerProfile | undefined): Record<string, unknown> | undefined {
  if (profile === undefined) return undefined;
  return { ...profile, token: "[redacted]", workspaces: profile.workspaces.map((workspace) => ({ ...workspace })) };
}
export function defaultWorkspaceId(path: string, existing: readonly StoredWorkspace[] = []): string {
  const base = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "workspace";
  const clean = base.replace(/[^A-Za-z0-9._:-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 120) || "workspace";
  if (!existing.some((item) => item.id === clean)) return clean;
  for (let index = 2; index < 10_000; index += 1) { const candidate = `${clean}-${index}`; if (!existing.some((item) => item.id === candidate)) return candidate; }
  throw new Error("could not allocate workspace id");
}

// No profile is ever created relative to a workspace.
