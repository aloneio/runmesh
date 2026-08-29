import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RunnerPolicySchema, policyWithoutChecksum, runnerPolicyChecksum, type RunnerPolicy } from "@aloneio/runmesh-protocol";
import { defaultRunnerStateDir } from "./state-path.js";

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

  public constructor(stateDir = defaultRunnerStateDir(), private readonly options: PolicyStoreOptions = {}) {
    this.directory = join(stateDir, "policy");
    this.activePath = join(this.directory, "active-policy.json");
    this.previousPath = join(this.directory, "previous-policy.json");
  }

  /** Returns no policy when none was ever committed; corrupt/tampered state fails closed. */
  public async load(runnerId: string): Promise<RunnerPolicy | undefined> {
    let content: string;
    try { content = await readFile(this.activePath, "utf8"); }
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
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700).catch(() => undefined);

    const candidate = join(this.directory, `candidate-policy.${randomUUID()}.tmp`);
    const previousCandidate = join(this.directory, `previous-policy.${randomUUID()}.tmp`);
    try {
      const prior = await readFile(this.activePath).catch((error: unknown) => isErrno(error, "ENOENT") ? undefined : Promise.reject(error));
      await writeAndSync(candidate, `${JSON.stringify(verified.data)}\n`);
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
  const handle = await open(path, "wx", 0o600);
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
