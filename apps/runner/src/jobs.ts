import { open, mkdir, readFile, readdir, rename, rm, stat as fileStat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { PROTOCOL_CURRENT_VERSION } from "@aloneio/runmesh-protocol";
import { dirname, join } from "node:path";
import { defaultRunnerStateDir } from "./state-path.js";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { WorkspaceConfig } from "./config.js";
import type { PathPolicy } from "./path-policy.js";
import { utf8BackwardBoundary, utf8ForwardBoundary, utf8SafePrefixLength } from "./utf8-pagination.js";

export type LocalJobStatus = "queued" | "running" | "cancelling" | "cancelled" | "succeeded" | "failed" | "unknown" | "interrupted";
export interface RecoveryLiveness {
  readonly checked_at_ms: number;
  readonly alive: boolean;
  /** `null` means the platform could not safely compare a process-start fingerprint. */
  readonly fingerprint_matches: boolean | null;
}
export interface JobRecord {
  readonly job_id: string;
  readonly workspace_id: string;
  readonly cwd: string;
  readonly command: readonly string[];
  readonly shell: boolean;
  readonly status: LocalJobStatus;
  readonly pid: number | null;
  /** Linux /proc process starttime, when the host exposes it. */
  readonly process_start_fingerprint: string | null;
  /** One recovery-time liveness observation; it is not a claim that a job completed. */
  readonly recovery_liveness: RecoveryLiveness | null;
  readonly created_at_ms: number;
  readonly started_at_ms: number | null;
  readonly updated_at_ms: number;
  readonly completed_at_ms: number | null;
  readonly exit_code: number | null;
  readonly signal: string | null;
  /** Recovery explanation safe to expose to MCP clients. */
  readonly recovery_note: string | null;
  /** True when the persisted output cap discarded one or more bytes. */
  readonly output_truncated: boolean;
  /** MCP client identity that initiated the job; it does not grant ownership. */
  readonly created_by_client_id: string | null;
  /** Persisted evidence that this Runner delivered a cancellation request. */
  readonly cancellation_delivered_at_ms: number | null;
}
export interface JobManagerOptions {
  readonly policy: PathPolicy;
  readonly stateDir?: string;
  readonly runnerId?: string;
  readonly maxConcurrentJobs?: number;
  /** Maximum persisted job records, including active jobs. */
  readonly maxRetainedJobs?: number;
  /** Maximum aggregate stdout+stderr bytes persisted for one job. */
  readonly maxLogBytesPerJob?: number;
  /** Maximum aggregate stdout+stderr bytes persisted across all jobs. */
  readonly maxTotalLogBytes?: number;
  readonly onEvent?: (event: JobEvent) => void;
  /** Test-only process-tree terminator seam; production uses the native implementation. */
  readonly terminateProcess?: (pid: number | null, expectedFingerprint?: string | null) => Promise<boolean>;
}
export type JobEvent = { readonly type: "started" | "output" | "status" | "completed"; readonly job: JobRecord; readonly stream?: "stdout" | "stderr"; readonly data?: string };

const MAX_LOG_RESPONSE_BYTES = 64 * 1024;
const MAX_LOG_READ_BYTES = 64 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_RETAINED_JOBS = 100;
const DEFAULT_MAX_LOG_BYTES_PER_JOB = 4 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_LOG_BYTES = 32 * 1024 * 1024;
const MAX_RETAINED_JOBS = 10_000;
const MAX_CONFIGURED_LOG_BYTES = 512 * 1024 * 1024;

type TerminationCheck =
  | { readonly safe: true }
  | { readonly safe: false; readonly kind: "terminal" | "identity"; readonly message: string };

/** Internal terminator shape carries the non-exported ChildProcess identity. */
type ProcessTerminator = (pid: number | null, expectedFingerprint?: string | null, expectedChild?: ChildProcess) => Promise<boolean>;

/**
 * Local persistent process supervisor.  Process stdio is inherited directly by
 * append-only log descriptors, rather than by a transport-owned WriteStream.
 * This keeps process output independent of a Runner/WebSocket request lifetime.
 */
export class JobManager {
  private readonly policy: PathPolicy;
  private readonly stateDir: string;
  private readonly jobsDir: string;
  private readonly runnerStatePath: string;
  private readonly runnerId: string;
  private readonly maxConcurrentJobs: number;
  private readonly maxRetainedJobs: number;
  private readonly maxLogBytesPerJob: number;
  private readonly maxTotalLogBytes: number;
  private readonly onEvent: (event: JobEvent) => void;
  private readonly terminate: ProcessTerminator;
  private totalLogBytes = 0;
  private readonly jobLogBytes = new Map<string, number>();
  private logWriteChain: Promise<void> = Promise.resolve();
  private readonly jobs = new Map<string, JobRecord>();
  private readonly processes = new Map<string, ChildProcess>();
  private readonly persistChains = new Map<string, Promise<void>>();
  private readonly finishing = new Map<string, Promise<void>>();
  /** A termination decision is published before signalling a child so a
   * close event cannot classify a cancellation as an ordinary failure. */
  private readonly terminationAttempts = new Map<string, Promise<boolean>>();
  private readonly terminationDelivered = new Set<string>();
  /** Serializes retention pruning so concurrent job completions cannot remove the same record or directory twice. */
  private retentionChain: Promise<void> = Promise.resolve();
  /** Serializes admission through the async pre-spawn window. */
  private startChain: Promise<void> = Promise.resolve();

  public constructor(options: JobManagerOptions) {
    this.policy = options.policy;
    this.stateDir = options.stateDir ?? defaultRunnerStateDir();
    this.jobsDir = join(this.stateDir, "jobs");
    this.runnerStatePath = join(this.stateDir, "runner.json");
    this.runnerId = options.runnerId ?? "runner";
    this.maxConcurrentJobs = positiveInteger(options.maxConcurrentJobs ?? 1, "maxConcurrentJobs");
    this.maxRetainedJobs = boundedPositiveInteger(options.maxRetainedJobs ?? DEFAULT_MAX_RETAINED_JOBS, 1, MAX_RETAINED_JOBS, "maxRetainedJobs");
    this.maxLogBytesPerJob = boundedPositiveInteger(options.maxLogBytesPerJob ?? DEFAULT_MAX_LOG_BYTES_PER_JOB, 1, MAX_CONFIGURED_LOG_BYTES, "maxLogBytesPerJob");
    this.maxTotalLogBytes = boundedPositiveInteger(options.maxTotalLogBytes ?? DEFAULT_MAX_TOTAL_LOG_BYTES, 1, MAX_CONFIGURED_LOG_BYTES, "maxTotalLogBytes");
    if (this.maxTotalLogBytes < this.maxLogBytesPerJob) throw new Error("maxTotalLogBytes must be at least maxLogBytesPerJob");
    this.onEvent = options.onEvent ?? (() => undefined);
    // Keep the injectable public seam free of Node-only types so consumers of
    // the published declaration graph do not need @types/node. Native
    // termination still receives the stronger local ChildProcess identity.
    this.terminate = options.terminateProcess === undefined
      ? terminateProcess
      : async (pid, expectedFingerprint) => options.terminateProcess?.(pid, expectedFingerprint) ?? false;
  }

  public async initialize(): Promise<void> {
    await mkdir(this.jobsDir, { recursive: true, mode: 0o700 });
    await atomicJson(this.runnerStatePath, { runner_id: this.runnerId, workspaces: this.policy.list().map((workspace) => workspace.workspaceId), updated_at_ms: Date.now(), version: 1 });
    const aliveJobIds = new Set<string>();
    for (const entry of await readdir(this.jobsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !safeJobId(entry.name)) continue;
      const metaPath = join(this.jobsDir, entry.name, "meta.json");
      const parsed = await readJson<unknown>(metaPath).catch(() => undefined);
      const job = parsed === undefined ? undefined : normalizeJobRecord(parsed);
      if (job === undefined) continue;
      let restored = job;
      // Persisted `unknown` is still a recovered process state. Re-inspect it
      // on every restart; otherwise a second Runner crash would leave the
      // record forever unknown and permanently consume an admission slot.
      if (isActive(job) || job.status === "unknown") {
        // Inspect each recovered process exactly once. A second PID probe can
        // observe a different process and turn a PID-reuse race into a false
        // conclusion during retention pruning.
        const inspection = await inspectProcess(job.pid, job.process_start_fingerprint);
        if (inspection.alive && inspection.fingerprintMatches !== false) aliveJobIds.add(job.job_id);
        const recovery_liveness: RecoveryLiveness = {
          checked_at_ms: Date.now(), alive: inspection.alive, fingerprint_matches: inspection.fingerprintMatches,
        };
        const knownPidReuse = inspection.alive && inspection.fingerprintMatches === false;
        if (job.status === "cancelling") {
          restored = inspection.alive && !knownPidReuse
            ? { ...job, recovery_liveness, recovery_note: "process observed after Runner restart; terminal outcome unavailable until reconciliation", updated_at_ms: Date.now(), completed_at_ms: null, exit_code: null, signal: null }
            : terminalRecoveredJob(job, job.cancellation_delivered_at_ms !== null ? "cancelled" : "interrupted", recovery_liveness);
        } else {
          restored = inspection.alive && !knownPidReuse
            ? { ...job, status: "unknown", recovery_liveness, recovery_note: "process observed after Runner restart; terminal outcome unavailable until reconciliation", updated_at_ms: Date.now(), completed_at_ms: null, exit_code: null, signal: null }
            // An unavailable PID or a fingerprint mismatch is interruption evidence,
            // but is intentionally not a guessed completion timestamp/outcome.
            : terminalRecoveredJob(job, "interrupted", recovery_liveness);
        }
        await this.persist(restored);
      }
      this.jobs.set(restored.job_id, restored);
    }
    this.totalLogBytes = await this.measureLogBytes();
    await this.pruneRetainedJobs(this.maxRetainedJobs, aliveJobIds);
  }

  public list(input: { readonly workspace_id?: unknown; readonly status?: unknown; readonly limit?: unknown } = {}): JobRecord[] {
    return this.filteredList(input);
  }

  /** Reconcile recovered PIDs before returning metadata to remote callers. */
  public async listReconciled(input: { readonly workspace_id?: unknown; readonly status?: unknown; readonly limit?: unknown } = {}): Promise<JobRecord[]> {
    await this.reconcileRecoveredJobs();
    return this.filteredList(input);
  }

  private filteredList(input: { readonly workspace_id?: unknown; readonly status?: unknown; readonly limit?: unknown }): JobRecord[] {
    const workspaceId = input.workspace_id;
    const status = input.status;
    if (workspaceId !== undefined && typeof workspaceId !== "string") throw new Error("workspace_id must be a string");
    if (status !== undefined && !isJobStatus(status)) throw new Error("status is invalid");
    const limit = bounded(input.limit, 1, 100, 100);
    return [...this.jobs.values()]
      .filter((job) => (workspaceId === undefined || job.workspace_id === workspaceId) && (status === undefined || job.status === status))
      .sort((a, b) => b.updated_at_ms - a.updated_at_ms || a.job_id.localeCompare(b.job_id))
      .slice(0, limit);
  }

  public async reconcileRecoveredJobs(): Promise<void> {
    for (const job of [...this.jobs.values()]) await this.reconcileRecoveredJob(job.job_id);
  }

  public get(jobId: unknown): JobRecord {
    if (typeof jobId !== "string") throw new Error("job_id is required");
    const job = this.jobs.get(jobId);
    if (job === undefined) throw new Error("job not found");
    return job;
  }

  public async getReconciled(jobId: unknown): Promise<JobRecord> {
    let job = this.get(jobId);
    if (job.status === "unknown" || job.status === "cancelling") {
      await this.reconcileRecoveredJob(job.job_id);
      job = this.get(jobId);
    }
    return job;
  }

  public async start(input: unknown): Promise<JobRecord> {
    return this.reserveStart(() => this.startReserved(input));
  }

  private async reserveStart<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.startChain;
    let release!: () => void;
    this.startChain = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await operation(); } finally { release(); }
  }

  private async startReserved(input: unknown): Promise<JobRecord> {
    // A recovered live process has no ChildProcess handle in this Runner, so
    // reconciliation is the only way to release its admission slot after it
    // exits. Perform it before pruning/counting; otherwise an `unknown` record
    // could be deleted or ignored and a replacement process admitted beside
    // the still-running recovered job.
    await this.reconcileRecoveredJobs();
    await this.pruneRetainedJobs(this.maxRetainedJobs - 1);
    if (this.jobs.size >= this.maxRetainedJobs) throw new Error(`max retained jobs (${this.maxRetainedJobs}) reached while active jobs are retained`);
    if (this.activeCount() >= this.maxConcurrentJobs) throw new Error(`max concurrent jobs (${this.maxConcurrentJobs}) reached`);
    const params = paramsObject(input);
    const workspace = this.policy.getWorkspace(params.workspace_id);
    const cwd = await this.policy.resolve(workspace.workspaceId, params.cwd ?? ".", "cwd");
    const invocation = parseInvocation(params, workspace);
    const now = Date.now();
    const job: JobRecord = {
      job_id: `job-${randomUUID()}`, workspace_id: workspace.workspaceId, cwd: relativeWorkspacePath(workspace, cwd.path),
      command: invocation.command, shell: invocation.shell, status: "queued", pid: null,
      process_start_fingerprint: null, recovery_liveness: null,
      created_at_ms: now, started_at_ms: null, updated_at_ms: now, completed_at_ms: null, exit_code: null, signal: null,
      recovery_note: null, output_truncated: false, created_by_client_id: safeOptionalIdentifier(params.created_by_client_id), cancellation_delivered_at_ms: null,
    };
    this.jobs.set(job.job_id, job);
    try {
      await mkdir(this.jobDir(job.job_id), { recursive: true, mode: 0o700 });
      await this.persist(job);
    } catch (error) {
      // No child exists yet. If cancellation did not replace the queued
      // record while the filesystem operation was in flight, remove the
      // in-memory reservation and its partial directory so a failed start
      // cannot consume a concurrency slot forever. Preserve any newer record
      // (for example a concurrent queued cancellation) by checking identity.
      if (this.jobs.get(job.job_id) === job) {
        this.jobs.delete(job.job_id);
        this.jobLogBytes.delete(job.job_id);
        await rm(this.jobDir(job.job_id), { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }

    let stdout: Awaited<ReturnType<typeof open>> | undefined;
    let stderr: Awaited<ReturnType<typeof open>> | undefined;
    let child: ChildProcess;
    let running: JobRecord;
    try {
      stdout = await open(this.logPath(job.job_id, "stdout"), "a", 0o600);
      stderr = await open(this.logPath(job.job_id, "stderr"), "a", 0o600);
      // A remote cancel can terminalize the queued record while the log
      // descriptors are opening. Do not resurrect that record by spawning
      // after cancellation; the synchronous status check closes the only
      // remaining window before spawn.
      const beforeSpawn = this.jobs.get(job.job_id);
      if (beforeSpawn === undefined || beforeSpawn.status !== "queued") {
        await this.closeLogHandles(stdout, stderr).catch(() => undefined);
        return beforeSpawn ?? job;
      }
      child = spawn(invocation.file, invocation.args, {
        cwd: cwd.path,
        shell: invocation.shell,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      // Capture the Linux process starttime before any asynchronous descriptor
      // work can let an ultra-short-lived child exit and its PID be reused.
      // A later cancellation compares this immutable birth marker before it
      // sends a PID-based process-group signal.
      const processFingerprint = linuxProcessStartFingerprintSync(child.pid ?? null);
      // Publish the active record and attach all listeners in the same
      // synchronous turn as spawn. A child can exit before the next await;
      // finish must then observe an active job rather than the queued record.
      running = {
        ...job, status: "running", pid: child.pid ?? null, process_start_fingerprint: processFingerprint, started_at_ms: Date.now(), updated_at_ms: Date.now(),
      };
      this.jobs.set(job.job_id, running);
      this.processes.set(job.job_id, child);
      child.once("error", () => { void this.finish(job.job_id, null, null, true).catch(() => undefined); });
      child.once("close", (code, signal) => { void this.finish(job.job_id, code, signal, false).catch(() => undefined); });
      this.attachLogCapture(job.job_id, child);
    } catch (error) {
      await this.closeLogHandles(stdout, stderr).catch(() => undefined);
      // Cancellation may have won while open/spawn was in flight. Re-read
      // after closing descriptors and preserve that terminal decision instead
      // of resurrecting it as a stale spawn failure.
      const current = this.jobs.get(job.job_id);
      if (current !== undefined && current.status !== "queued") return current;
      const failed = { ...job, status: "failed" as const, updated_at_ms: Date.now(), completed_at_ms: Date.now() };
      await this.persist(failed);
      this.jobs.set(job.job_id, failed);
      // A spawn/open failure still creates a durable terminal Job record. Emit
      // it so an online Runner can synchronize the failure to Registry even
      // though no running event was possible.
      this.onEvent({ type: "completed", job: failed });
      throw error;
    }

    // Descriptor cleanup is best effort. A close failure must not leave the
    // spawned job's state hanging at an unobservable queued/running snapshot;
    // the child listeners still drive normal terminal convergence.
    await this.closeLogHandles(stdout, stderr).catch(() => undefined);
    const beforeRunningPersist = this.jobs.get(job.job_id);
    if (beforeRunningPersist === undefined || !isActive(beforeRunningPersist)) {
      // A fast child may have reached a terminal state while the log
      // descriptors were closing. Wait for that finish task's metadata write
      // before returning the result from exec.start.
      await this.waitForTerminal(job.job_id);
      return this.get(job.job_id);
    }
    // Persist the latest in-memory record rather than the initial `running`
    // snapshot: very fast children and output-cap updates can finish while the
    // log descriptors are closing. Never let that stale snapshot overwrite a
    // terminal record.
    await this.persist(beforeRunningPersist);
    const afterRunningPersist = this.jobs.get(job.job_id);
    if (afterRunningPersist === undefined || !isActive(afterRunningPersist)) {
      await this.waitForTerminal(job.job_id);
      return this.get(job.job_id);
    }
    // A fast child can have closed while the running snapshot was being
    // persisted. With terminal publication behind its durability barrier, the
    // in-memory record may still look active until `finishOnce` completes; do
    // not return that stale running result (or emit `started`) in that window.
    const observedChild = this.processes.get(job.job_id);
    if (this.finishing.has(job.job_id) || observedChild?.exitCode !== null || observedChild?.signalCode !== null) {
      await this.waitForTerminal(job.job_id);
      return this.get(job.job_id);
    }
    // Cancellation can win while the running metadata write is settling. A
    // `started` event must never publish a stale running state after the
    // current record has already advanced to cancelling (or another active
    // state), otherwise Registry can regress the job state on receipt.
    if (afterRunningPersist.status !== "running") return afterRunningPersist;
    this.onEvent({ type: "started", job: afterRunningPersist });

    return this.get(job.job_id);
  }

  public async cancel(jobId: unknown): Promise<JobRecord> {
    // Read the local record synchronously before yielding. A close callback can
    // otherwise commit a terminal record while `getReconciled()` is awaiting,
    // leaving this method with a stale running snapshot that could target a
    // reused PID.
    let job = this.get(jobId);
    if (job.status === "unknown" || (job.status === "cancelling" && job.recovery_liveness !== null)) {
      job = await this.getReconciled(jobId);
    }
    if (job.status === "queued") {
      const cancelled = { ...job, status: "cancelled" as const, updated_at_ms: Date.now(), completed_at_ms: Date.now() };
      this.jobs.set(job.job_id, cancelled);
      await this.persist(cancelled);
      this.onEvent({ type: "completed", job: cancelled });
      return cancelled;
    }
    if (job.status === "unknown" || (job.status === "cancelling" && job.recovery_liveness !== null)) return this.cancelRecoveredUnknown(job);
    if (job.status !== "running" && job.status !== "cancelling") return job;

    const expectedChild = this.processes.get(job.job_id);
    const before = await this.checkLocalTerminationTarget(job, expectedChild);
    if (!before.safe) {
      if (before.kind === "terminal") return this.waitForTerminalResult(job.job_id, before.message);
      throw new Error(before.message);
    }
    if (expectedChild === undefined) throw new Error("job process identity could not be verified; cancellation was not sent");
    const cancelling = job.status === "cancelling" ? job : { ...job, status: "cancelling" as const, updated_at_ms: Date.now() };
    if (job.status !== "cancelling") {
      this.jobs.set(job.job_id, cancelling);
      await this.persist(cancelling);
      // The child may have closed while the cancelling write was in flight.
      // Emit a status event only for the record that is still current; a stale
      // cancelling event after `completed` could regress Registry metadata.
      const afterCancellingPersist = this.jobs.get(job.job_id);
      if (afterCancellingPersist === undefined) return job;
      if (!isActive(afterCancellingPersist)) return this.waitForTerminalResult(job.job_id, "job is no longer active; cancellation was not sent");
      if (afterCancellingPersist.status !== "cancelling") return afterCancellingPersist;
      this.onEvent({ type: "status", job: afterCancellingPersist });
    }
    let termination: Promise<boolean> | undefined;
    try {
      // Re-read both the record and ChildProcess after the durable state write;
      // the process may have exited during that asynchronous window.
      const current = this.jobs.get(cancelling.job_id);
      if (current === undefined) return job;
      if (!isActive(current)) return this.waitForTerminalResult(cancelling.job_id, "job is no longer active; cancellation was not sent");
      const after = await this.checkLocalTerminationTarget(current, expectedChild);
      if (!after.safe) {
        if (after.kind === "terminal") return this.waitForTerminalResult(cancelling.job_id, after.message);
        return this.markUnsafeLocalCancellation(current, after.message);
      }
      // Register the pending decision before invoking the platform-specific
      // process-tree terminator. The child may emit `close` immediately after
      // the signal/taskkill request; finishOnce waits for this decision before
      // choosing failed versus cancelled.
      termination = this.terminationAttempts.get(cancelling.job_id) ?? this.beginTermination(cancelling.job_id, current.pid, expectedChild, current.process_start_fingerprint);
      const delivered = await termination;
      if (!delivered) {
        // A false result means no cancellation-delivery evidence exists. Do
        // one final observation so a process that exited concurrently can
        // still converge through its close handler; if it is demonstrably
        // alive, fail promptly instead of waiting forever for a child that
        // the platform refused to terminate.
        const undelivered = this.jobs.get(cancelling.job_id);
        if (undelivered === undefined) return job;
        if (!isActive(undelivered)) return this.waitForTerminalResult(cancelling.job_id, "job is no longer active; cancellation was not sent");
        const verification = await this.checkLocalTerminationTarget(undelivered, expectedChild);
        if (!verification.safe) {
          if (verification.kind === "terminal") return this.waitForTerminalResult(cancelling.job_id, verification.message);
          return this.markUnsafeLocalCancellation(undelivered, verification.message);
        }
        if (undelivered.status === "cancelling" && undelivered.cancellation_delivered_at_ms === null) {
          const running = { ...undelivered, status: "running" as const, updated_at_ms: Date.now() };
          this.jobs.set(running.job_id, running);
          await this.persist(running);
          this.onEvent({ type: "status", job: running });
        }
        throw new Error("process termination was not delivered; job remains running");
      }
      this.terminationDelivered.add(cancelling.job_id);
      const deliveredCurrent = this.jobs.get(cancelling.job_id);
      // A close handler may have already committed a terminal record while
      // the termination command was settling. Never resurrect that record
      // with the stale `cancelling` snapshot.
      if (deliveredCurrent !== undefined && deliveredCurrent.status === "cancelling") {
        const deliveredRecord = { ...deliveredCurrent, cancellation_delivered_at_ms: Date.now(), updated_at_ms: Date.now() };
        this.jobs.set(deliveredRecord.job_id, deliveredRecord);
        await this.persist(deliveredRecord);
      }
    } catch (error) {
      // Do not falsely report cancellation merely because process-tree control
      // failed. The original local child remains observable and may exit normally.
      const current = this.jobs.get(job.job_id);
      if (current?.status === "cancelling" && current.cancellation_delivered_at_ms === null && this.processes.get(job.job_id) === expectedChild && expectedChild?.exitCode === null && expectedChild.signalCode === null) {
        const running = { ...current, status: "running" as const, updated_at_ms: Date.now() };
        this.jobs.set(job.job_id, running);
        await this.persist(running);
        this.onEvent({ type: "status", job: running });
      }
      throw error;
    } finally {
      // A concurrent cancel may have installed a newer attempt after this
      // one settled. Do not erase that newer decision from the map.
      if (termination !== undefined && this.terminationAttempts.get(cancelling.job_id) === termination) this.terminationAttempts.delete(cancelling.job_id);
    }
    await this.waitForTerminal(job.job_id);
    return this.get(jobId);
  }

  /**
   * Confirm that the local ChildProcess still names the persisted job before
   * sending a PID-based process-tree signal. On Linux, compare the recorded
   * `/proc` start fingerprint when one is available; on other hosts the live
   * ChildProcess handle and exit state are the strongest local proof.
   */
  private async checkLocalTerminationTarget(job: JobRecord, expectedChild: ChildProcess | undefined): Promise<TerminationCheck> {
    const current = this.jobs.get(job.job_id);
    if (current === undefined || !isActive(current) || current.pid !== job.pid) return { safe: false, kind: "terminal", message: "job is no longer active; cancellation was not sent" };
    if (expectedChild === undefined || this.processes.get(job.job_id) !== expectedChild || expectedChild.pid === undefined || expectedChild.pid !== job.pid) {
      return { safe: false, kind: "identity", message: "job process identity could not be verified; cancellation was not sent" };
    }
    if (expectedChild.exitCode !== null || expectedChild.signalCode !== null) return { safe: false, kind: "terminal", message: "job process has already exited; cancellation was not sent" };
    const inspection = await inspectProcess(job.pid, job.process_start_fingerprint);
    if (!inspection.alive) return { safe: false, kind: "terminal", message: "job process has already exited; cancellation was not sent" };
    // Linux exposes a process starttime, so cancellation is fail-closed when
    // either the recorded marker or the verification read is unavailable. A
    // PID alone is not proof of identity after a fast exit/reuse.
    if (process.platform === "linux" && (job.process_start_fingerprint === null || inspection.fingerprintMatches !== true)) return { safe: false, kind: "identity", message: "job process identity could not be verified; cancellation was not sent" };
    // The fingerprint probe yields to the event loop; verify the in-memory
    // record and ChildProcess again before the signal call.
    const latest = this.jobs.get(job.job_id);
    const latestChild = this.processes.get(job.job_id);
    if (latest === undefined || !isActive(latest) || latest.pid !== job.pid) return { safe: false, kind: "terminal", message: "job is no longer active; cancellation was not sent" };
    if (latestChild !== expectedChild || expectedChild.exitCode !== null || expectedChild.signalCode !== null) return { safe: false, kind: "identity", message: "job process identity could not be verified; cancellation was not sent" };
    return { safe: true };
  }

  private async waitForTerminalResult(jobId: string, message: string): Promise<JobRecord> {
    await this.waitForTerminal(jobId);
    const current = this.jobs.get(jobId);
    if (current !== undefined && !isActive(current)) return current;
    throw new Error(message);
  }

  /** Convert an identity-loss observation to durable interruption evidence. */
  private async markUnsafeLocalCancellation(job: JobRecord, message: string): Promise<JobRecord> {
    const current = this.jobs.get(job.job_id);
    if (current === undefined) throw new Error("job not found");
    if (!isActive(current)) return current;
    const terminal = { ...terminalRecoveredJob(current, "interrupted", { checked_at_ms: Date.now(), alive: false, fingerprint_matches: false }), recovery_note: message.slice(0, 512) };
    this.jobs.set(terminal.job_id, terminal);
    this.processes.delete(terminal.job_id);
    await this.persist(terminal);
    this.onEvent({ type: "completed", job: terminal });
    return terminal;
  }

  /** Wait until the local child and its terminal metadata persistence finish. */
  private async waitForTerminal(jobId: string): Promise<void> {
    for (;;) {
      // finishOnce publishes the terminal record only after its atomic metadata
      // write succeeds. Observe the in-flight task first so callers do not
      // return a terminal result before that durability barrier settles.
      const finishing = this.finishing.get(jobId);
      if (finishing !== undefined) {
        await finishing;
        continue;
      }
      const current = this.jobs.get(jobId);
      if (current === undefined || !isActive(current)) return;
      const child = this.processes.get(jobId);
      if (child === undefined) return;
      if (child.exitCode !== null || child.signalCode !== null) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        continue;
      }
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
    }
  }

  public async input(jobId: unknown, data: unknown, closeStdin = false): Promise<{ accepted: number; eof: boolean }> {
    const job = this.get(jobId);
    if (data !== undefined && (typeof data !== "string" || Buffer.byteLength(data, "utf8") > MAX_INPUT_BYTES)) {
      throw new Error("input must be a UTF-8 string no larger than 65536 bytes");
    }
    if (data === undefined && !closeStdin) throw new Error("input data or close_stdin is required");
    const child = this.processes.get(job.job_id);
    if (child === undefined || job.status !== "running") throw new Error("job does not accept input");
    const stdin = child.stdin;
    if (stdin === null || stdin.destroyed || stdin.writableEnded) throw new Error("job does not accept input");
    const accepted = data === undefined ? 0 : Buffer.byteLength(data, "utf8");
    if (data !== undefined && data.length > 0 && !stdin.write(data, "utf8")) {
      await new Promise<void>((resolve, reject) => { stdin.once("drain", resolve); stdin.once("error", reject); });
    }
    if (closeStdin) {
      await new Promise<void>((resolve, reject) => {
        stdin.once("error", reject);
        stdin.end(() => resolve());
      });
    }
    return { accepted, eof: closeStdin };
  }

  public async logs(jobId: unknown, input: unknown = {}): Promise<Record<string, unknown>> {
    const job = this.get(jobId);
    const params = paramsObject(input);
    const stream = params.stream === "stderr" ? "stderr" : "stdout";
    const limit = bounded(params.limit, 1, MAX_LOG_READ_BYTES, 16 * 1024);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(this.logPath(job.job_id, stream), "r");
    } catch {
      return { job_id: job.job_id, stream, data: "", offset: 0, next_cursor: null, truncated: false, size: 0 };
    }
    try {
      const info = await handle.stat();
      const requestedOffset = bounded(params.cursor ?? params.offset, 0, info.size, 0);
      const requested = params.tail === true ? Math.max(0, info.size - limit) : requestedOffset;
      const offset = await utf8AlignedStart(handle, requested, info.size, params.tail === true);
      // Read enough bytes to finish one multibyte code point when a tiny caller
      // limit lands in its middle; the JSON response cap below remains absolute.
      const readLength = Math.min(info.size - offset, limit + 3);
      const buffer = Buffer.alloc(readLength);
      const { bytesRead } = await handle.read(buffer, 0, readLength, offset);
      const data = buffer.subarray(0, bytesRead);
      const maxByLimit = utf8SafePrefixLength(data, Math.min(limit, data.length));
      const firstCodePoint = maxByLimit === 0 && data.length > 0 ? utf8SafePrefixLength(data, Math.min(4, data.length)) : maxByLimit;
      const used = this.fitLogResponse(job.job_id, stream, offset, info.size, data, firstCodePoint);
      const next = offset + used;
      return logResult(job.job_id, stream, offset, info.size, data.subarray(0, used).toString("utf8"), next);
    } finally {
      await handle.close();
    }
  }

  private fitLogResponse(jobId: string, stream: "stdout" | "stderr", offset: number, size: number, data: Buffer, initial: number): number {
    let low = 0;
    let high = initial;
    let best = 0;
    while (low <= high) {
      const midpoint = Math.floor((low + high) / 2);
      const length = utf8SafePrefixLength(data, midpoint);
      const next = offset + length;
      const candidate = logResult(jobId, stream, offset, size, data.subarray(0, length).toString("utf8"), next);
      if (wireResponseBytes(candidate) <= MAX_LOG_RESPONSE_BYTES) {
        best = length;
        low = midpoint + 1;
      } else {
        high = midpoint - 1;
      }
    }
    // A valid UTF-8 character always fits in a 64 KiB response; the fallback
    // protects this invariant even for hostile/corrupt raw log bytes.
    return best === 0 && initial > 0 && wireResponseBytes(logResult(jobId, stream, offset, size, data.subarray(0, initial).toString("utf8"), offset + initial)) <= MAX_LOG_RESPONSE_BYTES ? initial : best;
  }

  private reserveLogBytes(jobId: string, chunk: Buffer): { readonly data: Buffer; readonly truncated: boolean } {
    if (chunk.byteLength === 0) return { data: chunk, truncated: false };
    const jobBytes = this.jobLogBytes.get(jobId) ?? 0;
    const available = Math.max(0, Math.min(this.maxLogBytesPerJob - jobBytes, this.maxTotalLogBytes - this.totalLogBytes));
    const data = chunk.subarray(0, available);
    if (data.byteLength > 0) {
      this.jobLogBytes.set(jobId, jobBytes + data.byteLength);
      this.totalLogBytes += data.byteLength;
    }
    return { data, truncated: data.byteLength !== chunk.byteLength };
  }

  private queueLogAppend(jobId: string, stream: "stdout" | "stderr", chunk: Buffer): void {
    // Child stdout/stderr can deliver a final data event after `close` has
    // published a terminal record. Ignore such late bytes; otherwise a log
    // callback can mutate terminal metadata (or race retention and recreate a
    // pruned job directory).
    const current = this.jobs.get(jobId);
    if (current === undefined || !isActive(current)) return;
    const reserved = this.reserveLogBytes(jobId, chunk);
    if (reserved.truncated) void this.markOutputTruncated(jobId);
    if (reserved.data.byteLength === 0) return;
    const prior = this.logWriteChain;
    this.logWriteChain = prior.catch(() => undefined).then(async () => {
      // The write itself is asynchronous, so the job may have terminalized or
      // been pruned since the reservation above. Release the reservation and
      // avoid reopening a removed directory in that case.
      const latest = this.jobs.get(jobId);
      if (latest === undefined || !isActive(latest)) {
        this.releaseLogBytes(jobId, reserved.data.byteLength);
        return;
      }
      try { await writeFile(this.logPath(jobId, stream), reserved.data, { flag: "a", mode: 0o600 }); }
      catch {
        this.releaseLogBytes(jobId, reserved.data.byteLength);
        await this.markOutputTruncated(jobId);
      }
    });
  }

  private async markOutputTruncated(jobId: string): Promise<void> {
    const current = this.jobs.get(jobId);
    if (current === undefined || !isActive(current) || current.output_truncated) return;
    const updated = { ...current, output_truncated: true };
    this.jobs.set(jobId, updated);
    await this.persist(updated);
  }

  private releaseLogBytes(jobId: string, bytes: number): void {
    this.totalLogBytes = Math.max(0, this.totalLogBytes - bytes);
    const current = this.jobLogBytes.get(jobId);
    if (current === undefined) return;
    const remaining = current - bytes;
    if (remaining <= 0) this.jobLogBytes.delete(jobId);
    else this.jobLogBytes.set(jobId, remaining);
  }

  private attachLogCapture(jobId: string, child: ChildProcess): void {
    for (const stream of ["stdout", "stderr"] as const) {
      const source = child[stream];
      source?.on("data", (chunk: Buffer) => this.queueLogAppend(jobId, stream, Buffer.from(chunk)));
    }
  }

  private async jobLogSize(jobId: string): Promise<number> {
    const sizes = await Promise.all((["stdout", "stderr"] as const).map(async (stream) => (await fileStat(this.logPath(jobId, stream)).catch(() => undefined))?.size ?? 0));
    return (sizes[0] ?? 0) + (sizes[1] ?? 0);
  }

  private async measureLogBytes(): Promise<number> {
    let total = 0;
    for (const job of this.jobs.values()) {
      const size = await this.jobLogSize(job.job_id);
      this.jobLogBytes.set(job.job_id, size);
      total += size;
    }
    return total;
  }

  /** Delete only terminal records, preserving active/recovery evidence. */
  private async pruneRetainedJobs(retainedLimit = this.maxRetainedJobs, aliveJobIds: ReadonlySet<string> = new Set()): Promise<void> {
    const prior = this.retentionChain;
    let release!: () => void;
    this.retentionChain = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      await this.pruneRetainedJobsNow(retainedLimit, aliveJobIds);
    } finally {
      release();
    }
  }

  private async pruneRetainedJobsNow(retainedLimit: number, aliveJobIds: ReadonlySet<string>): Promise<void> {
    const removable = [...this.jobs.values()]
      .filter((job) => !occupiesProcessSlot(job) && !aliveJobIds.has(job.job_id))
      .sort((a, b) => a.updated_at_ms - b.updated_at_ms || a.job_id.localeCompare(b.job_id));
    while (this.jobs.size > retainedLimit && removable.length > 0) {
      const job = removable.shift() as JobRecord;
      this.totalLogBytes = Math.max(0, this.totalLogBytes - (this.jobLogBytes.get(job.job_id) ?? await this.jobLogSize(job.job_id)));
      this.jobLogBytes.delete(job.job_id);
      this.jobs.delete(job.job_id);
      await rm(this.jobDir(job.job_id), { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    }
    while (this.totalLogBytes > this.maxTotalLogBytes && removable.length > 0) {
      const job = removable.shift() as JobRecord;
      this.totalLogBytes = Math.max(0, this.totalLogBytes - (this.jobLogBytes.get(job.job_id) ?? await this.jobLogSize(job.job_id)));
      this.jobLogBytes.delete(job.job_id);
      this.jobs.delete(job.job_id);
      await rm(this.jobDir(job.job_id), { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    }
  }

  private async reconcileRecoveredJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (job === undefined || job.status !== "unknown" && !(job.status === "cancelling" && job.recovery_liveness !== null)) return;
    const inspection = await inspectProcess(job.pid, job.process_start_fingerprint);
    if (inspection.alive && inspection.fingerprintMatches !== false) return;
    // The inspection yielded to the event loop. Re-read the record before
    // publishing interruption/cancellation so a concurrent cancel or another
    // reconciliation cannot be overwritten by this stale snapshot.
    const current = this.jobs.get(jobId);
    if (current === undefined || current.status !== job.status || current.pid !== job.pid || current.process_start_fingerprint !== job.process_start_fingerprint) return;
    const deliveredCancellation = current.status === "cancelling" && current.cancellation_delivered_at_ms !== null;
    const terminal = terminalRecoveredJob(current, deliveredCancellation ? "cancelled" : "interrupted", {
      checked_at_ms: Date.now(), alive: inspection.alive, fingerprint_matches: inspection.fingerprintMatches,
    });
    this.jobs.set(job.job_id, terminal);
    this.terminationDelivered.delete(job.job_id);
    await this.persist(terminal);
    this.onEvent({ type: "completed", job: terminal });
  }

  /**
   * Wait until metadata writes already queued for the observed jobs are on
   * disk. Terminal state publication is itself behind its metadata durability
   * barrier; callers that advertise a durable sync still close any writes
   * queued for active snapshots before serializing the snapshot.
   */
  public async flushPersistence(): Promise<void> {
    for (;;) {
      const pending = [...this.persistChains.values()];
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  }


  private async cancelRecoveredUnknown(job: JobRecord): Promise<JobRecord> {
    // Capture the current recovery target before the async probe. A concurrent
    // reconciliation/cancel may have replaced this record while the caller's
    // snapshot was in flight; never promote that stale snapshot to cancelling.
    const initial = this.jobs.get(job.job_id);
    if (initial === undefined) return job;
    if (initial.pid !== job.pid || initial.process_start_fingerprint !== job.process_start_fingerprint || !(initial.status === "unknown" || (initial.status === "cancelling" && initial.recovery_liveness !== null))) return initial;
    if (initial.status === "cancelling" && initial.cancellation_delivered_at_ms !== null) return initial;
    const inspection = await inspectProcess(initial.pid, initial.process_start_fingerprint);
    if (!inspection.alive || inspection.fingerprintMatches !== true) {
      // The probe yielded. A concurrent reconciliation/cancellation may have
      // already committed a newer terminal (or cancelling) state; return that
      // state rather than surfacing an error from this stale snapshot.
      const current = this.jobs.get(job.job_id);
      if (current === undefined) return initial;
      if (!isActive(current) || current.pid !== initial.pid || current.process_start_fingerprint !== initial.process_start_fingerprint || current.status !== initial.status || (current.status === "cancelling" && current.cancellation_delivered_at_ms !== null)) return current;
      throw new Error("recovered job cannot be cancelled safely because its process identity is no longer verified");
    }
    const beforePublish = this.jobs.get(job.job_id);
    if (beforePublish === undefined || beforePublish.pid !== initial.pid || beforePublish.process_start_fingerprint !== initial.process_start_fingerprint || !(beforePublish.status === "unknown" || (beforePublish.status === "cancelling" && beforePublish.recovery_liveness !== null))) return beforePublish ?? initial;
    const recovered = { ...beforePublish, status: "cancelling" as const, recovery_liveness: beforePublish.recovery_liveness ?? { checked_at_ms: Date.now(), alive: true, fingerprint_matches: inspection.fingerprintMatches }, recovery_note: "cancellation requested after Runner restart; terminal outcome unavailable until reconciliation", updated_at_ms: Date.now() };
    this.jobs.set(recovered.job_id, recovered);
    await this.persist(recovered);
    const afterPublish = this.jobs.get(recovered.job_id);
    if (afterPublish === undefined) return recovered;
    if (!isActive(afterPublish)) return afterPublish;
    if (afterPublish.status !== "cancelling" || afterPublish.pid !== recovered.pid || afterPublish.process_start_fingerprint !== recovered.process_start_fingerprint) return afterPublish;
    this.onEvent({ type: "status", job: afterPublish });
    // Persistence yields to the event loop; re-check the same fingerprint
    // immediately before signalling so a vanished/reused PID is never killed.
    const current = this.jobs.get(recovered.job_id);
    if (current === undefined || !isActive(current)) return current ?? recovered;
    const latestInspection = await inspectProcess(current.pid, current.process_start_fingerprint);
    if (!latestInspection.alive || latestInspection.fingerprintMatches !== true) {
      const beforeTerminal = this.jobs.get(recovered.job_id);
      if (beforeTerminal === undefined || beforeTerminal.status !== current.status || beforeTerminal.pid !== current.pid || beforeTerminal.process_start_fingerprint !== current.process_start_fingerprint) return beforeTerminal ?? current;
      const terminal = terminalRecoveredJob(beforeTerminal, beforeTerminal.cancellation_delivered_at_ms !== null ? "cancelled" : "interrupted", {
        checked_at_ms: Date.now(), alive: latestInspection.alive, fingerprint_matches: latestInspection.fingerprintMatches,
      });
      this.jobs.set(terminal.job_id, terminal);
      await this.persist(terminal);
      this.onEvent({ type: "completed", job: terminal });
      return terminal;
    }
    // The fingerprint probe above yields to the event loop. Re-check the
    // durable/in-memory record in the same turn immediately before signalling;
    // another reconciliation may have terminalized the recovered job while
    // the probe was in flight.
    const beforeSignal = this.jobs.get(recovered.job_id);
    if (beforeSignal === undefined || !isActive(beforeSignal) || beforeSignal.status !== "cancelling" || beforeSignal.pid !== current.pid) {
      if (beforeSignal !== undefined && !isActive(beforeSignal)) return this.waitForTerminalResult(recovered.job_id, "job is no longer active; cancellation was not sent");
      return beforeSignal ?? recovered;
    }
    // Recovered callers can race with one another after the async identity
    // probe. Share one platform termination decision per job so concurrent
    // requests cannot send duplicate SIGTERM/taskkill commands.
    let termination: Promise<boolean> | undefined;
    try {
      termination = this.terminationAttempts.get(recovered.job_id)
        ?? this.beginTermination(recovered.job_id, beforeSignal.pid, undefined, beforeSignal.process_start_fingerprint);
      if (await termination) {
        const latest = this.jobs.get(recovered.job_id);
        if (latest === undefined) return recovered;
        if (!isActive(latest)) return this.waitForTerminalResult(recovered.job_id, "job is no longer active; cancellation was not sent");
        if (latest.status !== "cancelling" || latest.pid !== beforeSignal.pid || latest.process_start_fingerprint !== beforeSignal.process_start_fingerprint) return latest;
        // Another concurrent caller may have published the marker while this
        // decision was settling. Preserve that record instead of rewriting it
        // (and avoid reporting a second delivery timestamp).
        if (latest.cancellation_delivered_at_ms !== null) return latest;
        const delivered = { ...latest, cancellation_delivered_at_ms: Date.now(), updated_at_ms: Date.now() };
        this.jobs.set(delivered.job_id, delivered);
        this.terminationDelivered.add(delivered.job_id);
        await this.persist(delivered);
        // This runner did not spawn the recovered child and cannot observe close.
        // A later get/list/sync probes it and converges only to cancelled when the
        // persisted delivery marker proves a cancellation request was sent.
        return delivered;
      }
      return recovered;
    } finally {
      if (termination !== undefined && this.terminationAttempts.get(recovered.job_id) === termination) this.terminationAttempts.delete(recovered.job_id);
    }
  }

  private async finish(jobId: string, code: number | null, signal: NodeJS.Signals | null, spawnFailed: boolean): Promise<void> {
    const existing = this.finishing.get(jobId);
    if (existing !== undefined) return existing;
    const task = this.finishOnce(jobId, code, signal, spawnFailed).finally(() => this.finishing.delete(jobId));
    this.finishing.set(jobId, task);
    return task;
  }

  private async finishOnce(jobId: string, code: number | null, signal: NodeJS.Signals | null, spawnFailed: boolean): Promise<void> {
    const pendingTermination = this.terminationAttempts.get(jobId);
    let pendingDelivered = pendingTermination === undefined ? false : await pendingTermination.catch(() => false);
    await this.flushLogs(jobId);
    // A cancellation can register its termination decision while the log
    // durability barrier is in flight. Observe that newer promise as well;
    // otherwise this completion could classify a delivered signal as failed
    // and overwrite its evidence before cancel() resumes.
    const pendingAfterFlush = this.terminationAttempts.get(jobId);
    if (pendingAfterFlush !== undefined && pendingAfterFlush !== pendingTermination) pendingDelivered = (await pendingAfterFlush.catch(() => false)) || pendingDelivered;
    // Cancellation/recovery checks can terminalize the record while log
    // durability is in flight. Re-read after that await so a stale active
    // snapshot can never resurrect an already terminal identity decision.
    const prior = this.jobs.get(jobId);
    if (prior === undefined || !isActive(prior)) return;
    const current = this.jobs.get(jobId) ?? prior;
    const deliveredCancellation = current.status === "cancelling" && (pendingDelivered || this.terminationDelivered.has(jobId) || current.cancellation_delivered_at_ms !== null);
    // A code-zero exit is a successful process completion even if cancel raced
    // with it. Cancellation is reserved for a delivered termination with an
    // abnormal/signal exit, so status does not overstate what happened.
    const status: LocalJobStatus = spawnFailed ? "failed" : code === 0 ? "succeeded" : deliveredCancellation ? "cancelled" : "failed";
    // A pending termination can settle before cancel() gets a chance to write
    // its delivery marker (for example, when the platform emits `close`
    // synchronously from the terminator). Preserve that evidence on the
    // terminal record so a restart cannot reinterpret a delivered request as
    // an ordinary interruption. This also applies when the process exits 0
    // after a delivered cancellation race.
    const cancellationDeliveredAt = current.cancellation_delivered_at_ms ?? (deliveredCancellation ? Date.now() : null);
    const completed: JobRecord = {
      ...current, status, updated_at_ms: Date.now(), completed_at_ms: Date.now(),
      exit_code: status === "cancelled" ? null : code, signal,
      cancellation_delivered_at_ms: cancellationDeliveredAt,
    };
    await this.persist(completed);
    this.jobs.set(jobId, completed);
    this.processes.delete(jobId);
    this.terminationDelivered.delete(jobId);
    this.onEvent({ type: "completed", job: completed });
    await this.pruneRetainedJobs();
  }

  private async flushLogs(jobId: string): Promise<void> {
    await this.logWriteChain.catch(() => undefined);
    await Promise.all((["stdout", "stderr"] as const).map(async (stream) => {
      try {
        const handle = await open(this.logPath(jobId, stream), "r");
        try { await handle.sync(); } finally { await handle.close(); }
      } catch {
        // Child close guarantees descriptor closure. sync is a best-effort
        // durability barrier; inability to sync must not create an unhandled
        // listener rejection or fabricate a different process result.
      }
    }));
  }

  private async closeLogHandles(stdout: Awaited<ReturnType<typeof open>> | undefined, stderr: Awaited<ReturnType<typeof open>> | undefined): Promise<void> {
    await Promise.all([stdout?.close(), stderr?.close()]);
  }

  /** Count local and recovered processes against the configured admission cap. */
  private activeCount(): number { return [...this.jobs.values()].filter(occupiesProcessSlot).length; }
  private beginTermination(jobId: string, pid: number | null, expectedChild: ChildProcess | undefined, expectedFingerprint: string | null): Promise<boolean> {
    const existing = this.terminationAttempts.get(jobId);
    if (existing !== undefined) return existing;
    let resolveDecision!: (value: boolean) => void;
    let rejectDecision!: (reason?: unknown) => void;
    const decision = new Promise<boolean>((resolve, reject) => { resolveDecision = resolve; rejectDecision = reject; });
    this.terminationAttempts.set(jobId, decision);
    // Keep this final check synchronous: no event-loop turn is allowed between
    // observing the ChildProcess and invoking the PID-based terminator.
    const current = this.jobs.get(jobId);
    const child = this.processes.get(jobId);
    const childMatches = expectedChild === undefined
      ? child === undefined
      : child === expectedChild && expectedChild.pid === pid && expectedChild.exitCode === null && expectedChild.signalCode === null;
    if (current === undefined || current.status !== "cancelling" || current.pid !== pid || current.process_start_fingerprint !== expectedFingerprint || !childMatches) {
      resolveDecision(false);
      return decision;
    }
    // Invoke the terminator in this same turn, after the final synchronous
    // identity check. This leaves no extra microtask window in which a close
    // callback could terminalize the job before a PID-based signal is sent;
    // catch synchronous throws so the pending decision cannot remain stuck.
    try {
      const result = this.terminate(pid, expectedFingerprint, expectedChild);
      void Promise.resolve(result).then(resolveDecision, rejectDecision);
    } catch (error) {
      rejectDecision(error);
    }
    return decision;
  }
  private jobDir(jobId: string): string { return join(this.jobsDir, jobId); }
  private logPath(jobId: string, stream: "stdout" | "stderr"): string { return join(this.jobDir(jobId), `${stream}.log`); }

  /** Serialize every job's rename write, avoiding a late running snapshot overwriting terminal metadata. */
  private persist(job: JobRecord): Promise<void> {
    const path = join(this.jobDir(job.job_id), "meta.json");
    const prior = this.persistChains.get(job.job_id) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(async () => {
      const current = this.jobs.get(job.job_id);
      if (isActive(job) && current !== undefined && !isActive(current)) return;
      await atomicJson(path, job);
    });
    this.persistChains.set(job.job_id, next);
    return next.finally(() => {
      if (this.persistChains.get(job.job_id) === next) this.persistChains.delete(job.job_id);
    });
  }
}

function terminalRecoveredJob(job: JobRecord, status: "cancelled" | "interrupted", recovery_liveness: RecoveryLiveness): JobRecord {
  return {
    ...job,
    status,
    updated_at_ms: Date.now(),
    completed_at_ms: Date.now(),
    exit_code: null,
    signal: null,
    recovery_liveness,
    recovery_note: status === "cancelled"
      ? "cancellation delivery was confirmed after Runner restart; the process exit code is unavailable"
      : "terminal outcome unavailable after Runner restart",
    output_truncated: job.output_truncated,
    cancellation_delivered_at_ms: job.cancellation_delivered_at_ms,
    created_by_client_id: job.created_by_client_id,
  };
}

function parseInvocation(params: Record<string, unknown>, workspace: WorkspaceConfig): { file: string; args: string[]; command: string[]; shell: boolean } {
  const requestedShell = params.shell === true;
  if (requestedShell && !workspace.shell) throw new Error("shell execution is disabled for this workspace");
  const shellRuntime = params.shell_runtime;
  if (requestedShell && typeof shellRuntime === "object" && shellRuntime !== null && !Array.isArray(shellRuntime)) {
    const invocation = shellRuntime as { file?: unknown; args?: unknown };
    if (typeof invocation.file !== "string" || !Array.isArray(invocation.args) || invocation.args.some((item) => typeof item !== "string")) throw new Error("shell runtime invocation is invalid");
    if (typeof params.command !== "string" || params.command.length === 0 || params.command.length > 8_192 || params.command.includes("\0")) throw new Error("command is required");
    return { file: invocation.file, args: invocation.args as string[], command: [params.command], shell: false };
  }
  if (Array.isArray(params.command)) {
    if (params.command.length === 0 || params.command.some((item) => typeof item !== "string" || item.length === 0)) throw new Error("command must be a non-empty string array");
    return { file: params.command[0] as string, args: params.command.slice(1) as string[], command: params.command as string[], shell: requestedShell };
  }
  if (typeof params.command !== "string" || params.command.length === 0 || params.command.length > 8_192 || params.command.includes("\0")) throw new Error("command is required");
  const args = params.args === undefined ? [] : stringArray(params.args, "args");
  if (!requestedShell) return { file: params.command, args, command: [params.command, ...args], shell: false };
  return { file: [params.command, ...args].join(" "), args: [], command: [params.command, ...args], shell: true };
}
function paramsObject(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("params must be an object"); return value as Record<string, unknown>; }
function stringArray(value: unknown, label: string): string[] { if (!Array.isArray(value) || value.length > 256 || value.some((item) => typeof item !== "string" || item.includes("\0") || item.length > 8_192)) throw new Error(`${label} must be string array`); return value as string[]; }
function bounded(value: unknown, min: number, max: number, fallback: number): number { if (value === undefined || value === null) return fallback; if (typeof value === "string" && /^\d+$/.test(value)) value = Number(value); if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error("invalid pagination value"); return value as number; }
function positiveInteger(value: unknown, label: string): number { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive integer`); return value as number; }
function boundedPositiveInteger(value: unknown, min: number, max: number, label: string): number { if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${label} must be an integer from ${min} to ${max}`); return value as number; }
function relativeWorkspacePath(workspace: WorkspaceConfig, path: string): string { return path === workspace.rootPath ? "." : path.slice(workspace.rootPath.length + 1); }
function isJobStatus(value: unknown): value is LocalJobStatus { return typeof value === "string" && ["queued", "running", "cancelling", "cancelled", "succeeded", "failed", "unknown", "interrupted"].includes(value); }
function safeOptionalIdentifier(value: unknown): string | null { if (value === undefined) return null; if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error("created_by_client_id is invalid"); return value; }
function isActive(job: JobRecord): boolean { return job.status === "queued" || job.status === "running" || job.status === "cancelling"; }
/** Unknown is a recovered live-process state and must occupy a start slot. */
function occupiesProcessSlot(job: JobRecord): boolean { return isActive(job) || job.status === "unknown"; }
function logResult(jobId: string, stream: "stdout" | "stderr", offset: number, size: number, data: string, next: number): Record<string, unknown> {
  return { job_id: jobId, stream, data, offset, next_cursor: next < size ? String(next) : null, truncated: next < size, size };
}
function wireResponseBytes(result: Record<string, unknown>): number {
  // Include the largest supported request-id and JSON wire envelope so the
  // bounded local result stays under the documented 64 KiB response budget.
  return Buffer.byteLength(JSON.stringify({ type: "rpc.response", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: "x".repeat(128), result }), "utf8");
}
async function atomicJson(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 }); await rename(temporary, path); }
async function readJson<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, "utf8")) as T; }

