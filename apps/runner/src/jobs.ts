import { deliverJobInput } from "./jobs/input.js";
import { availableLogBytes } from "./jobs/log-budget.js";
import { retainedJobCandidates, expiredRetainedJob } from "./jobs/retention-plan.js";
import type { JobFilePort, JobProcessPort } from "./jobs/ports.js";
import { FairJobQueue } from "./job-queue.js";
import { RpcRuntimeError } from "./errors.js";
import { isAbsolute, join, parse, resolve } from "node:path";
import { defaultRunnerStateDir } from "./state-path.js";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { open } from "node:fs/promises";
import type { PathPolicy } from "./path-policy.js";
import type { JobRecord, RecoveryLiveness, LocalJobStatus, JobEvent } from "./jobs/records.js";
export type { JobRecord, RecoveryLiveness, LocalJobStatus, JobEvent } from "./jobs/records.js";
import { isActive, occupiesProcessSlot, sameJobProcessIdentity, safeJobId, normalizeJobRecord, isJobStatus } from "./jobs/records.js";
import { parseInvocation, paramsObject, bounded, positiveInteger, boundedPositiveInteger, relativeWorkspacePath, safeOptionalIdentifier, safeOptionalRequestId, launchRequestFingerprint } from "./jobs/values.js";
import { terminalRecoveredJob } from "./jobs/recovery.js";
import { nativeJobFiles } from "./jobs/storage.js";
import { nativeJobProcesses, type ProcessTerminator } from "./jobs/process.js";
import { JobLogReader } from "./jobs/logs.js";

/** @internal Internal composition seam; no CLI or wire configuration exposes adapters. */
export interface JobManagerDependencies { readonly files?: JobFilePort; readonly processes?: JobProcessPort }

export interface JobManagerOptions {
  readonly policy: PathPolicy;
  readonly stateDir?: string;
  readonly runnerId?: string;
  readonly maxConcurrentJobs?: number;
  readonly maxQueuedJobs?: number;
  readonly maxQueuedJobsPerClient?: number;
  readonly authorizeQueuedJob?: (input: Record<string, unknown>, job: JobRecord) => Promise<boolean>;
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

const MAX_INPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_RETAINED_JOBS = 100;
const DEFAULT_MAX_LOG_BYTES_PER_JOB = 4 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_LOG_BYTES = 32 * 1024 * 1024;
const MAX_RETAINED_JOBS = 10_000;
const MAX_CONFIGURED_LOG_BYTES = 512 * 1024 * 1024;

type TerminationCheck =
  | { readonly safe: true }
  | { readonly safe: false; readonly kind: "terminal" | "identity" | "unverified"; readonly message: string };

/**
 * Local process supervisor and durability coordinator. Child pipe data is
 * drained into bounded local log writes independently of WebSocket requests.
 * State publication, queue admission and cancellation ordering stay here.
 */
export class JobManager {
  private readonly cursorOwner = randomUUID();
  private readonly files: JobFilePort;
  private readonly processAdapter: JobProcessPort;
  private readonly logReader: JobLogReader;
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
  private retentionDays = 0;
  private readonly jobLogBytes = new Map<string, number>();
  private logWriteChain: Promise<void> = Promise.resolve();
  private readonly jobs = new Map<string, JobRecord>();
  private readonly processes = new Map<string, ChildProcess>();
  private readonly persistChains = new Map<string, Promise<void>>();
  /**
   * Terminal metadata is queued before finishOnce publishes the terminal
   * record in memory (the publication is deliberately behind the durability
   * barrier).  Remember that reservation so a late active snapshot from
   * start() cannot enqueue behind the terminal write and resurrect `running`
   * on disk while the in-memory record is still active.
   */
  private readonly terminalPersisting = new Set<string>();
  private readonly finishing = new Map<string, Promise<void>>();
  /** A termination decision is published before signalling a child so a
   * close event cannot classify a cancellation as an ordinary failure. */
  private readonly terminationAttempts = new Map<string, Promise<boolean>>();
  private readonly terminationDelivered = new Set<string>();
  /** Serializes retention pruning so concurrent job completions cannot remove the same record or directory twice. */
  private retentionChain: Promise<void> = Promise.resolve();
  /** Serializes admission through the async pre-spawn window. */
  private startChain: Promise<void> = Promise.resolve();
  private readonly queue: FairJobQueue<{input:Record<string,unknown>;generation:number}>;
  private readonly queuedIds = new Set<string>();
  private queueAuthorizer: JobManagerOptions["authorizeQueuedJob"];
  private draining = false;
  private waitingAdmissions = 0;
  public setQueueAuthorizer(authorize: JobManagerOptions["authorizeQueuedJob"]): void { this.queueAuthorizer = authorize; }
  public queueStatus(): { waiting: number; limit: number; per_client_limit: number; running: number; max_concurrent_jobs: number; available_slots: number } {
    const running = this.activeCount();
    return {
      waiting: this.queue.size,
      limit: this.queue.limit,
      per_client_limit: this.queue.perClient,
      running,
      max_concurrent_jobs: this.maxConcurrentJobs,
      available_slots: Math.max(0, this.maxConcurrentJobs - running),
    };
  }
  /** Process one waiting job per admission turn. A failing authorization must
   * not hold the lock across the whole queue or starve newly arriving clients.
   * No periodic probing: completion, cancellation or inspection wakes dispatch. */
  public resumeQueue(): void {
    if (this.draining || this.queue.size === 0) return;
    this.draining = true;
    void this.reserveStart(async () => {
      if (this.queue.size > 0 && this.activeCount() < this.maxConcurrentJobs) {
        const next = this.queue.shift(); if (next === undefined) return;
        this.queuedIds.delete(next.id);
        const job = this.jobs.get(next.id); if (job?.status !== "queued") return;
        try { await this.startReserved(next.value.input, next.value.generation, job); }
        catch {
          const current=this.jobs.get(next.id);
          if (current?.status === "queued") {
            const failed={...current,status:"failed" as const,updated_at_ms:Date.now(),completed_at_ms:Date.now(),recovery_note:"Queued launch could not be authorized or started; no command was run."};
            this.jobs.set(next.id,failed); await this.persist(failed); this.onEvent({type:"completed",job:failed});
          }
        }
      }
    }).catch(() => undefined).finally(() => { this.draining=false; if(this.queue.size>0 && this.activeCount()<this.maxConcurrentJobs)this.resumeQueue(); });
  }

