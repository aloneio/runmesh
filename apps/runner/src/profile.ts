import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExecutionMode } from "./service.js";
import type { WorkspaceOption } from "./config.js";
import type { HostPlatform } from "./platform-types.js";

export type ProfileExecutionMode = ExecutionMode | "migration_required";
/**
 * `central` profiles receive Workspace authority from the authenticated
 * control plane. `legacy_manual` retains only the deliberately opted-in
 * local CLI compatibility path. Profiles written before this field existed
 * are never guessed into either mode.
 */
export type ProfileManagementMode = "central" | "legacy_manual" | "migration_required";

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
  /**
   * Explicit Workspace authority model. Omitted legacy profiles are reported
   * as migration_required and cannot mutate local Workspace configuration.
   */
  readonly management_mode?: Exclude<ProfileManagementMode, "migration_required">;
  /** Machine service identity. Omitted pre-release profiles require explicit migration before service installation. */
  readonly execution_mode?: ProfileExecutionMode;
}
export interface ProfileStoreOptions { readonly baseDir?: string; readonly filePath?: string; readonly platform?: HostPlatform; readonly home?: string; }
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_WORKSPACES = 64;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
// The validated profile is small (64 workspaces with bounded fields).  Keep a
// hard byte ceiling before JSON parsing so a tampered profile cannot force an
// unbounded allocation in the long-lived Runner process.
const MAX_PROFILE_BYTES = 2 * 1024 * 1024;

export function profileDirectory(options: ProfileStoreOptions = {}): string {
  if (options.baseDir !== undefined) return options.baseDir;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const path = platform === "win32" ? win32 : posix;
  if (platform === "win32") return path.join(process.env.PROGRAMDATA ?? path.join(home, "AppData", "Local"), "Runmesh");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Runmesh");
  return path.join(home, ".config", "runmesh");
}
export function profilePath(options: ProfileStoreOptions = {}): string {
  if (options.filePath !== undefined) return options.filePath;
  // A per-process explicit profile path keeps service and integration launches
  // isolated without making profiles relative to the current workspace.
  if (options.baseDir === undefined && process.env.RUNMESH_RUNNER_PROFILE !== undefined) return process.env.RUNMESH_RUNNER_PROFILE;
  if (options.baseDir === undefined && process.env.CODING_RUNNER_PROFILE !== undefined) return process.env.CODING_RUNNER_PROFILE;
  const path = (options.platform ?? process.platform) === "win32" ? win32 : posix;
  return path.join(profileDirectory(options), "profile.json");
}

