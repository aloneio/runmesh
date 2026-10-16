import { HISTORY_DAYS, JobMetadataSchema, type JobHistorySettings, type JobMetadata } from "@aloneio/runmesh-protocol";
import { HISTORY_LIFECYCLE_BATCH_SIZE, type HistoryLifecycleReader } from "./contracts/history-lifecycle.js";
import { decodeHistorySnapshot, HistorySnapshotCorruptError, HistoryInputError, HistoryConflictError, JobHistoryUnavailableError,
  HISTORY_MAX_JOBS as MAX_JOBS, HISTORY_MAX_BYTES as MAX_BYTES, HISTORY_DAY_MS as DAY, HISTORY_QUARANTINE_MAX_DAYS } from "./contracts/history-snapshot.js";
import { ensureJobHistorySchema } from "./platform/job-history-schema.js";
export { JobHistoryUnavailableError } from "./contracts/history-snapshot.js";

const statusRank = (s: string): number => s === "queued" ? 0 : s === "running" ? 1 : s === "cancelling" ? 2 : 3;
const terminal = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
type SnapshotRow = { jobs_json: string; updated_at_ms: number; revision: number; retention_days: number; retired_at_ms: number | null; corrupt_revision: number | null; corrupt_detected_at_ms: number | null; corrupt_reason: string | null };
const SELECT = "SELECT jobs_json,updated_at_ms,revision,retention_days,retired_at_ms,corrupt_revision,corrupt_detected_at_ms,corrupt_reason FROM runmesh_job_snapshots_v1 WHERE namespace=? AND runner_id=? AND lifecycle_id=?";

/** One bounded JSON row holds many metadata records, not one SQL row per Job.
 * No command/output, credential authority, or fallback writes into core DO.
 */