async function inspectProcess(pid: number | null, expectedFingerprint: string | null): Promise<{ alive: boolean; fingerprintMatches: boolean | null }> {
  if (pid === null || pid <= 0) return { alive: false, fingerprintMatches: null };
  try { process.kill(pid, 0); } catch (error) { return { alive: (error as NodeJS.ErrnoException).code === "EPERM", fingerprintMatches: null }; }
  const fingerprint = await linuxProcessStartFingerprint(pid);
  return { alive: true, fingerprintMatches: expectedFingerprint === null || fingerprint === null ? null : fingerprint === expectedFingerprint };
}

/** Read Linux /proc/<pid>/stat field 22 (starttime); unavailable hosts return null. */
function linuxProcessStartFingerprintSync(pid: number | null): string | null {
  if (process.platform !== "linux" || pid === null || pid <= 0) return null;
  try {
    const value = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = value.lastIndexOf(")");
    if (close < 0) return null;
    const fields = value.slice(close + 2).trim().split(/\s+/);
    const starttime = fields[19]; // stat fields after comm start at field 3; field 22 is index 19.
    return starttime === undefined || !/^\d+$/.test(starttime) ? null : starttime;
  } catch { return null; }
}

async function linuxProcessStartFingerprint(pid: number | null): Promise<string | null> {
  if (process.platform !== "linux" || pid === null || pid <= 0) return null;
  try {
    const value = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = value.lastIndexOf(")");
    if (close < 0) return null;
    const fields = value.slice(close + 2).trim().split(/\s+/);
    const starttime = fields[19]; // stat fields after comm start at field 3; field 22 is index 19.
    return starttime === undefined || !/^\d+$/.test(starttime) ? null : starttime;
  } catch { return null; }
}

