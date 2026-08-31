import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { RunnerPolicySchema, policyWithoutChecksum, runnerPolicyChecksum } from "@aloneio/runmesh-protocol";
import { defaultRunnerStateDir } from "./state-path.js";
import type { RunnerPolicy } from "./protocol-types.js";

// RunnerPolicySchema bounds every field well below this limit.  The explicit
// ceiling protects startup/activation from a tampered or concurrently grown
// policy file being fully materialized before validation.
const MAX_POLICY_BYTES = 2 * 1024 * 1024;

export interface PolicyStoreOptions {
  /** Test-only hook to prove a failed candidate write never replaces active policy. */
  readonly failBeforeActivate?: () => void | Promise<void>;
}

/**
 * Durable, fail-closed storage for the complete centrally managed Runner policy.
 * The persisted content is the only source of a recovered central active policy;
 * profile workspaces are deliberately never promoted into this store.
 */
export class PolicyStore {
  public readonly directory: string;
  public readonly activePath: string;
  public readonly previousPath: string;
  /**
   * A Runner can receive policy updates on a replacement socket while an
   * earlier activation is still flushing its candidate.  Serialize the
   * complete candidate/previous/active sequence so two activations cannot
   * interleave their reads and renames and leave disk behind the live policy.
   * Keep the chain alive after a failed activation so one transient disk error
   * does not permanently reject every later update.
   */
  private activationQueue: Promise<void> = Promise.resolve();

  public constructor(stateDir = defaultRunnerStateDir(), private readonly options: PolicyStoreOptions = {}) {
    this.directory = join(stateDir, "policy");
    this.activePath = join(this.directory, "active-policy.json");
    this.previousPath = join(this.directory, "previous-policy.json");
  }

  /** Returns no policy when none was ever committed; corrupt/tampered state fails closed. */
  public async load(runnerId: string): Promise<RunnerPolicy | undefined> {
    const state = await inspectDirectory(dirname(this.directory));
    if (state === "missing") return undefined;
    await assertStateDirectory(dirname(this.directory));
    const policyDirectory = await inspectDirectory(this.directory);
    if (policyDirectory === "missing") return undefined;
    await assertPrivateDirectory(this.directory);
    let content: string;
    try { content = await readPrivateFile(this.activePath); }
    catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw new Error("active policy cannot be read");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(content) as unknown; }
    catch { throw new Error("active policy is corrupt"); }
    const policy = RunnerPolicySchema.safeParse(parsed);
    if (!policy.success || policy.data.runner_id !== runnerId || policy.data.checksum !== runnerPolicyChecksum(policyWithoutChecksum(policy.data))) {
      throw new Error("active policy is invalid");
    }
    return policy.data;
  }

  /**
   * Verifies then atomically replaces active-policy.json. Any failure before the
   * final rename leaves the previous active file untouched. previous-policy.json
   * is a durable rollback aid, not an authorization source.
   */
  public async activate(policy: RunnerPolicy): Promise<void> {
    const verified = RunnerPolicySchema.safeParse(policy);
    if (!verified.success || verified.data.checksum !== runnerPolicyChecksum(policyWithoutChecksum(verified.data))) {
      throw new Error("candidate policy checksum is invalid");
    }
    const prior = this.activationQueue;
    const next = prior.catch(() => undefined).then(() => this.activateVerified(verified.data));
    this.activationQueue = next.catch(() => undefined);
    return next;
  }

  private async activateVerified(policy: RunnerPolicy): Promise<void> {
    await ensurePolicyDirectory(this.directory);

    const candidate = join(this.directory, `candidate-policy.${randomUUID()}.tmp`);
    const previousCandidate = join(this.directory, `previous-policy.${randomUUID()}.tmp`);
    try {
      const prior = await readPrivateFile(this.activePath).catch((error: unknown) => isErrno(error, "ENOENT") ? undefined : Promise.reject(error));
      await writeAndSync(candidate, `${JSON.stringify(policy)}\n`);
      if (prior !== undefined) {
        await writeAndSync(previousCandidate, prior);
        await rename(previousCandidate, this.previousPath);
      }
      await this.options.failBeforeActivate?.();
      await rename(candidate, this.activePath);
      await syncDirectory(this.directory);
    } catch (error) {
      await rm(candidate, { force: true }).catch(() => undefined);
      await rm(previousCandidate, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

async function writeAndSync(path: string, content: string | Uint8Array): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally { await handle.close(); }
}

/** Directory fsync is unavailable on some Windows filesystems; atomic rename still applies there. */
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
function isErrno(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code; }

/**
 * The policy directory is an authorization boundary, not merely a cache.  A
 * pre-existing symlink or group/other-writable parent would let another local
 * principal replace the policy between Runner restarts.  Keep the check
 * intentionally narrow so the service provisioner's 0750 state root remains
 * compatible while its policy child is always 0700.
 */
async function ensurePolicyDirectory(directory: string): Promise<void> {
  const stateDirectory = dirname(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const state = await inspectDirectory(stateDirectory);
  if (state === "missing") throw new Error("Runner state directory is missing");
  await assertStateDirectory(stateDirectory);
  const policy = await inspectDirectory(directory);
  if (policy === "missing") throw new Error("Runner policy directory is missing");
  if (process.platform !== "win32") {
    const stateInfo = await lstat(stateDirectory);
    if ((stateInfo.mode & 0o022) !== 0) throw new Error("Runner state directory is writable by group or others");
    await chmod(directory, 0o700);
    await assertPrivateDirectory(directory);
  }
}

async function inspectDirectory(path: string): Promise<"ok" | "missing"> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Runner policy path is not a regular directory");
    return "ok";
  } catch (error) {
    if (isErrno(error, "ENOENT")) return "missing";
    throw error;
  }
}

async function assertPrivateDirectory(path: string): Promise<void> {
  // Windows ACLs are managed by the native service provisioner; POSIX mode
  // bits are not an authoritative ACL representation on that platform.
  if (process.platform === "win32") return;
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("Runner policy directory is not private");
}

async function assertStateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Runner state path is not a regular directory");
  // A writable parent lets another local principal replace the 0700 policy
  // child even though the child itself is private.
  if (process.platform !== "win32" && (info.mode & 0o022) !== 0) throw new Error("Runner state directory is writable by group or others");
}

async function readPrivateFile(path: string): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("active policy is not a regular file");
  if (info.size > MAX_POLICY_BYTES) throw new Error(`active policy exceeds ${MAX_POLICY_BYTES} bytes`);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error("active policy file is not private");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) throw new Error("active policy changed while being opened");
    if (opened.size > MAX_POLICY_BYTES) throw new Error(`active policy exceeds ${MAX_POLICY_BYTES} bytes`);
    if (process.platform !== "win32" && (opened.mode & 0o077) !== 0) throw new Error("active policy file is not private");
    const buffer = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    // Re-stat the same descriptor so a concurrent append/truncate cannot be
    // silently accepted as a partially mixed policy snapshot.
    const final = await handle.stat();
    if (!final.isFile() || final.dev !== opened.dev || final.ino !== opened.ino || final.size !== opened.size || offset !== opened.size) {
      throw new Error("active policy changed while being read");
    }
    if (offset > MAX_POLICY_BYTES) throw new Error(`active policy exceeds ${MAX_POLICY_BYTES} bytes`);
    return buffer.subarray(0, offset).toString("utf8");
  } finally { await handle.close(); }
}