  public constructor(options: JobManagerOptions);
  /** @internal Trusted internal adapter injection is not part of the package API. */
  public constructor(options: JobManagerOptions, dependencies: JobManagerDependencies);
  public constructor(options: JobManagerOptions, dependencies: JobManagerDependencies = {}) {
    this.files = dependencies.files ?? nativeJobFiles;
    this.processAdapter = dependencies.processes ?? nativeJobProcesses;
    this.policy = options.policy;
    this.queue = new FairJobQueue(options.maxQueuedJobs ?? 32, options.maxQueuedJobsPerClient ?? 8);
    this.queueAuthorizer = options.authorizeQueuedJob;
    this.stateDir = options.stateDir ?? defaultRunnerStateDir();
    if (!isAbsolute(this.stateDir) || this.stateDir.length === 0 || this.stateDir.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(this.stateDir) || resolve(this.stateDir) === parse(resolve(this.stateDir)).root) {
      throw new Error("stateDir must be an absolute non-root path without control characters");
    }
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
      ? this.processAdapter.terminateProcess
      : async (pid, expectedFingerprint) => options.terminateProcess?.(pid, expectedFingerprint) ?? false;
    this.logReader = new JobLogReader(this.files, { cursorOwner: this.cursorOwner, jobsDir: this.jobsDir, runnerId: this.runnerId,
      generation: () => this.policy.generation, assertGeneration: generation => this.policy.assertGeneration(generation),
      logPath: (jobId, stream) => this.logPath(jobId, stream) });
  }

