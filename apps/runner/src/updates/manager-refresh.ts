import { exactRunnerRelease, MAX_RELEASE_ASSET_BYTES, releaseManifestProblem, verifyRunnerReleaseSignature, type ReleaseTrust } from "@aloneio/runmesh-protocol";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, basename, join } from "node:path";
import { exactFileStats, sameFileIdentity } from "../file-identity.js";
import { isManagedService } from "../service.js";
import { parseOwnedManifest } from "../services/manifest-ownership.js";
import { refreshNativeServiceBody, sameWindowsTaskDefinition } from "../services/native-template.js";
import { trustedWindowsEnvironment, trustedWindowsRoot } from "../windows-tools.js";
import { assertSupportedNodeVersion, RUNNER_VERSION } from "../version.js";
import { acquireInstallationLock } from "./installation-lock.js";
import { managerHost, renderMaintenanceManager, type MaintenanceManagerFilesystem } from "./manager-install.js";
import { createManagerRefreshNativePort, validManagerRefreshNativeState, type ManagerRefreshNativePort, type ManagerRefreshNativeState } from "./manager-refresh-native.js";
import type { ManagerRefreshOptions, ManagerRefreshResult } from "./manager-refresh-contracts.js";
import { runnerArchiveFiles } from "./release-archive.js";
export type { ManagerRefreshNativePort, ManagerRefreshNativeState } from "./manager-refresh-native.js";
export type { ManagerRefreshOptions, ManagerRefreshResult } from "./manager-refresh-contracts.js";
export interface ManagerRefreshDurability {
  create(path: string, content: string): Promise<void>;
  syncFile(path: string): Promise<void>;
  syncDirectory(path: string): Promise<void>;
}
/** Test ports isolate native registration, signed fixtures and crash boundaries. */
export interface ManagerRefreshDependencies {
  readonly trust?: ReleaseTrust;
  readonly version?: string;
  readonly invocation?: { readonly runtimePath: string; readonly entryPath: string };
  readonly readBytes?: (path: string, limit: number) => Promise<Uint8Array>;
  readonly durability?: ManagerRefreshDurability;
  readonly acquireLock?: typeof acquireInstallationLock;
  readonly native?: ManagerRefreshNativePort;
  readonly probe?: (runtime: string, bundle?: string) => Promise<string>;
}
type Host = ReturnType<typeof managerHost>;
const hash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const decode = (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
const shaPattern = /^[a-f0-9]{64}$/u;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const versionPattern = /^\d+\.\d+\.\d+(?:-dev\.\d+)?$/u;
const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;

/** Open the observed regular file itself and retain its identity through the read. */
async function boundedBytes(path: string, limit: number): Promise<Uint8Array> {
  const before = exactFileStats(await lstat(path, { bigint: true }));
  if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > limit) throw new Error("Manager refresh source must be a bounded regular file.");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = exactFileStats(await file.stat({ bigint: true }));
    if (!sameFileIdentity(before, opened) || opened.size !== before.size) throw new Error("Manager refresh source changed while opening.");
    const bytes = Buffer.alloc(before.size + 1); let size = 0;
    while (size < bytes.length) { const part = await file.read(bytes, size, bytes.length - size, null); if (part.bytesRead === 0) break; size += part.bytesRead; }
    const after = exactFileStats(await file.stat({ bigint: true })), named = exactFileStats(await lstat(path, { bigint: true }));
    if (size !== before.size || !sameFileIdentity(opened, after) || !sameFileIdentity(opened, named) || named.isSymbolicLink()
      || after.size !== before.size || after.mtimeMs !== opened.mtimeMs || named.mtimeMs !== opened.mtimeMs) throw new Error("Manager refresh source changed while reading.");
    return bytes.subarray(0, size);
  } finally { await file.close(); }
}