export class PackedJobHistory {
  private ready: Promise<void> | undefined;
  private disabledUntil = 0;
  private readonly writes = new Map<string, Promise<unknown>>();
  public constructor(private readonly db: D1Database, private readonly namespace: string) {}
  /** Registry is the sole policy writer. Order each lifecycle's pending D1
   * writes so a no-op settings acknowledgement cannot precede an older write.
   * The independent cleanup worker still uses snapshot revision CAS. */
  private write<T>(runnerId: string, lifecycle: string, operation: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([runnerId, lifecycle]), previous = this.writes.get(key);
    const result = previous === undefined ? Promise.resolve().then(operation) : previous.then(operation, operation);
    this.writes.set(key, result);
    const complete = () => { if (this.writes.get(key) === result) this.writes.delete(key); };
    void result.then(complete, complete);
    return result;
  }
  private async initialize(): Promise<void> {
    if (Date.now() < this.disabledUntil) throw new JobHistoryUnavailableError();
    this.ready ??= this.query(() => ensureJobHistorySchema(this.db));
    await this.ready;
  }
  /** Only an actual D1 operation can trip the dependency circuit. Parsing,
   * input rejection and optimistic conflicts never disable other Runners. */
  private async query<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) { this.openCircuit(error); throw new JobHistoryUnavailableError(); }
  }
  private first<T>(sql: string, ...values: unknown[]): Promise<T | null> {
    return this.query(() => this.db.prepare(sql).bind(...values).first<T>());
  }
  private run(sql: string, ...values: unknown[]): Promise<D1Result> {
    return this.query(() => this.db.prepare(sql).bind(...values).run());
  }
  private all<T>(sql: string, ...values: unknown[]): Promise<D1Result<T>> {
    return this.query(() => this.db.prepare(sql).bind(...values).all<T>());
  }
  private openCircuit(error: unknown): void {
    const now = Date.now();
    const message = error instanceof Error ? error.message : "";
    const dailyQuota = /(?:rows[_ ]?(?:read|written)|daily)/i.test(message) && /(?:exceed|quota|limit)/i.test(message);
    const retryAt = dailyQuota ? (Math.floor(now / DAY) + 1) * DAY + 30_000 : now + 900_000;
    this.ready = undefined;
    this.disabledUntil = Math.max(this.disabledUntil, retryAt);
  }
  private decode(row: SnapshotRow | null, days: number, now: number, runnerId?: string): JobMetadata[] {
    if (row === null) return [];
    if (row.jobs_json === "" && row.corrupt_reason === "expired") throw new HistorySnapshotCorruptError("expired");
    return decodeHistorySnapshot(row.jobs_json, runnerId).filter(job => !terminal.has(job.status) || job.updated_at_ms > now - days * DAY);
  }
  public merge(runnerId: string, lifecycle: string, incoming: readonly JobMetadata[], currentSettings: () => JobHistorySettings | undefined, recordableNewJobIds: (jobs: readonly JobMetadata[]) => ReadonlySet<string>, now = Date.now()): Promise<{ recorded: boolean; updated_at_ms: number | null; deferred?: boolean }> {
    return this.write(runnerId, lifecycle, () => this.mergeCurrent(runnerId, lifecycle, incoming, currentSettings, recordableNewJobIds, now));
  }
  private async mergeCurrent(runnerId: string, lifecycle: string, incoming: readonly JobMetadata[], currentSettings: () => JobHistorySettings | undefined, recordableNewJobIds: (jobs: readonly JobMetadata[]) => ReadonlySet<string>, now: number): Promise<{ recorded: boolean; updated_at_ms: number | null; deferred?: boolean }> {
    const initial = currentSettings();
    if (initial === undefined || initial.mode === "off") return { recorded: false, updated_at_ms: null };
    if (Date.now() < this.disabledUntil) throw new JobHistoryUnavailableError();
    await this.initialize();
    for (let attempt = 0; attempt < 3; attempt++) {
      const old = await this.first<SnapshotRow>(SELECT,this.namespace,runnerId,lifecycle);
      // Registry owns these settings. Re-read after I/O and on every CAS
      // retry so an older upload cannot restore an earlier retention choice.
      const settings = currentSettings();
      if (settings === undefined || settings.mode === "off" || old?.retired_at_ms != null) return { recorded: false, updated_at_ms: old?.updated_at_ms ?? null };
      // This durable guard also bounds legacy peers that upload a complete
      // snapshot after every event; it survives isolate reconstruction.
      if (settings.mode === "batched" && old !== null && old.updated_at_ms > now - settings.interval_seconds * 1000) return { recorded: false, updated_at_ms: old.updated_at_ms, deferred:true };
      if (old === null && incoming.length === 0) return { recorded:false,updated_at_ms:null };
      const map = new Map(this.decode(old, settings.retention_days, now, runnerId).map((job) => [job.job_id, job]));
      // Registry refreshes each client's capture decision once per batch,
      // after this read and on every CAS retry; no per-Job D1 lookup is needed.
      const recordable = recordableNewJobIds(incoming);
      for (const value of incoming) {
        const parsed = JobMetadataSchema.safeParse(value);
        if (!parsed.success) throw new HistoryInputError();
        const job = parsed.data;
        if (job.runner_id !== undefined && job.runner_id !== runnerId) throw new HistoryInputError();
        if (terminal.has(job.status) && job.updated_at_ms <= now - settings.retention_days * DAY) continue;
        const prior = map.get(job.job_id);
        // Capture preferences govern first admission. Already archived Jobs
        // must still reach their terminal state after a client opts out.
        if (prior === undefined && !recordable.has(job.job_id)) continue;
        if (prior !== undefined && prior.workspace_id !== job.workspace_id) throw new HistoryInputError();
        // Failed cancellation can resume running; recovered unknown work can
        // enter cancellation. Require a newer observation for either reversal
        // so delayed/equal-ms snapshots retain the existing rank fence.
        if (prior !== undefined && (prior.updated_at_ms > job.updated_at_ms
          || (statusRank(prior.status) > statusRank(job.status) && !(job.updated_at_ms > prior.updated_at_ms
            && ((prior.status === "cancelling" && job.status === "running") || (prior.status === "unknown" && job.status === "cancelling"))))
          || (terminal.has(prior.status) && prior.status !== job.status))) continue;
        map.set(job.job_id, { ...job, runner_id: runnerId });
      }
      const jobs = [...map.values()].sort((a,b) => b.updated_at_ms-a.updated_at_ms || b.job_id.localeCompare(a.job_id)).slice(0,MAX_JOBS);
      if (old === null && jobs.length === 0) return { recorded: false, updated_at_ms: null };
      const body = JSON.stringify(jobs);
      if (new TextEncoder().encode(body).byteLength > MAX_BYTES) throw new HistoryInputError();
      if (old?.jobs_json === body && old.retention_days === settings.retention_days && old.corrupt_reason === null && old.corrupt_revision === null && old.corrupt_detected_at_ms === null) return { recorded: false, updated_at_ms: old.updated_at_ms };
      const result = old === null
        ? await this.run("INSERT INTO runmesh_job_snapshots_v1 (namespace,runner_id,lifecycle_id,jobs_json,updated_at_ms,revision,retention_days) VALUES (?,?,?,?,?,1,?) ON CONFLICT(namespace,runner_id,lifecycle_id) DO NOTHING",this.namespace,runnerId,lifecycle,body,now,settings.retention_days)
        : await this.run("UPDATE runmesh_job_snapshots_v1 SET jobs_json=?,updated_at_ms=?,revision=revision+1,retention_days=?,corrupt_revision=NULL,corrupt_detected_at_ms=NULL,corrupt_reason=NULL WHERE namespace=? AND runner_id=? AND lifecycle_id=? AND revision=? AND retired_at_ms IS NULL",body,now,settings.retention_days,this.namespace,runnerId,lifecycle,old.revision);
      if (result.meta.changes > 0) return { recorded: true, updated_at_ms: now };
    }
    throw new HistoryConflictError();
  }
  public async list(runnerId: string, lifecycle: string, settings: JobHistorySettings, filters: {limit?: number; workspace_id?: string; status?: string; before_ms?: number} = {}): Promise<{ jobs: JobMetadata[]; updated_at_ms: number | null; retained_limit: number }> {
    if (Date.now() < this.disabledUntil) throw new JobHistoryUnavailableError();
    await this.initialize();
    const row = await this.first<SnapshotRow>(SELECT,this.namespace,runnerId,lifecycle);
    const jobs = this.decode(row, settings.retention_days, Date.now(), runnerId).filter((job) => (filters.workspace_id === undefined || job.workspace_id === filters.workspace_id) && (filters.status === undefined || job.status === filters.status) && (filters.before_ms === undefined || job.updated_at_ms < filters.before_ms));
    jobs.sort((a,b) => b.updated_at_ms-a.updated_at_ms || b.job_id.localeCompare(a.job_id));
    return { jobs: jobs.slice(0,Math.min(100,Math.max(1,filters.limit ?? 10))), updated_at_ms: row?.updated_at_ms ?? null, retained_limit: MAX_JOBS };
  }
  public async get(runnerId: string, lifecycle: string, jobId: string, settings: JobHistorySettings): Promise<JobMetadata | undefined> {
    if (Date.now() < this.disabledUntil) throw new JobHistoryUnavailableError();
    await this.initialize();
    const row = await this.first<SnapshotRow>(SELECT,this.namespace,runnerId,lifecycle);
    return this.decode(row,settings.retention_days,Date.now(),runnerId).find((job) => job.job_id === jobId);
  }
  public setRetention(runnerId: string, lifecycle: string, currentSettings: () => JobHistorySettings | undefined): Promise<void> {
    return this.write(runnerId, lifecycle, () => this.setCurrentRetention(runnerId, lifecycle, currentSettings));
  }
  private async setCurrentRetention(runnerId: string, lifecycle: string, currentSettings: () => JobHistorySettings | undefined): Promise<void> {
    if (currentSettings() === undefined) return;
    if (Date.now() < this.disabledUntil) throw new JobHistoryUnavailableError();
    await this.initialize();
    for (let attempt = 0; attempt < 3; attempt++) {
      const old = await this.first<SnapshotRow>(SELECT,this.namespace,runnerId,lifecycle);
      const settings = currentSettings();
      if (settings === undefined || old?.retired_at_ms != null) return;
      const days = settings.retention_days;
      if (!HISTORY_DAYS.some((allowed) => allowed === days)) throw new HistoryInputError();
      if (old?.retention_days === days) return;
      // The first settings write also fences an in-flight first upload.
      // Zero keeps this empty row from delaying the first batched snapshot.
      const result = old === null
        ? await this.run("INSERT INTO runmesh_job_snapshots_v1 (namespace,runner_id,lifecycle_id,jobs_json,updated_at_ms,revision,retention_days) VALUES (?,?,?,'[]',0,1,?) ON CONFLICT(namespace,runner_id,lifecycle_id) DO NOTHING",this.namespace,runnerId,lifecycle,days)
        : await this.run("UPDATE runmesh_job_snapshots_v1 SET retention_days=?,revision=revision+1 WHERE namespace=? AND runner_id=? AND lifecycle_id=? AND revision=? AND retired_at_ms IS NULL",days,this.namespace,runnerId,lifecycle,old.revision);
      if (result.meta.changes > 0) return;
    }
    throw new HistoryConflictError();
  }
  /** Record damage in place, once per observed revision. No second copy of the
   * body exists. After the bounded diagnostic window, retain only an explicit
   * unavailable tombstone until repair or authoritative lifecycle retirement. */
  private async quarantine(row: SnapshotRow & { id: number }, reason: HistorySnapshotCorruptError["reason"], now: number, retire: boolean): Promise<boolean> {
    const firstSeen = row.corrupt_detected_at_ms !== null && Number.isSafeInteger(row.corrupt_detected_at_ms)
      && row.corrupt_detected_at_ms >= 0 && row.corrupt_detected_at_ms <= now ? row.corrupt_detected_at_ms : now;
    const days = HISTORY_DAYS.some(days => days === row.retention_days) ? Math.min(row.retention_days, HISTORY_QUARANTINE_MAX_DAYS) : HISTORY_QUARANTINE_MAX_DAYS;
    const expired = reason === "expired" || now - firstSeen >= days * DAY;
    const nextReason = expired ? "expired" : reason;
    const retirement = retire ? now : row.retired_at_ms;
    if (row.corrupt_revision === row.revision && row.corrupt_reason === nextReason
      && row.corrupt_detected_at_ms === firstSeen && row.retired_at_ms === retirement && (!expired || row.jobs_json === "")) return true;
    const result = await this.run(`UPDATE runmesh_job_snapshots_v1 SET ${expired ? "jobs_json=''," : ""}corrupt_revision=revision+1,corrupt_detected_at_ms=?,corrupt_reason=?,retired_at_ms=?,revision=revision+1 WHERE snapshot_id=? AND namespace=? AND revision=?`,
      firstSeen,nextReason,retirement,row.id,this.namespace,row.revision);
    if (result.meta.changes > 0) console.warn(JSON.stringify({ event: "job_history_snapshot_quarantined", snapshot_id: row.id, reason: nextReason }));
    return result.meta.changes > 0;
  }

  /** At most 20 packed rows per sweep. Snapshot CAS protects concurrent data;
   * cursor generation CAS prevents overlapping sweeps from rewinding progress.
   * The receipt distinguishes scanned/quarantined/deferred from clean success. */
  public async cleanup(readLifecycles?: HistoryLifecycleReader): Promise<{ state: "complete" | "deferred" | "unavailable"; scanned: number; quarantined: number; conflicts: number; cursor_advanced: boolean }> {
    const receipt = { state: "complete" as "complete" | "deferred" | "unavailable", scanned: 0, quarantined: 0, conflicts: 0, cursor_advanced: false };
    if (Date.now() < this.disabledUntil) return { ...receipt, state: "unavailable" };
    try {
      await this.initialize();
      const state = await this.first<{ cursor: number; generation: number }>("SELECT cursor,generation FROM runmesh_job_cleanup_v2 WHERE namespace=?",this.namespace);
      const rows = await this.all<SnapshotRow & { id: number; runner_id: string; lifecycle_id: string }>("SELECT snapshot_id AS id,runner_id,lifecycle_id,jobs_json,updated_at_ms,revision,retention_days,retired_at_ms,corrupt_revision,corrupt_detected_at_ms,corrupt_reason FROM runmesh_job_snapshots_v1 WHERE namespace=? AND snapshot_id>? ORDER BY snapshot_id LIMIT ?",this.namespace,state?.cursor ?? 0,HISTORY_LIFECYCLE_BATCH_SIZE);
      const runnerIds = [...new Set(rows.results.filter(row => row.retired_at_ms === null).map(row => row.runner_id))];
      // An absent or incomplete authority snapshot is never evidence of deletion.
      let lifecycles = runnerIds.length && readLifecycles !== undefined ? await readLifecycles(runnerIds).catch(() => undefined) : undefined;
      if (lifecycles !== undefined && (lifecycles.size !== runnerIds.length || runnerIds.some(id => !lifecycles!.has(id)))) lifecycles = undefined;
      for (const row of rows.results) {
        receipt.scanned++;
        const now = Date.now();
        const metadataValid = HISTORY_DAYS.some(days => days === row.retention_days)
          && (row.retired_at_ms === null || (Number.isSafeInteger(row.retired_at_ms) && row.retired_at_ms >= 0));
        if (metadataValid && row.retired_at_ms !== null && row.retired_at_ms <= now - row.retention_days * DAY) {
          const result = await this.run("DELETE FROM runmesh_job_snapshots_v1 WHERE snapshot_id=? AND namespace=? AND revision=? AND retired_at_ms=?",row.id,this.namespace,row.revision,row.retired_at_ms);
          if (result.meta.changes === 0) receipt.conflicts++;
          continue;
        }
        const retire = row.retired_at_ms === null && lifecycles?.has(row.runner_id) === true && lifecycles.get(row.runner_id) !== row.lifecycle_id;
        let body: string;
        try {
          if (!metadataValid) throw new HistorySnapshotCorruptError("invalid_metadata");
          body = JSON.stringify(this.decode(row,row.retention_days,now,row.runner_id));
        } catch (error) {
          if (!(error instanceof HistorySnapshotCorruptError)) throw error;
          if (await this.quarantine(row,error.reason,now,retire)) receipt.quarantined++;
          else receipt.conflicts++;
          continue;
        }
        let result: D1Result | undefined;
        if (retire) {
          result = await this.run("UPDATE runmesh_job_snapshots_v1 SET jobs_json=?,retired_at_ms=?,revision=revision+1,corrupt_revision=NULL,corrupt_detected_at_ms=NULL,corrupt_reason=NULL WHERE snapshot_id=? AND namespace=? AND revision=? AND retired_at_ms IS NULL",body,now,row.id,this.namespace,row.revision);
        } else if (body !== row.jobs_json || row.corrupt_reason !== null || row.corrupt_revision !== null || row.corrupt_detected_at_ms !== null) {
          result = await this.run("UPDATE runmesh_job_snapshots_v1 SET jobs_json=?,revision=revision+1,corrupt_revision=NULL,corrupt_detected_at_ms=NULL,corrupt_reason=NULL WHERE snapshot_id=? AND namespace=? AND revision=?",body,row.id,this.namespace,row.revision);
        }
        if (result?.meta.changes === 0) receipt.conflicts++;
      }
      const next = rows.results.length < HISTORY_LIFECYCLE_BATCH_SIZE ? 0 : rows.results.at(-1)?.id ?? 0;
      // No progress change needs no SQL write attempt or extra index read.
      const saved = state?.cursor === next ? undefined : await this.run("INSERT INTO runmesh_job_cleanup_v2 (namespace,cursor,generation) VALUES (?,?,1) ON CONFLICT(namespace) DO UPDATE SET cursor=excluded.cursor,generation=generation+1 WHERE generation=? AND cursor<>excluded.cursor",this.namespace,next,state?.generation ?? 0);
      receipt.cursor_advanced = saved !== undefined && saved.meta.changes > 0;
      if (receipt.conflicts > 0 || saved?.meta.changes === 0) receipt.state = "deferred";
      return receipt;
    } catch {
      // query() already accounts for dependency failure; unknown local failures
      // do not open a shared circuit or publish payloads in diagnostics.
      console.warn("job_history_cleanup_incomplete");
      return { ...receipt, state: "unavailable" };
    }
  }
}