  public async initialize(): Promise<void> {
    // State is a credential/job-output boundary. Walk and inspect each path
    // component before creating children so a pre-existing symlink/junction
    // cannot redirect the supervisor into an attacker-controlled tree.
    await this.files.ensureJobStorageDirectories(this.stateDir, this.jobsDir);
    await this.files.atomicJson(this.runnerStatePath, { runner_id: this.runnerId, workspaces: this.policy.list().map((workspace) => workspace.workspaceId), updated_at_ms: Date.now(), version: 1 });
    const aliveJobIds = new Set<string>();
    for (const entry of await this.files.readdir(this.jobsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !safeJobId(entry.name)) continue;
      const metaPath = join(this.jobsDir, entry.name, "meta.json");
      const parsed = await this.files.readJson<unknown>(metaPath).catch(() => undefined);
      // The directory name is the storage boundary.  Never trust a job_id
      // read from JSON to select another path (or even another retained
      // record) during recovery.
      const job = parsed === undefined ? undefined : normalizeJobRecord(parsed, entry.name);
      if (job === undefined) continue;
      let restored = job;
      // Persisted `unknown` is still a recovered process state. Re-inspect it
      // on every restart; otherwise a second Runner crash would leave the
      // record forever unknown and permanently consume an admission slot.
      if (isActive(job) || job.status === "unknown") {
        // Inspect each recovered process exactly once. A second PID probe can
        // observe a different process and turn a PID-reuse race into a false
        // conclusion during retention pruning.
        const inspection = await this.processAdapter.inspectProcess(job.pid, job.process_start_fingerprint);
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
      }
      this.jobs.set(restored.job_id, restored);
      // Put the recovered snapshot in memory before queueing its write.  The
      // persistence queue uses this identity to suppress an older async write
      // that races a newer terminal/cancellation transition.
      await this.persist(restored);
    }
    this.totalLogBytes = await this.measureLogBytes();
    await this.pruneRetainedJobs(this.maxRetainedJobs, aliveJobIds);
  }

  /** Explicit central opt-in; count/byte caps continue to apply separately. */
  public setRetentionDays(days: number): void {
    if (!Number.isInteger(days) || ![0,1,3,7,14,30,90].includes(days)) throw new Error("invalid Job retention days");
    this.retentionDays = days;
  }
  public async cleanupExpired(): Promise<void> { if (this.retentionDays > 0) await this.pruneRetainedJobs(); }
  public async snapshotForSync(limit = 500): Promise<JobRecord[]> {
    await this.reconcileRecoveredJobs();
    return [...this.jobs.values()].filter(job => job.record_history !== false)
      .sort((a,b) => b.updated_at_ms-a.updated_at_ms || b.job_id.localeCompare(a.job_id)).slice(0,Math.min(500,Math.max(1,limit)));
  }

  public list(input: { readonly workspace_id?: unknown; readonly status?: unknown; readonly limit?: unknown } = {}): JobRecord[] {
    return this.filteredList(input);
  }

  /** Reconcile recovered PIDs before returning metadata to remote callers. */
  public async listReconciled(input: { readonly workspace_id?: unknown; readonly status?: unknown; readonly limit?: unknown } = {}): Promise<JobRecord[]> {
    await this.reconcileRecoveredJobs();
    this.resumeQueue();
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

  public hasPendingHistoryRecovery(): boolean {
    return [...this.jobs.values()].some(job => job.record_history !== false
      && (job.status === "unknown" || (job.status === "cancelling" && job.recovery_liveness !== null)));
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
    if (this.waitingAdmissions >= 64) throw new RpcRuntimeError("busy", "Command admission is full; retry with the same request_id");
    const generation = this.policy.generation;
    this.waitingAdmissions++;
    try { return await this.reserveStart(() => this.startReserved(input, generation)); }
    finally { this.waitingAdmissions--; this.resumeQueue(); }
  }

  private async reserveStart<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.startChain;
    let release!: () => void;
    this.startChain = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await operation(); } finally { release(); }
  }