export class ProfileStore {
  private readonly path: string;
  private readonly platform: HostPlatform;
  public constructor(options: ProfileStoreOptions = {}) {
    this.path = profilePath(options);
    this.platform = options.platform ?? process.platform;
  }
  public get filePath(): string { return this.path; }
  public async load(): Promise<RunnerProfile | undefined> {
    const raw = await readPrivateProfile(this.path, this.platform).catch((error: unknown) => { if (isErrno(error, "ENOENT")) return undefined; throw error; });
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
    await this.chmodPrivate(directory, 0o700);
    // Use an unpredictable, exclusive temporary name.  A predictable path
    // combined with a plain write would let another local principal place a
    // symlink before enrollment writes the credential-bearing profile.
    const temporary = join(directory, `.profile-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await this.chmodPrivate(temporary, 0o600);
      await rename(temporary, this.path);
      await this.chmodPrivate(this.path, 0o600);
    } finally {
      // A failed write/chmod/rename must not leave a readable stale profile
      // fragment in the configuration directory.
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  public async remove(): Promise<void> { await rm(this.path, { force: true }); }
  public async permissions(): Promise<{ readonly directory_mode?: number; readonly file_mode?: number }> {
    const result: { directory_mode?: number; file_mode?: number } = {};
    // Do not follow a profile symlink while reporting security diagnostics;
    // otherwise doctor could report the target's mode for an attacker-selected
    // file and make an unsafe profile look healthy.
    const directory = await lstat(dirname(this.path)).catch(() => undefined);
    const file = await lstat(this.path).catch(() => undefined);
    if (directory !== undefined) result.directory_mode = directory.mode & 0o777;
    if (file !== undefined) result.file_mode = file.mode & 0o777;
    return result;
  }
  private async chmodPrivate(path: string, mode: number): Promise<void> {
    try {
      await chmod(path, mode);
    } catch (error) {
      // Windows ACLs are managed by the service provisioner; POSIX mode
      // failures must abort enrollment rather than silently publishing a
      // world-readable token profile.
      if (this.platform !== "win32") throw error;
      return;
    }
    if (this.platform !== "win32") {
      const current = await lstat(path);
      if (current.isSymbolicLink() || (mode === 0o700 ? !current.isDirectory() : !current.isFile()) || (current.mode & 0o777) !== mode) {
        throw new Error(`could not secure runner profile path: ${path}`);
      }
    }
  }
}

async function readPrivateProfile(path: string, platform: HostPlatform): Promise<string> {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error("runner profile is not a regular file");
  if (before.size > MAX_PROFILE_BYTES) throw new Error(`runner profile exceeds ${MAX_PROFILE_BYTES} bytes`);
  if (platform !== "win32" && (before.mode & 0o077) !== 0) throw new Error("runner profile is not private");
  // O_NOFOLLOW closes the final-component symlink race on POSIX. Windows has
  // no portable equivalent in Node, so the lstat plus descriptor identity
  // check remains the best available guard there.
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("runner profile changed while being opened");
    if (opened.size > MAX_PROFILE_BYTES) throw new Error(`runner profile exceeds ${MAX_PROFILE_BYTES} bytes`);
    if (platform !== "win32" && (opened.mode & 0o077) !== 0) throw new Error("runner profile is not private");
    // Allocate only the observed size plus one byte.  The sentinel detects a
    // concurrent growth without ever allocating an attacker-controlled size.
    const buffer = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    // A final descriptor stat closes the size-growth/shrink window after the
    // read. Without it, a concurrent writer could append one byte (the extra
    // sentinel slot) and have that mixed snapshot parsed as a profile.
    const final = await handle.stat();
    if (!final.isFile() || final.dev !== opened.dev || final.ino !== opened.ino || final.size !== opened.size || offset !== opened.size) {
      throw new Error("runner profile changed while being read");
    }
    if (offset > MAX_PROFILE_BYTES) throw new Error(`runner profile exceeds ${MAX_PROFILE_BYTES} bytes`);
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

export function validateProfile(value: unknown): RunnerProfile | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || !validServerUrl(item.server_url, item.insecure_local === true) || !validString(item.runner_id, 1, 128) || !SAFE_ID.test(item.runner_id as string) || !validString(item.token, 16, 4_096) || /\s/.test(item.token as string) || CONTROL_CHARACTER_PATTERN.test(item.token as string)) return undefined;
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
  const managementMode: ProfileManagementMode | undefined = item.management_mode === undefined ? "migration_required" : validManagementMode(item.management_mode) ? item.management_mode : undefined;
  if (managementMode === undefined) return undefined;
  const resultBase = { version: 1 as const, server_url: item.server_url as string, runner_id: item.runner_id as string, token: item.token as string, workspaces, ...(managementMode === "migration_required" ? {} : { management_mode: managementMode }) };
  if (executionMode === "migration_required") {
    const result: RunnerProfile = { ...resultBase, ...(item.insecure_local === true ? { insecure_local: true } : {}) };
    return withMaxConcurrentJobs(result, item.max_concurrent_jobs);
  }
  const result: RunnerProfile = { ...resultBase, ...(item.insecure_local === true ? { insecure_local: true } : {}), execution_mode: executionMode };
  return withMaxConcurrentJobs(result, item.max_concurrent_jobs);
}
function validExecutionMode(value: unknown): value is ExecutionMode { return value === "dedicated_user" || value === "privileged_host"; }
function validManagementMode(value: unknown): value is Exclude<ProfileManagementMode, "migration_required"> { return value === "central" || value === "legacy_manual"; }
function withMaxConcurrentJobs(profile: RunnerProfile, value: unknown): RunnerProfile | undefined {
  if (value === undefined) return profile;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 64) return undefined;
  return { ...profile, max_concurrent_jobs: value };
}
function validString(value: unknown, min: number, max: number): value is string { return typeof value === "string" && value.length >= min && value.length <= max && !/[\r\n]/.test(value); }
function validServerUrl(value: unknown, insecureLocal: boolean): value is string {
  if (!validString(value, 2, 2_048)) return false;
  if (CONTROL_CHARACTER_PATTERN.test(value)) return false;
  try {
    const url = new URL(value);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    const safe = url.username === "" && url.password === "" && url.search === "" && url.hash === "";
    if (!safe || !(url.protocol === "wss:" || (url.protocol === "ws:" && loopback && insecureLocal))) return false;
    return url.toString().length <= 2_048;
  } catch { return false; }
}
function isErrno(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code; }

export function profileExecutionMode(profile: RunnerProfile | undefined): ProfileExecutionMode | undefined {
  if (profile === undefined) return undefined;
  return profile.execution_mode ?? "migration_required";
}
export function profileManagementMode(profile: RunnerProfile | undefined): ProfileManagementMode | undefined {
  if (profile === undefined) return undefined;
  return profile.management_mode ?? "migration_required";
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
