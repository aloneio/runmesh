import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { chmod, chown, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, posix, relative, resolve, sep, win32 } from "node:path";
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
export interface ProfileStoreOptions {
  readonly baseDir?: string;
  readonly filePath?: string;
  readonly platform?: HostPlatform;
  readonly home?: string;
  /** Service account group used by the dedicated system profile. */
  readonly serviceGroup?: string;
  /** Injectable group id for tests/hosts whose group database is external. */
  readonly serviceGroupId?: number;
  /** Force canonical ownership checks for an injected profile path. */
  readonly enforceServiceOwnership?: boolean;
}

export interface ProfilePermissions {
  readonly directory_mode?: number;
  readonly file_mode?: number;
  readonly directory_uid?: number;
  readonly directory_gid?: number;
  readonly file_uid?: number;
  readonly file_gid?: number;
}

/**
 * Save-time security overrides used only by transaction rollback.  A normal
 * save preserves the access shape required by a dedicated service (root:
 * runmesh/0640); rollback of a legacy, unmanaged profile must instead return
 * to an owner-only root:root profile before any service can consume it.
 */
export interface ProfileSaveOptions {
  readonly privateOwnerOnly?: boolean;
}

export interface ProfileOwnershipCheck {
  readonly ok: boolean;
  /** False when the profile is not a system profile on this host. */
  readonly checked: boolean;
  readonly expected_uid?: number;
  readonly expected_gid?: number;
  readonly actual_directory_uid?: number;
  readonly actual_directory_gid?: number;
  readonly actual_file_uid?: number;
  readonly actual_file_gid?: number;
  readonly detail?: string;
}
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_GROUP = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const MAX_WORKSPACES = 64;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
// The validated profile is small (64 workspaces with bounded fields).  Keep a
// hard byte ceiling before JSON parsing so a tampered profile cannot force an
// unbounded allocation in the long-lived Runner process.
const MAX_PROFILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_SERVICE_GROUP = "runmesh";

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
  /** Resolve once so a caller changing cwd cannot redirect a later load/save. */
  private readonly absolutePath: string;
  private readonly platform: HostPlatform;
  private readonly serviceGroup: string;
  private readonly serviceGroupId: number | undefined;
  private readonly enforceServiceOwnership: boolean;
  public constructor(options: ProfileStoreOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.path = profilePath(options);
    this.absolutePath = absoluteProfilePath(this.path, this.platform);
    this.serviceGroup = options.serviceGroup ?? DEFAULT_SERVICE_GROUP;
    if (!SAFE_GROUP.test(this.serviceGroup)) throw new Error("service group must be a safe account name");
    if (options.serviceGroupId !== undefined && (!Number.isSafeInteger(options.serviceGroupId) || options.serviceGroupId < 0)) throw new Error("service group id must be a non-negative integer");
    this.serviceGroupId = options.serviceGroupId;
    this.enforceServiceOwnership = options.enforceServiceOwnership === true;
  }
  /** Service manifests must not depend on the service manager's working cwd. */
  public get filePath(): string { return this.absolutePath; }
  public async load(): Promise<RunnerProfile | undefined> {
    // Pass the same ownership decision used by save()/doctor into the
    // descriptor-based reader.  This is important for injected canonical
    // paths in tests and for service wrappers that deliberately force the
    // system-profile contract: checking only the literal default path would
    // otherwise let a non-root-owned profile pass load() after save() had
    // correctly rejected it.
    const raw = await readPrivateProfile(this.absolutePath, this.platform, this.shouldCheckServiceOwnership()).catch((error: unknown) => { if (isErrno(error, "ENOENT")) return undefined; throw error; });
    if (raw === undefined) return undefined;
    let value: unknown;
    try { value = JSON.parse(raw) as unknown; } catch { throw new Error("runner profile is not valid JSON"); }
    return validateProfile(value);
  }
  public async save(profile: RunnerProfile, options: ProfileSaveOptions = {}): Promise<void> {
    const valid = validateProfile(profile);
    if (valid === undefined) throw new Error("runner profile is invalid");
    const privateOwnerOnly = options.privateOwnerOnly === true;
    // This option is intentionally constrained to the canonical POSIX
    // service profile.  Arbitrary/user profiles must retain their normal
    // caller ownership semantics; on those paths it still tightens the mode
    // to 0600 but never attempts a privileged chown.
    const forceCanonicalOwner = privateOwnerOnly && this.shouldCheckServiceOwnership() && this.platform !== "win32";
    const target = this.absolutePath;
    const directory = dirname(target);
    // Walk every existing component and reject symlink/junction directories.
    // A recursive mkdir() followed by chmod() would otherwise follow a
    // pre-created profile-directory symlink and write credentials elsewhere.
    const directoryInfo = await ensureProfileDirectory(directory);
    // A system profile must not live in a directory controlled by an
    // unprivileged local principal.  This check is intentionally limited to
    // the canonical system path (or an explicitly forced test seam), so user
    // profiles remain usable in ordinary home directories.
    if (this.shouldCheckServiceOwnership()) {
      assertRootOwnedDirectory(directoryInfo, "runner profile directory");
    }
    const directoryMode = this.platform === "win32" || privateOwnerOnly ? 0o700 : profileDirectoryMode(directoryInfo.mode & 0o777);
    if (forceCanonicalOwner) {
      // The directory may have been widened to root:runmesh/0750 by a
      // partially completed dedicated-service provision.  Restore the
      // privileged/legacy contract atomically with the profile bytes.
      await chown(directory, 0, 0);
    }
    await this.chmodPrivate(directory, directoryMode, "directory");
    const existing = await lstat(target).catch((error: unknown) => isErrno(error, "ENOENT") ? undefined : Promise.reject(error));
    if (existing !== undefined && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("runner profile is not a regular file");
    const fileMode = this.platform === "win32" || privateOwnerOnly
      ? 0o600
      : profileFileMode(existing?.mode === undefined ? undefined : existing.mode & 0o777);
    // Use an unpredictable, exclusive temporary name.  A predictable path
    // combined with a plain write would let another local principal place a
    // symlink before enrollment writes the credential-bearing profile.
    const temporary = join(directory, `.profile-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      if (this.platform !== "win32") {
        await this.chmodPrivate(temporary, fileMode, "file");
        if (forceCanonicalOwner) {
          // Do not inherit a dedicated-service group from the old inode.
          // Explicitly set both IDs on the temporary inode before rename so a
          // failed migration cannot leave root consuming attacker/group-owned
          // credentials, even if the old profile had been widened already.
          await chown(temporary, 0, 0);
          await this.chmodPrivate(temporary, fileMode, "file");
        }
        // Dedicated system services intentionally use root:runmesh 0640 so
        // the service account can read the profile. Preserve that ownership
        // across an atomic re-enrollment replacement; otherwise save() would
        // silently create a root-only 0600 file and strand the service.
        if (!forceCanonicalOwner && existing !== undefined && typeof existing.uid === "number" && typeof existing.gid === "number"
          // Never carry an attacker-owned canonical inode's uid/gid into the
          // replacement.  A root process will create the temporary inode with
          // root ownership; preserving a non-root owner would let that owner
          // continue supplying credentials to a privileged Runner.
          && (!this.shouldCheckServiceOwnership() || existing.uid === 0)) {
          // A freshly-created temporary file normally already has the caller's
          // ownership. Avoid an unnecessary chown (which requires privilege on
          // many POSIX systems), but preserve a service-managed root:group
          // profile when the replacement inode would otherwise differ.
          const temporaryInfo = await lstat(temporary);
          if (temporaryInfo.uid !== existing.uid || temporaryInfo.gid !== existing.gid) {
            await chown(temporary, existing.uid, existing.gid);
            await this.chmodPrivate(temporary, fileMode, "file");
          }
        }
      } else await this.chmodPrivate(temporary, 0o600, "file");
      await rename(temporary, target);
      if (forceCanonicalOwner) await chown(target, 0, 0);
      await this.chmodPrivate(target, fileMode, "file");
    } finally {
      // A failed write/chmod/rename must not leave a readable stale profile
      // fragment in the configuration directory.
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  public async remove(): Promise<void> { await rm(this.absolutePath, { force: true }); }
  public async permissions(): Promise<ProfilePermissions> {
    const result: { directory_mode?: number; file_mode?: number; directory_uid?: number; directory_gid?: number; file_uid?: number; file_gid?: number } = {};
    // Do not follow a profile symlink while reporting security diagnostics;
    // otherwise doctor could report the target's mode for an attacker-selected
    // file and make an unsafe profile look healthy.
    const directory = await lstat(dirname(this.absolutePath)).catch(() => undefined);
    const file = await lstat(this.absolutePath).catch(() => undefined);
    if (directory !== undefined) {
      result.directory_mode = directory.mode & 0o777;
      if (typeof directory.uid === "number") result.directory_uid = directory.uid;
      if (typeof directory.gid === "number") result.directory_gid = directory.gid;
    }
    if (file !== undefined) {
      result.file_mode = file.mode & 0o777;
      if (typeof file.uid === "number") result.file_uid = file.uid;
      if (typeof file.gid === "number") result.file_gid = file.gid;
    }
    return result;
  }
  /**
   * Check the canonical POSIX ownership contract for a machine profile.
   * Privileged profiles are root:root; dedicated system profiles are
   * root:<serviceGroup>.  Unknown group databases fail closed instead of
   * accepting an arbitrary gid merely because the mode is 0600.
   */
  public async checkServiceOwnership(executionMode: ExecutionMode, serviceGroup: string = this.serviceGroup): Promise<ProfileOwnershipCheck> {
    if (!this.shouldCheckServiceOwnership()) return { ok: true, checked: false, detail: "non-system profile" };
    // A managed manifest may intentionally use a dedicated account/group
    // chosen by the operator. Validate that override with the same grammar as
    // constructor options before resolving it through the local group DB; an
    // arbitrary string must never reach `id`/filesystem ownership checks.
    if (!SAFE_GROUP.test(serviceGroup)) {
      return { ok: false, checked: true, expected_uid: 0, detail: "canonical profile service group is invalid" };
    }
    const permissions = await this.permissions();
    const expectedUid = 0;
    const groupIdOverride = serviceGroup === this.serviceGroup ? this.serviceGroupId : undefined;
    const expectedGid = executionMode === "privileged_host" ? 0 : await resolveServiceGroupId(serviceGroup, groupIdOverride);
    const actual = {
      ...(permissions.directory_uid === undefined ? {} : { actual_directory_uid: permissions.directory_uid }),
      ...(permissions.directory_gid === undefined ? {} : { actual_directory_gid: permissions.directory_gid }),
      ...(permissions.file_uid === undefined ? {} : { actual_file_uid: permissions.file_uid }),
      ...(permissions.file_gid === undefined ? {} : { actual_file_gid: permissions.file_gid }),
    };
    // A dedicated account must never be mapped to the root group (gid 0),
    // even if a corrupted/local group database reports that name.  The
    // privileged contract handles gid 0 explicitly above.
    if (expectedGid === undefined || (executionMode === "dedicated_user" && expectedGid === 0)) {
      return {
        ok: false,
        checked: true,
        expected_uid: expectedUid,
        detail: `canonical profile group ${serviceGroup} could not be resolved safely`,
        ...actual,
      };
    }
    const ownerMatches = permissions.directory_uid === expectedUid && permissions.file_uid === expectedUid;
    const groupMatches = permissions.directory_gid === expectedGid && permissions.file_gid === expectedGid;
    return {
      ok: ownerMatches && groupMatches,
      checked: true,
      expected_uid: expectedUid,
      expected_gid: expectedGid,
      ...(ownerMatches && groupMatches ? {} : { detail: `canonical profile ownership mismatch (expected root:${executionMode === "privileged_host" ? "root" : serviceGroup})` }),
      ...actual,
    };
  }
  /** Throw a bounded error when a machine profile is not canonically owned. */
  public async assertServiceOwnership(executionMode: ExecutionMode, serviceGroup?: string): Promise<void> {
    const check = await this.checkServiceOwnership(executionMode, serviceGroup);
    if (!check.ok) throw new Error(check.detail ?? "runner profile ownership is not canonical");
  }
  /** Expose whether this store points at the host-wide canonical profile. */
  public get isCanonicalSystemProfile(): boolean { return this.shouldCheckServiceOwnership(); }
  private shouldCheckServiceOwnership(): boolean {
    // `platform` may be injected to render another target in tests. Ownership
    // metadata is meaningful only on an actual POSIX host; never apply these
    // checks to a Windows process just because its target platform is Linux.
    if (process.platform === "win32" || this.platform === "win32") return false;
    return this.enforceServiceOwnership || isCanonicalSystemProfilePath(this.absolutePath, this.platform);
  }
  private async chmodPrivate(path: string, mode: number, kind: "directory" | "file"): Promise<void> {
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
      if (current.isSymbolicLink() || (kind === "directory" ? !current.isDirectory() : !current.isFile()) || (current.mode & 0o777) !== mode) {
        throw new Error(`could not secure runner profile path: ${path}`);
      }
    }
  }
}

async function readPrivateProfile(path: string, platform: HostPlatform, enforceOwnership = false): Promise<string> {
  const ownershipRequired = enforceOwnership || (process.platform !== "win32" && isCanonicalSystemProfilePath(path, platform));
  const directory = await lstat(dirname(path));
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("runner profile directory is not a regular directory");
  // A root process must never consume an attacker-owned canonical system
  // profile merely because its mode is 0600.  Check the directory and each
  // opened inode; the latter closes the ownership-change race between lstat
  // and open.
  if (ownershipRequired) assertRootOwnedDirectory(directory, "runner profile directory");
  if (platform !== "win32" && (directory.mode & 0o022) !== 0) throw new Error("runner profile directory is writable by group or others");
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error("runner profile is not a regular file");
  if (ownershipRequired) assertRootOwnedFile(before);
  if (before.size > MAX_PROFILE_BYTES) throw new Error(`runner profile exceeds ${MAX_PROFILE_BYTES} bytes`);
  if (platform !== "win32" && !canReadProfileMode(before.mode & 0o777, before.gid, before.uid)) throw new Error("runner profile is not private");
  // O_NOFOLLOW closes the final-component symlink race on POSIX. Windows has
  // no portable equivalent in Node, so the lstat plus descriptor identity
  // check remains the best available guard there.
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("runner profile changed while being opened");
    if (ownershipRequired) assertRootOwnedFile(opened);
    if (opened.size > MAX_PROFILE_BYTES) throw new Error(`runner profile exceeds ${MAX_PROFILE_BYTES} bytes`);
    if (platform !== "win32" && !canReadProfileMode(opened.mode & 0o777, opened.gid, opened.uid)) throw new Error("runner profile is not private");
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
    if (ownershipRequired) assertRootOwnedFile(final);
    if (offset > MAX_PROFILE_BYTES) throw new Error(`runner profile exceeds ${MAX_PROFILE_BYTES} bytes`);
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Create/validate the profile directory without following a symlinked
 * component. `mkdir({recursive:true})` alone follows such a component before
 * the caller gets a chance to inspect it, which can redirect credential
 * material into an attacker-selected tree.
 */
async function ensureProfileDirectory(path: string): Promise<import("node:fs").Stats> {
  const normalized = resolve(path);
  const root = parse(normalized).root;
  if (normalized === root) throw new Error("runner profile directory must not be a filesystem root");
  const components = relative(root, normalized).split(sep).filter((part) => part.length > 0);
  let current = root;
  for (const component of components) {
    current = join(current, component);
    let info = await lstat(current).catch((error: unknown) => isErrno(error, "ENOENT") ? undefined : Promise.reject(error));
    if (info === undefined) {
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error) {
        // Another process may have created the component between lstat and
        // mkdir. Re-inspect it below; never assume EEXIST names a directory.
        if (!isErrno(error, "EEXIST")) throw error;
      }
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("runner profile directory is not a regular directory");
  }
  return lstat(normalized);
}

/** Keep a dedicated service's group traversal while removing any write bits. */
function profileDirectoryMode(mode: number): number {
  const safe = mode & 0o777;
  // Existing profile directories may be 0750 after service provisioning. A
  // re-enrollment must retain that group-read/execute access; all other
  // group/other write permissions are tightened to owner-only.
  if ((safe & 0o022) !== 0) return 0o700;
  // Keep the exact dedicated-service shape (0750) whenever either group
  // traversal bit was present.  Returning 0740/0710 here would be secure in
  // isolation but would make `doctor` disagree with the provisioner's
  // contract and could strand a service after re-enrollment.
  return (safe & 0o050) !== 0 ? 0o750 : 0o700;
}

/**
 * Profile files are owner-private (0600) or, for a dedicated service account,
 * group-readable (0640). Never preserve other-read or group-write bits.
 */
function profileFileMode(mode: number | undefined): number {
  if (mode === undefined) return 0o600;
  return (mode & 0o040) !== 0 ? 0o640 : 0o600;
}

function canReadProfileMode(mode: number, gid: number, uid: number): boolean {
  // No world permissions and no group write: profile contents are credential
  // material. Owner read is mandatory; group-read is allowed only when this
  // process is the owner or is actually a member of the profile's group.
  if ((mode & 0o007) !== 0 || (mode & 0o020) !== 0 || (mode & 0o400) === 0) return false;
  if ((mode & 0o040) === 0) return true;
  if (typeof process.getuid === "function" && process.getuid() === uid) return true;
  if (typeof process.getuid === "function" && process.getuid() === 0) return true;
  if (typeof process.getgid === "function" && process.getgid() === gid) return true;
  try { return typeof process.getgroups === "function" && process.getgroups().includes(gid); }
  catch { return false; }
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

/** Resolve explicit profile paths with the target host's path semantics. */
function absoluteProfilePath(value: string, platform: HostPlatform): string {
  const path = platform === "win32" ? win32 : posix;
  return path.normalize(path.isAbsolute(value) ? value : path.resolve(value));
}

/**
 * Return true only for the host-wide profile locations managed by the native
 * service installers.  User profiles and arbitrary test paths deliberately do
 * not inherit the root:root/root:runmesh ownership contract.
 */
export function isCanonicalSystemProfilePath(path: string, platform: HostPlatform = process.platform): boolean {
  if (platform !== "linux" && platform !== "darwin") return false;
  const normalized = absoluteProfilePath(path, platform);
  const expected = platform === "linux" ? "/etc/runmesh/profile.json" : "/Library/Application Support/Runmesh/profile.json";
  return posix.normalize(normalized) === expected;
}

function assertRootOwnedDirectory(info: import("node:fs").Stats, label: string): void {
  if (typeof info.uid !== "number" || info.uid !== 0) throw new Error(`${label} must be owned by root`);
}
function assertRootOwnedFile(info: import("node:fs").Stats): void {
  if (typeof info.uid !== "number" || info.uid !== 0) throw new Error("runner profile must be owned by root");
}

/** Resolve a POSIX group using a fixed local database/utility only. */
async function resolveServiceGroupId(name: string, override: number | undefined): Promise<number | undefined> {
  if (override !== undefined) return override;
  try {
    const contents = await readFile("/etc/group", "utf8");
    for (const line of contents.split(/\r?\n/u)) {
      if (line.startsWith("#")) continue;
      const fields = line.split(":");
      if (fields[0] !== name) continue;
      const gid = Number(fields[2]);
      if (Number.isSafeInteger(gid) && gid >= 0) return gid;
    }
  } catch {
    // Directory-service backed macOS groups may not be mirrored in
    // /etc/group; use the fixed absolute `id` path below as a fallback.
  }
  if (process.platform === "win32") return undefined;
  try {
    const result = spawnSync("/usr/bin/id", ["-g", name], {
      cwd: "/",
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
    });
    if (result.status !== 0 || result.error !== undefined) return undefined;
    const gid = Number(typeof result.stdout === "string" ? result.stdout.trim() : "");
    return Number.isSafeInteger(gid) && gid >= 0 ? gid : undefined;
  } catch {
    return undefined;
  }
}

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