  private async startReserved(input: unknown, generation: number, reservedJob?: JobRecord): Promise<JobRecord> {
    this.policy.assertGeneration(generation);
    const params = paramsObject(input);
    const workspace = this.policy.getWorkspace(params.workspace_id);
    const cwd = await this.policy.resolve(workspace.workspaceId, params.cwd ?? ".", "cwd");
    this.policy.assertGeneration(generation);
    const invocation = parseInvocation(params, workspace);
    const createdByClientId = safeOptionalIdentifier(params.created_by_client_id);
    if (params.record_history !== undefined && typeof params.record_history !== "boolean") throw new RpcRuntimeError("invalid_params", "record_history must be a boolean");
    const requestId = safeOptionalRequestId(params.request_id);
    const requestFingerprint = requestId === null ? null : launchRequestFingerprint(workspace.workspaceId, relativeWorkspacePath(workspace, cwd.path), invocation, createdByClientId);
    if (reservedJob === undefined && requestId !== null) {
      const existing = [...this.jobs.values()].find((job) => job.workspace_id === workspace.workspaceId && job.created_by_client_id === createdByClientId && job.request_id === requestId);
      if (existing !== undefined) {
        if (existing.request_fingerprint !== requestFingerprint) throw new RpcRuntimeError("request_id_conflict", "request_id is already bound to a different launch request");
        return existing;
      }
    }
    // A recovered live process has no ChildProcess handle in this Runner, so
    // reconciliation is the only way to release its admission slot after it
    // exits. Perform it before pruning/counting; otherwise an `unknown` record
    // could be deleted or ignored and a replacement process admitted beside
    // the still-running recovered job.
    await this.reconcileRecoveredJobs();
    const mustQueue = reservedJob === undefined && (this.activeCount() >= this.maxConcurrentJobs || this.queue.size > 0);
    const client = createdByClientId ?? "local";
    if (reservedJob === undefined) {
      await this.pruneRetainedJobs(this.maxRetainedJobs - 1);
      if (this.jobs.size >= this.maxRetainedJobs) throw new RpcRuntimeError("busy", `max retained jobs (${this.maxRetainedJobs}) reached while active and queued jobs are retained`);
    }
    if (mustQueue && (params.queue === false || this.queueAuthorizer === undefined || this.queue.limit === 0)) throw new RpcRuntimeError("busy", `max concurrent jobs (${this.maxConcurrentJobs}) reached; queued admission is unavailable`);
    if (mustQueue && (this.queue.size >= this.queue.limit || this.queue.count(client) >= this.queue.perClient)) throw new RpcRuntimeError("queue_full", "Waiting queue or per-client queue limit reached");
    const now = Date.now();
    const job: JobRecord = reservedJob ?? {
      job_id: `job-${randomUUID()}`, workspace_id: workspace.workspaceId, cwd: relativeWorkspacePath(workspace, cwd.path),
      command: invocation.command, shell: invocation.shell, status: "queued", pid: null,
      process_start_fingerprint: null, recovery_liveness: null,
      created_at_ms: now, started_at_ms: null, updated_at_ms: now, completed_at_ms: null, exit_code: null, signal: null,
      recovery_note: null, output_truncated: false, created_by_client_id: createdByClientId, request_id: requestId, request_fingerprint: requestFingerprint, cancellation_delivered_at_ms: null,
      ...(params.record_history === undefined ? {} : { record_history: params.record_history as boolean }),
    };
    if (reservedJob === undefined) {
    this.jobs.set(job.job_id, job);
    try {
      await this.files.ensureDirectoryPath(this.jobDir(job.job_id), "Runner job directory", true);
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
        await this.files.rm(this.jobDir(job.job_id), { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }

    }
    if (mustQueue) {
      const current=this.jobs.get(job.job_id);
      if(current?.status !== "queued")return current ?? job;
      this.queue.push(client, job.job_id, {input:params,generation}); this.queuedIds.add(job.job_id);
      this.onEvent({type:"status",job});
      return job;
    }
    this.queue.served(client);
    let stdout: Awaited<ReturnType<typeof open>> | undefined;
    let stderr: Awaited<ReturnType<typeof open>> | undefined;
    let child: ChildProcess;
    let running: JobRecord;
    try {
      stdout = await this.files.openJobLog(this.logPath(job.job_id, "stdout"), "append");
      stderr = await this.files.openJobLog(this.logPath(job.job_id, "stderr"), "append");
      // A remote cancel can terminalize the queued record while the log
      // descriptors are opening. Do not resurrect that record by spawning
      // after cancellation; the synchronous status check closes the only
      // remaining window before spawn.
      if (reservedJob !== undefined && (this.queueAuthorizer === undefined || !await this.queueAuthorizer(params, job))) throw new RpcRuntimeError("permission_denied", "Queued launch authorization was denied or unavailable");
      const beforeSpawn = this.jobs.get(job.job_id);
      if (beforeSpawn === undefined || beforeSpawn.status !== "queued") {
        await this.closeLogHandlesSafely(stdout, stderr);
        return beforeSpawn ?? job;
      }
      this.policy.assertGeneration(generation);
      child = this.processAdapter.spawn(invocation.file, invocation.args, {
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
      const processFingerprint = this.processAdapter.fingerprintSync(child.pid ?? null);
      // Publish the active record and attach all listeners in the same
      // synchronous turn as spawn. A child can exit before the next await;
      // finish must then observe an active job rather than the queued record.
      running = {
        ...job, status: "running", pid: child.pid ?? null, process_start_fingerprint: processFingerprint, started_at_ms: Date.now(), updated_at_ms: Date.now(),
        // A fresh dequeue check may restrict capture, never retroactively
        // enable a Job that was admitted without cloud recording.
        ...(params.record_history === false ? { record_history: false } : {}),
      };
      this.jobs.set(job.job_id, running);
      this.processes.set(job.job_id, child);
      child.once("error", () => { void this.finish(job.job_id, null, null, true).catch(() => undefined); });
      child.once("close", (code, signal) => { void this.finish(job.job_id, code, signal, false).catch(() => undefined); });
      this.attachLogCapture(job.job_id, child);
    } catch (error) {
      await this.closeLogHandlesSafely(stdout, stderr);
      // Cancellation may have won while open/spawn was in flight. Re-read
      // after closing descriptors and preserve that terminal decision instead
      // of resurrecting it as a stale spawn failure.
      const current = this.jobs.get(job.job_id);
      if (current !== undefined && current.status !== "queued") return current;
      const failed = { ...job, status: "failed" as const, updated_at_ms: Date.now(), completed_at_ms: Date.now() };
      await this.persist(failed);
      // A queued cancellation can publish its terminal record while the
      // failed metadata write is awaiting the per-job persistence chain. Do
      // not overwrite that newer identity decision when the write resumes.
      const afterFailedPersist = this.jobs.get(job.job_id);
      if (afterFailedPersist !== job) return afterFailedPersist ?? failed;
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
    await this.closeLogHandlesSafely(stdout, stderr);
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
      this.queue.remove(job.job_id); this.queuedIds.delete(job.job_id);
      const cancelled = { ...job, status: "cancelled" as const, updated_at_ms: Date.now(), completed_at_ms: Date.now() };
      this.jobs.set(job.job_id, cancelled);
      await this.persist(cancelled);
      this.onEvent({ type: "completed", job: cancelled });
      this.resumeQueue();
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
        if (after.kind === "unverified") throw new Error(after.message);
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
          if (verification.kind === "unverified") throw new Error(verification.message);
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
      return { safe: false, kind: "unverified", message: "job process identity could not be verified; cancellation was not sent" };
    }
    if (expectedChild.exitCode !== null || expectedChild.signalCode !== null) return { safe: false, kind: "terminal", message: "job process has already exited; cancellation was not sent" };
    const inspection = await this.processAdapter.inspectProcess(job.pid, job.process_start_fingerprint);
    if (!inspection.alive) return { safe: false, kind: "terminal", message: "job process has already exited; cancellation was not sent" };
    // Linux exposes a process starttime, so cancellation is fail-closed when
    // either the recorded marker or the verification read is unavailable. A
    // PID alone is not proof of identity after a fast exit/reuse.
    if (process.platform === "linux" && (job.process_start_fingerprint === null || inspection.fingerprintMatches !== true)) {
      // Unavailable /proc metadata is not evidence that the original process
      // exited. Keep its handle and admission slot unless reuse is proven.
      const kind = job.process_start_fingerprint !== null && inspection.fingerprintMatches === false ? "identity" : "unverified";
      return { safe: false, kind, message: "job process identity could not be verified; cancellation was not sent" };
    }
    // The fingerprint probe yields to the event loop; verify the in-memory
    // record and ChildProcess again before the signal call.
    const latest = this.jobs.get(job.job_id);
    const latestChild = this.processes.get(job.job_id);
    if (latest === undefined || !isActive(latest) || latest.pid !== job.pid) return { safe: false, kind: "terminal", message: "job is no longer active; cancellation was not sent" };
    if (expectedChild.exitCode !== null || expectedChild.signalCode !== null) return { safe: false, kind: "terminal", message: "job process has already exited; cancellation was not sent" };
    if (latestChild !== expectedChild) return { safe: false, kind: "unverified", message: "job process identity could not be verified; cancellation was not sent" };
    return { safe: true };
  }

  private async waitForTerminalResult(jobId: string, message: string): Promise<JobRecord> {
    await this.waitForTerminal(jobId);
    const current = this.jobs.get(jobId);
    if (current !== undefined && !isActive(current)) return current;
    throw new Error(message);
  }

  /** Only a proven PID/fingerprint mismatch establishes local identity loss. */
  private async markUnsafeLocalCancellation(job: JobRecord, message: string): Promise<JobRecord> {
    const current = this.jobs.get(job.job_id);
    if (current === undefined) throw new Error("job not found");
    if (!isActive(current)) return current;
    const terminal = { ...terminalRecoveredJob(current, "interrupted", { checked_at_ms: Date.now(), alive: true, fingerprint_matches: false }), recovery_note: message.slice(0, 512) };
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
    await deliverJobInput(stdin, data, closeStdin);
    return { accepted, eof: closeStdin };
  }

  public async logs(jobId: unknown, input: unknown = {}): Promise<Record<string, unknown>> {
    return this.logReader.read(this.get(jobId), input);
  }

  private reserveLogBytes(jobId: string, chunk: Buffer): { readonly data: Buffer; readonly truncated: boolean } {
    if (chunk.byteLength === 0) return { data: chunk, truncated: false };
    const jobBytes = this.jobLogBytes.get(jobId) ?? 0;
    const available = availableLogBytes(jobBytes, this.totalLogBytes, this.maxLogBytesPerJob, this.maxTotalLogBytes);
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
    // This path is intentionally fire-and-forget (it runs from a stream data
    // callback).  Persisting the metadata can fail, and leaving that promise
    // unobserved would surface as an unhandled rejection in the runner
    // process.  Log retention is best-effort, so consume the failure here.
    if (reserved.truncated) void this.markOutputTruncated(jobId).catch(() => undefined);
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
      try { await this.files.appendJobLog(this.logPath(jobId, stream), reserved.data); }
      catch {
        this.releaseLogBytes(jobId, reserved.data.byteLength);
        // The write chain is also detached from the stream callback.  A
        // metadata persistence failure must not turn the chain into an
        // unhandled rejected promise (or block subsequent log writes).
        await this.markOutputTruncated(jobId).catch(() => undefined);
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
    const sizes = await Promise.all((["stdout", "stderr"] as const).map(async (stream) => await this.files.safeFileSize(this.logPath(jobId, stream))));
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
    const removable = retainedJobCandidates(this.jobs.values(), aliveJobIds);
    if (this.retentionDays > 0) {
      const cutoff = Date.now() - this.retentionDays * 86_400_000;
      for (const job of removable) {
        if (expiredRetainedJob(job, cutoff)) await this.removeRetainedJobIfCurrent(job);
      }
    }
    while (this.jobs.size > retainedLimit && removable.length > 0) {
      const job = removable.shift() as JobRecord;
      await this.removeRetainedJobIfCurrent(job);
    }
    while (this.totalLogBytes > this.maxTotalLogBytes && removable.length > 0) {
      const job = removable.shift() as JobRecord;
      await this.removeRetainedJobIfCurrent(job);
    }
  }

  /**
   * Remove one retained record only if the exact terminal snapshot selected by
   * the pruning pass is still current.  The size lookup and recursive rm both
   * yield; a completion/cancellation persistence callback can therefore
   * replace the map entry while this method is suspended.  Re-check at every
   * await boundary so a stale pruning list cannot delete an active record (or
   * a directory whose metadata is still being durably written).
   */
  private async removeRetainedJobIfCurrent(job: JobRecord): Promise<boolean> {
    const canRemove = (): boolean => {
      const current = this.jobs.get(job.job_id);
      return current === job
        && !occupiesProcessSlot(current)
        && !this.finishing.has(job.job_id)
        && !this.persistChains.has(job.job_id);
    };
    if (!canRemove()) return false;
    const size = this.jobLogBytes.get(job.job_id) ?? await this.jobLogSize(job.job_id);
    // jobLogSize() is asynchronous; do not trust the pre-await identity check.
    if (!canRemove()) return false;
    await this.files.rm(this.jobDir(job.job_id), { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    // A state transition is not expected for terminal records, but it can
    // occur in injected/recovery paths while this.files.rm() is in flight. Never delete a
    // newer map entry or subtract its accounting in that case.
    if (!canRemove()) return false;
    this.totalLogBytes = Math.max(0, this.totalLogBytes - size);
    this.jobLogBytes.delete(job.job_id);
    this.jobs.delete(job.job_id);
    return true;
  }

  private async reconcileRecoveredJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (job === undefined || job.status !== "unknown" && !(job.status === "cancelling" && job.recovery_liveness !== null)) return;
    const inspection = await this.processAdapter.inspectProcess(job.pid, job.process_start_fingerprint);
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
    const inspection = await this.processAdapter.inspectProcess(initial.pid, initial.process_start_fingerprint);
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
    // Another caller can finish delivery while the identity probe is pending.
    // Its durable marker is an idempotency barrier, not permission to send a
    // second signal after the shared in-flight termination promise is gone.
    if (beforePublish.status === "cancelling" && beforePublish.cancellation_delivered_at_ms !== null) return beforePublish;
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
    const latestInspection = await this.processAdapter.inspectProcess(current.pid, current.process_start_fingerprint);
    if (!latestInspection.alive || latestInspection.fingerprintMatches !== true) {
      const beforeTerminal = this.jobs.get(recovered.job_id);
      if (beforeTerminal === undefined || beforeTerminal.status !== current.status || beforeTerminal.pid !== current.pid || beforeTerminal.process_start_fingerprint !== current.process_start_fingerprint) return beforeTerminal ?? current;
      if (latestInspection.alive && latestInspection.fingerprintMatches === null) {
        // A transient identity-read failure neither proves death nor delivers
        // cancellation. Preserve recovery evidence and the concurrency slot.
        const unverified: JobRecord = { ...beforeTerminal,
          status: beforeTerminal.cancellation_delivered_at_ms === null ? "unknown" : "cancelling",
          updated_at_ms: Date.now(),
          recovery_liveness: { checked_at_ms: Date.now(), alive: true, fingerprint_matches: null },
          recovery_note: "Process identity could not be verified; cancellation was not sent and the process remains retained.",
        };
        this.jobs.set(unverified.job_id, unverified);
        await this.persist(unverified);
        if (this.jobs.get(unverified.job_id) === unverified) this.onEvent({ type: "status", job: unverified });
        throw new Error("recovered job cannot be cancelled safely because its process identity is no longer verified");
      }
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
    // The final probe also yields. A completed concurrent delivery no longer
    // has an in-flight promise to share, so recheck its persisted marker here.
    if (beforeSignal.cancellation_delivered_at_ms !== null) return beforeSignal;
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
    const task = this.finishOnce(jobId, code, signal, spawnFailed).finally(() => { this.finishing.delete(jobId); this.resumeQueue(); });
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
    let completed: JobRecord = {
      ...current, status, updated_at_ms: Date.now(), completed_at_ms: Date.now(),
      exit_code: status === "cancelled" ? null : code, signal,
      cancellation_delivered_at_ms: cancellationDeliveredAt,
    };
    // Keep the in-memory record active until the terminal metadata is durable,
    // but reserve the terminal write first.  `start()` may still be finishing
    // its post-spawn running write; persist() uses this reservation to discard
    // that stale active snapshot rather than letting it run after the terminal
    // callback and overwrite the durable outcome.
    this.terminalPersisting.add(jobId);
    try {
      await this.persist(completed);
      // The terminal write yields to the filesystem and persistence queue. A
      // recovery/cancellation callback can publish a newer terminal identity
      // during that window. Do not overwrite it (or emit a duplicate
      // completion event) when this stale finish task resumes. The map check
      // is intentionally after the durability barrier: before it, `prior` is
      // still the active record whose terminal write is authorized above.
      const afterPersist = this.jobs.get(jobId);
      if (afterPersist === undefined) {
        this.processes.delete(jobId);
        this.terminationDelivered.delete(jobId);
        return;
      }
      if (afterPersist !== prior) {
        // A newer active snapshot may have been published while the terminal
        // write was in flight (for example output_truncated, or a concurrent
        // cancellation). Never blindly replace it with the stale completed
        // object. A running snapshot can be safely merged only when it still
        // names the same child identity; preserve every newer field and
        // recompute the terminal cancellation evidence from that snapshot.
        if (!isActive(afterPersist) || !sameJobProcessIdentity(afterPersist, prior)) {
          // A different active identity may now own this job key. Its
          // ChildProcess/termination marker belongs to that newer process;
          // never clean those maps from this stale completion callback. A
          // terminal replacement has no newer process, so retire the old
          // handle in that case.
          if (!isActive(afterPersist)) {
            this.processes.delete(jobId);
            this.terminationDelivered.delete(jobId);
          }
          return;
        }
        // A cancellation that has not yet produced delivery evidence owns the
        // state transition. Let its process/close path finish the job instead
        // of converting a newer cancelling snapshot into a stale success or
        // failure. This is deliberately conservative even for an exit code of
        // zero: the cancellation caller may still be persisting its decision.
        const latestAttempt = this.terminationAttempts.get(jobId);
        if (latestAttempt !== undefined) pendingDelivered = (await latestAttempt.catch(() => false)) || pendingDelivered;
        const cancellationPending = afterPersist.status === "cancelling"
          && !pendingDelivered
          && !this.terminationDelivered.has(jobId)
          && afterPersist.cancellation_delivered_at_ms === null;
        if (cancellationPending) {
          // The first terminal write was authorized against `prior`, but the
          // cancellation snapshot now owns this identity.  Keep the active
          // state on disk as well as in memory before returning; otherwise a
          // synthetic/late cancellation could leave a durable `succeeded`
          // record with no completion event for the still-cancelling job.
          // Drop the terminal reservation for this one current snapshot so
          // persist() does not intentionally suppress it as stale.
          this.terminalPersisting.delete(jobId);
          await this.persist(afterPersist);
          return;
        }
        const mergedDelivered = afterPersist.status === "cancelling"
          && (pendingDelivered || this.terminationDelivered.has(jobId) || afterPersist.cancellation_delivered_at_ms !== null);
        const mergedStatus: LocalJobStatus = spawnFailed ? "failed" : code === 0 ? "succeeded" : mergedDelivered ? "cancelled" : "failed";
        const mergedCancellationDeliveredAt = afterPersist.cancellation_delivered_at_ms ?? (mergedDelivered ? Date.now() : null);
        completed = {
          ...afterPersist,
          status: mergedStatus,
          updated_at_ms: Date.now(),
          completed_at_ms: Date.now(),
          exit_code: mergedStatus === "cancelled" ? null : code,
          signal,
          cancellation_delivered_at_ms: mergedCancellationDeliveredAt,
        };
        // Persist the merged terminal snapshot as the first write intentionally
        // used the older active identity. terminalPersisting permits this
        // pre-publication terminal write, while the identity check below
        // prevents a second active update from being overwritten.
        await this.persist(completed);
        const afterMergedPersist = this.jobs.get(jobId);
        if (afterMergedPersist !== afterPersist) {
          // Preserve a different active identity's process handle. Retire
          // only when the map is absent/terminal or still names this child.
          if (afterMergedPersist === undefined || !isActive(afterMergedPersist) || sameJobProcessIdentity(afterMergedPersist, afterPersist)) {
            this.processes.delete(jobId);
            this.terminationDelivered.delete(jobId);
          }
          return;
        }
      }
      this.jobs.set(jobId, completed);
      this.processes.delete(jobId);
      this.terminationDelivered.delete(jobId);
      this.onEvent({ type: "completed", job: completed });
      await this.pruneRetainedJobs();
    } finally {
      this.terminalPersisting.delete(jobId);
    }
  }

  private async flushLogs(jobId: string): Promise<void> {
    await this.logWriteChain.catch(() => undefined);
    await Promise.all((["stdout", "stderr"] as const).map(async (stream) => {
      try {
        const handle = await this.files.openJobLog(this.logPath(jobId, stream), "read");
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
  private async closeLogHandlesSafely(stdout: Awaited<ReturnType<typeof open>> | undefined, stderr: Awaited<ReturnType<typeof open>> | undefined): Promise<void> {
    try {
      await this.closeLogHandles(stdout, stderr);
    } catch {
      // A close implementation can fail after closing only one descriptor
      // (and tests/operators may inject such a failure). Retry both handles
      // directly so an error path never leaks file descriptors into a long-
      // lived Runner process.
      await Promise.allSettled([stdout?.close(), stderr?.close()]);
    }
  }

  /** Count local and recovered processes against the configured admission cap. */
  private activeCount(): number { return [...this.jobs.values()].filter(job => !this.queuedIds.has(job.job_id) && occupiesProcessSlot(job)).length; }
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
      // `start()` can be closing descriptors while the child's `close`
      // callback finalizes the same job. Do not let a stale running snapshot
      // enqueue after a terminal write and resurrect it on disk. Normal
      // callers publish the exact object before enqueueing; the two terminal
      // durability paths intentionally enqueue before publication, while the
      // record is still active, so permit only that narrowly-scoped case.
      const current = this.jobs.get(job.job_id);
      // A terminal write may be waiting on an older active snapshot while
      // start() queues its own running snapshot.  The terminal reservation is
      // the ordering signal: active writes that arrive after it are stale and
      // must not be allowed to execute after the terminal metadata.
      if (this.terminalPersisting.has(job.job_id) && isActive(job)) return;
      const prePublishTerminal = !isActive(job) && current !== undefined && isActive(current);
      if (current !== job && !prePublishTerminal) return;
      await this.files.atomicJson(path, job);
    });
    this.persistChains.set(job.job_id, next);
    return next.finally(() => {
      if (this.persistChains.get(job.job_id) === next) this.persistChains.delete(job.job_id);
    });
  }
}
