import { JobMetadataSchema, type JobMetadata } from "@aloneio/runmesh-protocol";
import type { JobHistorySettings } from "./job-history-settings.js";

const MAX_JOBS = 500, MAX_BYTES = 768 * 1024, DAY = 86_400_000;
const statusRank = (s: string): number => s === "queued" ? 0 : s === "running" ? 1 : s === "cancelling" ? 2 : 3;
const terminal = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
export class JobHistoryUnavailableError extends Error {
  public constructor() { super("Job history is unavailable; use workspace-bound live queries."); }
}
type SnapshotRow = { jobs_json: string; updated_at_ms: number; revision: number; retention_days: number };
const SELECT = "SELECT jobs_json,updated_at_ms,revision,retention_days FROM runmesh_job_snapshots_v1 WHERE namespace=? AND runner_id=? AND lifecycle_id=?";

/** One bounded JSON row holds many metadata records, not one SQL row per Job.
 * No command/output, credential authority, or fallback writes into core DO.
 */
export class PackedJobHistory {
  private ready: Promise<void> | undefined;
  private disabledUntil = 0;
  public constructor(private readonly db: D1Database, private readonly namespace: string) {}
  private async initialize(): Promise<void> {
    if (Date.now() < this.disabledUntil) throw new JobHistoryUnavailableError();
    this.ready ??= (async () => {
      const exists = await this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runmesh_job_snapshots_v1'").first();
      if (exists === null) await this.db.batch([
        this.db.prepare("CREATE TABLE IF NOT EXISTS runmesh_job_snapshots_v1 (snapshot_id INTEGER PRIMARY KEY, namespace TEXT NOT NULL, runner_id TEXT NOT NULL, lifecycle_id TEXT NOT NULL, jobs_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL, revision INTEGER NOT NULL, retention_days INTEGER NOT NULL, UNIQUE(namespace,runner_id,lifecycle_id))"),
        this.db.prepare("CREATE INDEX IF NOT EXISTS runmesh_job_scan_v1 ON runmesh_job_snapshots_v1(namespace,snapshot_id)"),
      ]);
      const cursorTable = await this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runmesh_job_cleanup_v1'").first();
      if (cursorTable === null) await this.db.prepare("CREATE TABLE IF NOT EXISTS runmesh_job_cleanup_v1 (namespace TEXT PRIMARY KEY, cursor INTEGER NOT NULL)").run();
    })();
    await this.ready;
  }
  private openCircuit(error: unknown): void {
    const now = Date.now();
    const message = error instanceof Error ? error.message : "";
    const dailyQuota = /(?:rows[_ ]?(?:read|written)|daily)/i.test(message) && /(?:exceed|quota|limit)/i.test(message);
    const retryAt = dailyQuota ? (Math.floor(now / DAY) + 1) * DAY + 30_000 : now + 900_000;
    this.ready = undefined;
    this.disabledUntil = Math.max(this.disabledUntil, retryAt);
  }
  private failed(error: unknown): never {
    this.openCircuit(error);
    throw new JobHistoryUnavailableError();
  }
  private decode(row: SnapshotRow | null, days: number, now: number): JobMetadata[] {
    if (row === null) return [];
    if (new TextEncoder().encode(row.jobs_json).byteLength > MAX_BYTES) throw new JobHistoryUnavailableError();
    const values: unknown = JSON.parse(row.jobs_json);
    if (!Array.isArray(values) || values.length > MAX_JOBS) throw new JobHistoryUnavailableError();
    return values.map((v) => JobMetadataSchema.parse(v)).filter((job) => !terminal.has(job.status) || job.updated_at_ms > now - days * DAY);
  }
  public async merge(runnerId: string, lifecycle: string, incoming: readonly JobMetadata[], settings: JobHistorySettings, now = Date.now()): Promise<{ recorded: boolean; updated_at_ms: number | null; deferred?: boolean }> {
    if (settings.mode === "off") return { recorded: false, updated_at_ms: null };
    if (Date.now() < this.disabledUntil) throw new JobHistoryUnavailableError();
    try {
      await this.initialize();
      for (let attempt = 0; attempt < 3; attempt++) {
        const old = await this.db.prepare(SELECT).bind(this.namespace,runnerId,lifecycle).first<SnapshotRow>();
        // This durable guard also bounds legacy peers that upload a complete
        // snapshot after every event; it survives isolate reconstruction.
        if (settings.mode === "batched" && old !== null && old.updated_at_ms > now - settings.interval_seconds * 1000) return { recorded: false, updated_at_ms: old.updated_at_ms, deferred:true };
        if (old === null && incoming.length === 0) return { recorded:false,updated_at_ms:null };
        const map = new Map(this.decode(old, settings.retention_days, now).map((job) => [job.job_id, job]));
        for (const value of incoming) {
          const job = JobMetadataSchema.parse(value);
          if (job.runner_id !== undefined && job.runner_id !== runnerId) throw new JobHistoryUnavailableError();
          if (terminal.has(job.status) && job.updated_at_ms <= now - settings.retention_days * DAY) continue;
          const prior = map.get(job.job_id);
          if (prior !== undefined && prior.workspace_id !== job.workspace_id) throw new JobHistoryUnavailableError();
          if (prior !== undefined && (prior.updated_at_ms > job.updated_at_ms || statusRank(prior.status) > statusRank(job.status) || (terminal.has(prior.status) && prior.status !== job.status))) continue;
          map.set(job.job_id, { ...job, runner_id: runnerId });
        }
        const jobs = [...map.values()].sort((a,b) => b.updated_at_ms-a.updated_at_ms || b.job_id.localeCompare(a.job_id)).slice(0,MAX_JOBS);
        const body = JSON.stringify(jobs);
        if (new TextEncoder().encode(body).byteLength > MAX_BYTES) throw new JobHistoryUnavailableError();
        if (old?.jobs_json === body && old.retention_days === settings.retention_days) return { recorded: false, updated_at_ms: old.updated_at_ms };
        const result = old === null
          ? await this.db.prepare("INSERT INTO runmesh_job_snapshots_v1 (namespace,runner_id,lifecycle_id,jobs_json,updated_at_ms,revision,retention_days) VALUES (?,?,?,?,?,1,?) ON CONFLICT(namespace,runner_id,lifecycle_id) DO NOTHING").bind(this.namespace,runnerId,lifecycle,body,now,settings.retention_days).run()
          : await this.db.prepare("UPDATE runmesh_job_snapshots_v1 SET jobs_json=?,updated_at_ms=?,revision=revision+1,retention_days=? WHERE namespace=? AND runner_id=? AND lifecycle_id=? AND revision=?").bind(body,now,settings.retention_days,this.namespace,runnerId,lifecycle,old.revision).run();
        if (result.meta.changes > 0) return { recorded: true, updated_at_ms: now };
      }
      throw new JobHistoryUnavailableError();
    } catch (error) { return this.failed(error); }
  }
  public async list(runnerId: string, lifecycle: string, settings: JobHistorySettings, filters: {limit?: number; workspace_id?: string; status?: string; before_ms?: number} = {}): Promise<{ jobs: JobMetadata[]; updated_at_ms: number | null; retained_limit: number }> {
    if (Date.now() < this.disabledUntil) throw new JobHistoryUnavailableError();
    try {
      await this.initialize();
      const row = await this.db.prepare(SELECT).bind(this.namespace,runnerId,lifecycle).first<SnapshotRow>();
      const jobs = this.decode(row, settings.retention_days, Date.now()).filter((job) => (filters.workspace_id === undefined || job.workspace_id === filters.workspace_id) && (filters.status === undefined || job.status === filters.status) && (filters.before_ms === undefined || job.updated_at_ms < filters.before_ms));
      jobs.sort((a,b) => b.updated_at_ms-a.updated_at_ms || b.job_id.localeCompare(a.job_id));
      return { jobs: jobs.slice(0,Math.min(100,Math.max(1,filters.limit ?? 10))), updated_at_ms: row?.updated_at_ms ?? null, retained_limit: MAX_JOBS };
    } catch (error) { return this.failed(error); }
  }
  public async get(runnerId: string, lifecycle: string, jobId: string, settings: JobHistorySettings): Promise<JobMetadata | undefined> {
    if (Date.now() < this.disabledUntil) throw new JobHistoryUnavailableError();
    try {
      await this.initialize();
      const row = await this.db.prepare(SELECT).bind(this.namespace,runnerId,lifecycle).first<SnapshotRow>();
      return this.decode(row,settings.retention_days,Date.now()).find((job) => job.job_id === jobId);
    } catch (error) { return this.failed(error); }
  }
  public async setRetention(runnerId: string, lifecycle: string, days: number): Promise<void> {
    if (![1, 3, 7, 14, 30, 90].includes(days)) throw new JobHistoryUnavailableError();
    if (Date.now() < this.disabledUntil) throw new JobHistoryUnavailableError();
    try {
      await this.initialize();
      await this.db.prepare("UPDATE runmesh_job_snapshots_v1 SET retention_days=?,revision=revision+1 WHERE namespace=? AND runner_id=? AND lifecycle_id=? AND retention_days<>?").bind(days,this.namespace,runnerId,lifecycle,days).run();
    } catch (error) { return this.failed(error); }
  }
  /** Cursor-based sweep: at most 20 packed rows per cron, never a full table
   * scan. CAS prevents cleanup from overwriting a concurrent fresh upload.
   */
  public async cleanup(): Promise<void> {
    if (Date.now() < this.disabledUntil) return;
    try {
      await this.initialize();
      const state = await this.db.prepare("SELECT cursor FROM runmesh_job_cleanup_v1 WHERE namespace=?").bind(this.namespace).first<{cursor:number}>();
      const rows = await this.db.prepare("SELECT snapshot_id AS id, jobs_json,updated_at_ms,revision,retention_days FROM runmesh_job_snapshots_v1 WHERE namespace=? AND snapshot_id>? ORDER BY snapshot_id LIMIT 20").bind(this.namespace,state?.cursor ?? 0).all<SnapshotRow & {id:number}>();
      for (const row of rows.results) {
        const body = JSON.stringify(this.decode(row,row.retention_days,Date.now()));
        if (body !== row.jobs_json) await this.db.prepare("UPDATE runmesh_job_snapshots_v1 SET jobs_json=?,revision=revision+1 WHERE snapshot_id=? AND namespace=? AND revision=?").bind(body,row.id,this.namespace,row.revision).run();
      }
      const next = rows.results.length < 20 ? 0 : rows.results.at(-1)?.id ?? 0;
      await this.db.prepare("INSERT INTO runmesh_job_cleanup_v1 VALUES (?,?) ON CONFLICT(namespace) DO UPDATE SET cursor=excluded.cursor WHERE cursor<>excluded.cursor").bind(this.namespace,next).run();
    } catch (error) { this.openCircuit(error); }
  }

}