async function terminateProcess(pid: number | null, expectedFingerprint: string | null = null, expectedChild?: ChildProcess): Promise<boolean> {
  if (pid === null || pid <= 0) return false;
  // A recovered Windows record has only a bare PID. Without the original
  // ChildProcess handle there is no portable creation-time identity proof, so
  // fail closed instead of taskkilling a potentially reused PID.
  if (process.platform === "win32") {
    if (expectedChild === undefined || !isTerminationTargetValid(pid, expectedFingerprint, expectedChild)) return false;
    return terminateWindowsProcessTree(pid);
  }
  // Re-check the identity inside the native terminator as well as in the
  // JobManager caller. The child can exit between the caller's async probe and
  // this synchronous signal call; fail closed instead of sending to a reused
  // process group.
  if (!isTerminationTargetValid(pid, expectedFingerprint, expectedChild)) return false;
  const target = -pid;
  try { process.kill(target, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  // Return after delivery rather than after the grace period so `close` cannot
  // race past cancellation classification. Before escalating, prove that the
  // original leader still exists. A bare PID is not sufficient after a
  // restart/reuse window: on Linux use /proc starttime, while local ChildProcess
  // handles provide the best available proof on other POSIX hosts. Recovered
  // jobs without either proof deliberately skip SIGKILL rather than risking an
  // unrelated process group.
  void new Promise((resolve) => setTimeout(resolve, 1_000)).then(() => {
    if (!isTerminationTargetValid(pid, expectedFingerprint, expectedChild)) return;
    try { process.kill(target, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }).catch(() => undefined);
  return true;
}

function isTerminationTargetValid(pid: number, expectedFingerprint: string | null, expectedChild?: ChildProcess): boolean {
  if (expectedChild !== undefined && (expectedChild.pid !== pid || expectedChild.exitCode !== null || expectedChild.signalCode !== null)) return false;
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform === "linux") return expectedFingerprint !== null && linuxProcessStartFingerprintSync(pid) === expectedFingerprint;
  // There is no portable process-start fingerprint on these hosts. Recovered
  // jobs have no live handle and therefore cannot be safely escalated.
  return expectedChild !== undefined;
}

/** taskkill /T /F is Windows-specific best effort: protected/orphaned descendants may resist it. */
async function terminateWindowsProcessTree(pid: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") reject(new Error("taskkill is unavailable; Windows process-tree cancellation cannot be performed"));
      else reject(error);
    });
    killer.once("close", (code) => resolve(code === 0));
  });
}