async function syncDirectory(path: string, guard: () => void = () => undefined): Promise<void> {
  // Windows supports flushing the regular files below; directory handles do
  // not offer the POSIX fsync contract used by Node's filesystem adapter.
  if (process.platform === "win32") return;
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { guard(); await file.sync(); } finally { await file.close(); }
}
async function syncFile(path: string, guard: () => void = () => undefined): Promise<void> {
  const access = process.platform === "win32" ? constants.O_RDWR : constants.O_RDONLY;
  const file = await open(path, access | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { if (!(await file.stat()).isFile()) throw new Error("Manager refresh recovery file is invalid."); guard(); await file.sync(); }
  finally { await file.close(); }
  await syncDirectory(dirname(path), guard);
}
const createDurability = (guard: () => void): ManagerRefreshDurability => ({
  syncFile: path => syncFile(path, guard), syncDirectory: path => syncDirectory(path, guard),
  async create(path, content) {
    const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    guard();
    const file = await open(temporary, "wx", 0o600);
    let failure: unknown;
    try {
      try { guard(); await file.writeFile(content); guard(); await file.sync(); } finally { await file.close(); }
      // The complete, flushed record is published without replacing another
      // recovery record. A crash before publication leaves a private orphan.
      guard(); await link(temporary, path);
    } catch (error) { failure = error; throw error; }
    finally {
      try { guard(); await unlink(temporary); }
      catch (cleanup) { if (failure !== undefined) throw new AggregateError([failure, cleanup], "Manager recovery-record creation and private-file cleanup failed.", { cause: failure }); throw cleanup; }
    }
    await syncDirectory(dirname(path), guard);
  },
});

function guardedFilesystem(fs: MaintenanceManagerFilesystem, guard: () => void): MaintenanceManagerFilesystem {
  return { ...fs,
    read: path => fs.read(path), stat: path => fs.stat(path), realpath: path => fs.realpath(path),
    mkdir: async (path, mode) => { guard(); await fs.mkdir(path, mode); },
    copy: async (source, destination) => { guard(); await fs.copy(source, destination); },
    write: async (path, content) => { guard(); await fs.write(path, content); },
    rename: async (source, destination) => { guard(); await fs.rename(source, destination); },
    remove: async path => { guard(); await fs.remove(path); },
    chmod: async (path, mode) => { guard(); await fs.chmod(path, mode); },
    symlink: async (source, destination) => { guard(); await fs.symlink(source, destination); },
    ...(fs.createFile === undefined ? {} : { createFile: async (path: string, content: string) => { guard(); await fs.createFile!(path, content); } }),
    ...(fs.syncFile === undefined ? {} : { syncFile: async (path: string) => { guard(); await fs.syncFile!(path); } }),
  };
}

async function probe(runtime: string, bundle?: string): Promise<string> {
  const env = process.platform === "win32" ? trustedWindowsEnvironment(trustedWindowsRoot()) : { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" };
  const running = promisify(execFile)(runtime, bundle === undefined ? ["--version"] : [bundle, "--version"],
    { env, windowsHide: true, timeout: 15_000, maxBuffer: 65_536, encoding: "utf8", killSignal: "SIGKILL" });
  const closed = new Promise<void>(resolve => running.child.once("close", () => resolve()));
  const result = await running.catch(error => {
    if (running.child.pid !== undefined && running.child.exitCode === null && running.child.signalCode === null) running.child.kill("SIGKILL");
    throw error;
  }).finally(() => closed);
  if (result.stderr.trim() !== "") throw new Error("Manager version probe returned diagnostics.");
  return result.stdout.trim();
}

interface RefreshRecord {
  readonly schema_version: 1;
  readonly id: string;
  readonly install_root: string;
  readonly profile_path: string;
  readonly installation_sha256: string;
  readonly native_manifest_sha256: string;
  readonly previous_sha256: string;
  readonly target_sha256: string;
  readonly previous_version: string;
  readonly target_version: string;
  readonly native: ManagerRefreshNativeState;
}

function parseRecord(text: string, host: Host, version: string, targetHash: string): RefreshRecord {
  const value = JSON.parse(text) as Partial<RefreshRecord>;
  if (typeof value !== "object" || value === null || Array.isArray(value) || value.schema_version !== 1
    || typeof value.id !== "string" || !uuidPattern.test(value.id) || value.install_root !== host.layout.installRoot
    || typeof value.profile_path !== "string" || value.target_version !== version || value.target_sha256 !== targetHash
    || typeof value.previous_version !== "string" || !versionPattern.test(value.previous_version)
    || ![value.installation_sha256, value.native_manifest_sha256, value.previous_sha256, value.target_sha256].every(item => typeof item === "string" && shaPattern.test(item))
    || !validManagerRefreshNativeState(value.native, host.platform)
    || Object.keys(value).some(key => !["schema_version", "id", "install_root", "profile_path", "installation_sha256", "native_manifest_sha256", "previous_sha256", "target_sha256", "previous_version", "target_version", "native"].includes(key))) throw new Error("Manager refresh recovery record requires inspection.");
  return value as RefreshRecord;
}

async function verifiedBundle(options: ManagerRefreshOptions, dependencies: ManagerRefreshDependencies, host: Host): Promise<{ version: string; bytes: Uint8Array; nodeMajorMinimum: number }> {
  const version = dependencies.version ?? RUNNER_VERSION, release = exactRunnerRelease(version), read = dependencies.readBytes ?? boundedBytes;
  if (!host.path.isAbsolute(options.releaseDirectory)) throw new Error("Manager release directory must be absolute.");
  const [manifestBytes, signature, descriptor] = await Promise.all([
    read(host.path.join(options.releaseDirectory, "manifest.json"), 65_536),
    read(host.path.join(options.releaseDirectory, "manifest.sig"), 1_024),
    read(host.path.join(options.releaseDirectory, "manifest.signature.json"), 16_384),
  ]);
  const manifest = await verifyRunnerReleaseSignature(manifestBytes, signature, descriptor, dependencies.trust);
  const protocol = manifest as { protocol_min?: unknown; protocol_max?: unknown };
  if (!Number.isSafeInteger(protocol?.protocol_min) || !Number.isSafeInteger(protocol?.protocol_max)
    || Number(protocol.protocol_min) < 1 || Number(protocol.protocol_max) < Number(protocol.protocol_min)
    || releaseManifestProblem(manifest, { ...release, protocol_min: Number(protocol.protocol_min), protocol_max: Number(protocol.protocol_max), compatibility: "overlap", max_asset_bytes: MAX_RELEASE_ASSET_BYTES, node_major: Number(process.versions.node.split(".")[0]) }) !== undefined) throw new Error("Manager release manifest does not match the requested maintenance package.");
  const artifact = (manifest as { artifacts: [{ size: number; sha256: string; node_major_min: number }] }).artifacts[0];
  const archive = await read(host.path.join(options.releaseDirectory, release.artifact_name), MAX_RELEASE_ASSET_BYTES);
  if (archive.byteLength !== artifact.size || hash(archive) !== artifact.sha256) throw new Error("Manager release package does not match its signed digest.");
  const files = runnerArchiveFiles(archive), packageEntry = files.find(file => file.path === "package.json"), entry = files.find(file => file.path === "dist/maintenance.cjs");
  if (packageEntry === undefined || entry === undefined) throw new Error("Manager release package is missing its independent maintenance entry.");
  const identity = JSON.parse(decode(packageEntry.bytes)) as { name?: unknown; version?: unknown; dependencies?: unknown };
  if (identity.name !== "@aloneio/runmesh-runner" || identity.version !== version || (identity.dependencies !== undefined
    && (typeof identity.dependencies !== "object" || identity.dependencies === null || Array.isArray(identity.dependencies) || Object.keys(identity.dependencies).length !== 0))) throw new Error("Manager release package identity is invalid.");
  const invocation = dependencies.invocation ?? { runtimePath: process.execPath, entryPath: process.argv[1] ?? "" };
  const normalized = (path: string) => host.platform === "win32" ? host.path.normalize(path).toLowerCase() : host.path.normalize(path);
  for (const path of [invocation.runtimePath, invocation.entryPath]) {
    if (!host.path.isAbsolute(path)) throw new Error("Run manager-refresh from the verified external maintenance package.");
    const actual = await host.filesystem.realpath(path);
    if (normalized(actual) === normalized(host.managerRoot) || normalized(actual).startsWith(normalized(host.managerRoot) + host.path.sep)) throw new Error("Run manager-refresh with a runtime and entry outside the installed manager directory.");
  }
  if (hash(await read(invocation.entryPath, MAX_BUNDLE_BYTES)) !== hash(entry.bytes)) throw new Error("Executing maintenance entry differs from the signed release package.");
  return { version, bytes: entry.bytes, nodeMajorMinimum: artifact.node_major_min };
}

/** Explicitly refresh only the independent program; its runtime, identity,
 * state, helper, Runner service and selected package remain in place. */
export async function refreshMaintenanceManager(options: ManagerRefreshOptions, dependencies: ManagerRefreshDependencies = {}): Promise<ManagerRefreshResult> {
  const initialHost = managerHost(options), read = dependencies.readBytes ?? boundedBytes;
  const selected = await verifiedBundle(options, dependencies, initialHost), targetHash = hash(selected.bytes), targetText = decode(selected.bytes);
  const lease = await (dependencies.acquireLock ?? acquireInstallationLock)(initialHost.mode, initialHost.layout.installRoot);
  if (lease === undefined) throw new Error("Runner maintenance is active; finish it before refreshing the manager.");
  const guard = () => lease.assertHeld(), fs = guardedFilesystem(initialHost.filesystem, guard);
  const host = managerHost({ ...options, filesystem: fs, executor: { execute: async (file, args) => { guard(); return initialHost.executor.execute(file, args); } } });
  const native = dependencies.native ?? createManagerRefreshNativePort(host, guard), runProbe = dependencies.probe ?? probe;
  const durable = dependencies.durability ?? createDurability(guard);
  const recordPath = host.path.join(host.layout.installRoot, ".manager-refresh.json"), metadataPath = host.path.join(host.managerRoot, "installation.json");
  const idle = async () => {
    guard();
    const stateDirectory = host.path.join(host.managerRoot, "state");
    if (await fs.stat(stateDirectory) !== undefined) await host.trustedTreePath(stateDirectory, "directory", host.layout.installRoot);
    if (await fs.stat(host.path.join(host.managerRoot, "state", "active-operation.json")) !== undefined) throw new Error("Finish the recorded Runner version operation before refreshing its manager.");
  };
  const ownership = async (): Promise<{ metadata: string; manifest: string }> => {
    guard();
    await host.trustedTreePath(host.layout.installRoot, "directory", host.layout.installRoot);
    await host.trustedTreePath(options.profilePath, "file", host.mode === "system" ? host.layout.configRoot : host.path.dirname(options.profilePath));
    const runner = await fs.read(host.layout.manifestPath);
    if (runner === undefined || !isManagedService(runner)) throw new Error("Manager refresh requires its managed Runner service definition.");
    await host.trustedTreePath(host.layout.manifestPath, "file", host.path.dirname(host.layout.manifestPath));
    for (const path of [host.runtimePath, host.bundlePath, metadataPath]) await host.trustedTreePath(path, "file", host.layout.installRoot);
    const metadata = await fs.read(metadataPath), expected = JSON.stringify({ schema_version: 1, platform: host.platform, mode: host.mode, profile_path: options.profilePath, install_root: host.layout.installRoot });
    if (metadata !== expected) throw new Error("Manager refresh belongs to a different installation.");
    await host.trustedTreePath(host.manifestPath, "file", host.path.dirname(host.manifestPath));
    const manifest = await fs.read(host.manifestPath), parsed = manifest === undefined ? undefined : parseOwnedManifest(manifest, "maintenance");
    const rendered = parseOwnedManifest(renderMaintenanceManager(options).content, "maintenance")!;
    if (parsed === undefined || parsed === null) throw new Error("Manager service definition requires inspection.");
    const refreshed = refreshNativeServiceBody(parsed.body, host.platform);
    if (refreshed !== rendered.body && !(host.platform === "win32" && sameWindowsTaskDefinition(refreshed, rendered.body))) throw new Error("Manager service definition belongs to another installation.");
    return { metadata, manifest: manifest! };
  };
  let primary: unknown;
  try {
    const owned = await ownership(); await idle();
    const runtimeVersion = await runProbe(host.runtimePath); assertSupportedNodeVersion(runtimeVersion.replace(/^v/u, ""));
    if (Number(runtimeVersion.replace(/^v/u, "").split(".")[0]) < selected.nodeMajorMinimum) throw new Error("The retained manager runtime does not satisfy the signed maintenance package.");
    let record: RefreshRecord;
    const existingRecord = await fs.stat(recordPath);
    if (existingRecord !== undefined) {
      await host.trustedTreePath(recordPath, "file", host.layout.installRoot);
      record = parseRecord(decode(await read(recordPath, 16_384)), host, selected.version, targetHash);
      if (record.profile_path !== options.profilePath || record.installation_sha256 !== hash(owned.metadata) || record.native_manifest_sha256 !== hash(owned.manifest)) throw new Error("Manager refresh recovery belongs to another installation.");
    } else {
      const previous = await read(host.bundlePath, MAX_BUNDLE_BYTES), previousVersion = await runProbe(host.runtimePath, host.bundlePath);
      if (!versionPattern.test(previousVersion)) throw new Error("Installed manager version requires inspection.");
      if (hash(previous) === targetHash) {
        if (previousVersion !== selected.version) throw new Error("Installed manager version differs from its verified program.");
        return { action: "manager-refresh", manager_version: selected.version, previous_manager_version: previousVersion, runner_unchanged: true, restarted: false };
      }
      const state = await native.snapshot();
      if (!validManagerRefreshNativeState(state, host.platform)) throw new Error("Manager service snapshot requires inspection.");
      record = { schema_version: 1, id: randomUUID(), install_root: host.layout.installRoot, profile_path: options.profilePath,
        installation_sha256: hash(owned.metadata), native_manifest_sha256: hash(owned.manifest), previous_sha256: hash(previous), target_sha256: targetHash,
        previous_version: previousVersion, target_version: selected.version, native: state };
      const backup = host.path.join(host.managerRoot, `.refresh-${record.id}.previous.cjs`), candidate = host.path.join(host.managerRoot, `.refresh-${record.id}.next.cjs`);
      // Before record publication, a failed preparation can leave only these
      // UUID-named private files. They are never reused or selected; retain
      // uncertain writes for inspection rather than deleting an unowned path.
      guard(); await fs.write(backup, decode(previous)); guard(); await durable.syncFile(backup);
      guard(); await fs.write(candidate, targetText); guard(); await durable.syncFile(candidate);
      if (await runProbe(host.runtimePath, candidate) !== selected.version) throw new Error("Candidate manager reported a different version.");
      guard(); await durable.create(recordPath, JSON.stringify(record) + "\n");
      guard(); await durable.syncFile(recordPath);
    }
    const backup = host.path.join(host.managerRoot, `.refresh-${record.id}.previous.cjs`), candidate = host.path.join(host.managerRoot, `.refresh-${record.id}.next.cjs`);
    await host.trustedTreePath(backup, "file", host.layout.installRoot);
    const original = await read(backup, MAX_BUNDLE_BYTES);
    if (hash(original) !== record.previous_sha256) throw new Error("Manager refresh backup differs from its recovery record.");
    const check = async () => {
      guard(); const current = await ownership();
      if (hash(current.metadata) !== record.installation_sha256 || hash(current.manifest) !== record.native_manifest_sha256) throw new Error("Manager installation changed during refresh.");
      if (decode(await read(recordPath, 16_384)) !== JSON.stringify(record) + "\n") throw new Error("Manager refresh recovery record changed.");
      await idle();
      const live = hash(await read(host.bundlePath, MAX_BUNDLE_BYTES));
      if (![record.previous_sha256, record.target_sha256].includes(live)) throw new Error("Manager program changed outside this refresh.");
      return live;
    };
    const replace = async (content: string, expectedHash: string) => {
      await check();
      if (await fs.stat(candidate) !== undefined) {
        await host.trustedTreePath(candidate, "file", host.layout.installRoot);
        const candidateHash = hash(await read(candidate, MAX_BUNDLE_BYTES));
        if (![record.previous_sha256, record.target_sha256].includes(candidateHash)) throw new Error("Manager refresh candidate changed.");
        guard(); await fs.remove(candidate);
      }
      guard(); await fs.write(candidate, content); guard(); await durable.syncFile(candidate);
      if (hash(await read(candidate, MAX_BUNDLE_BYTES)) !== expectedHash) throw new Error("Manager refresh candidate differs from its verified bytes.");
      await check(); guard(); await fs.rename(candidate, host.bundlePath); guard(); await durable.syncFile(host.bundlePath);
    };
    const finish = async (): Promise<boolean> => {
      await check(); guard(); await fs.remove(recordPath); guard(); await durable.syncDirectory(host.layout.installRoot);
      let retained = false;
      for (const path of [candidate, backup]) {
        try { guard(); await fs.remove(path); } catch { retained = true; }
      }
      return retained;
    };
    try {
      await check(); guard(); await native.stop(); await check();
      if (hash(await read(host.bundlePath, MAX_BUNDLE_BYTES)) !== targetHash) await replace(targetText, targetHash);
      if (await runProbe(host.runtimePath, host.bundlePath) !== selected.version) throw new Error("Refreshed manager reported a different version.");
      await check(); guard(); await native.restore(record.native); await check();
    } catch (cause) {
      try {
        await check(); guard(); await native.stop(); await check();
        if (hash(await read(host.bundlePath, MAX_BUNDLE_BYTES)) !== record.previous_sha256) await replace(decode(original), record.previous_sha256);
        if (await runProbe(host.runtimePath, host.bundlePath) !== record.previous_version) throw new Error("Previous manager version did not verify during recovery.");
        await check(); guard(); await native.restore(record.native); await check(); await finish();
      } catch (recovery) { throw new AggregateError([cause, recovery], "Manager refresh and recovery did not complete; inspect the retained recovery files.", { cause }); }
      throw cause;
    }
    // Native restoration is the commit boundary. Cleanup failures after it
    // must not stop a verified manager or undo a completed program replacement.
    const retained = await finish();
    return { action: "manager-refresh", manager_version: selected.version, previous_manager_version: record.previous_version, runner_unchanged: true,
      restarted: record.native.active, ...(retained ? { backup_retained: true as const } : {}) };
  } catch (error) { primary = error; throw error; }
  finally {
    try { await lease.release(); }
    catch (releaseError) {
      if (primary !== undefined) throw new AggregateError([primary, releaseError], "Manager refresh failed and its installation lock could not be released.", { cause: primary });
      throw releaseError;
    }
  }
}