async function utf8AlignedStart(handle: Awaited<ReturnType<typeof open>>, requested: number, size: number, preferBackward: boolean): Promise<number> {
  if (requested === 0 || requested >= size) return requested;
  const begin = Math.max(0, requested - 3);
  const bytes = Buffer.alloc(Math.min(7, size - begin));
  const { bytesRead } = await handle.read(bytes, 0, bytes.length, begin);
  const data = bytes.subarray(0, bytesRead);
  const relative = requested - begin;
  return begin + (preferBackward ? utf8BackwardBoundary(data, relative) : utf8ForwardBoundary(data, relative));
}
function safeJobId(value: string): boolean { return /^job-[0-9a-f-]{36}$/.test(value); }
function normalizeJobRecord(value: unknown): JobRecord | undefined {
  if (!isJobRecord(value)) return undefined;
  const job = value as Omit<JobRecord, "process_start_fingerprint" | "recovery_liveness" | "cancellation_delivered_at_ms" | "created_by_client_id" | "recovery_note" | "output_truncated"> & Partial<Pick<JobRecord, "process_start_fingerprint" | "recovery_liveness" | "cancellation_delivered_at_ms" | "created_by_client_id" | "recovery_note" | "output_truncated">>;
  return {
    ...job,
    process_start_fingerprint: typeof job.process_start_fingerprint === "string" ? job.process_start_fingerprint : null,
    recovery_liveness: validRecoveryLiveness(job.recovery_liveness) ? job.recovery_liveness : null,
    cancellation_delivered_at_ms: typeof job.cancellation_delivered_at_ms === "number" && Number.isSafeInteger(job.cancellation_delivered_at_ms) ? job.cancellation_delivered_at_ms : null,
    created_by_client_id: typeof job.created_by_client_id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(job.created_by_client_id) ? job.created_by_client_id : null,
    recovery_note: typeof job.recovery_note === "string" && job.recovery_note.length <= 512 ? job.recovery_note : null,
    output_truncated: job.output_truncated === true,
  };
}
function validRecoveryLiveness(value: unknown): value is RecoveryLiveness { return typeof value === "object" && value !== null && typeof (value as RecoveryLiveness).checked_at_ms === "number" && typeof (value as RecoveryLiveness).alive === "boolean" && (value as RecoveryLiveness).fingerprint_matches !== undefined; }
function isJobRecord(value: unknown): value is Omit<JobRecord, "process_start_fingerprint" | "recovery_liveness"> { return typeof value === "object" && value !== null && typeof (value as JobRecord).job_id === "string" && typeof (value as JobRecord).status === "string" && typeof (value as JobRecord).workspace_id === "string"; }
