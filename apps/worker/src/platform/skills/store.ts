import { SKILL_LIMITS, type SkillBundle, type SkillHead, type SkillMutation, type SkillRepository, type SkillSummary } from "../../contracts/skills.js";

type Storage = Pick<DurableObjectStorage, "sql" | "transactionSync">;
/** One immutable content authority, isolated from identity/Runner tables. */
export class SkillState implements SkillRepository {
  private ready = false;
  public constructor(private readonly storage: Storage, private readonly initializeOwner: () => void) {}
  private initialize(): void {
    if (this.ready) return;
    this.initializeOwner();
    this.storage.transactionSync(() => {
      const tables = this.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('skill_meta','skill_heads_v1','skill_bundles_v1')").toArray();
      if (tables.length === 0) {
        this.storage.sql.exec("CREATE TABLE skill_meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL)");
        this.storage.sql.exec("INSERT INTO skill_meta VALUES (1,1)");
        this.storage.sql.exec("CREATE TABLE skill_heads_v1 (skill_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, staged_digest TEXT NOT NULL, active_digest TEXT, enabled INTEGER NOT NULL)");
        this.storage.sql.exec("CREATE TABLE skill_bundles_v1 (skill_id TEXT NOT NULL, digest TEXT NOT NULL, summary_json TEXT NOT NULL, content_json TEXT NOT NULL, bytes INTEGER NOT NULL, approved INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(skill_id,digest))");
      } else if (tables.length !== 3 || this.storage.sql.exec<{ schema_version: number }>("SELECT schema_version FROM skill_meta WHERE id=1").toArray()[0]?.schema_version !== 1) throw new Error("skill_schema_unsupported");
    });
    this.ready = true;
  }
  public head(id: string): SkillHead | undefined {
    this.initialize();
    const row = this.storage.sql.exec<Omit<SkillHead, "enabled"> & { enabled: number }>("SELECT * FROM skill_heads_v1 WHERE skill_id=?", id).toArray()[0];
    if (!row) return undefined;
    if (![0, 1].includes(row.enabled) || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error("skill_record_invalid");
    return { ...row, enabled: row.enabled === 1 };
  }
  public heads(after: string, limit: number): readonly SkillHead[] {
    this.initialize();
    return this.storage.sql.exec<{ skill_id: string }>("SELECT skill_id FROM skill_heads_v1 WHERE skill_id>? ORDER BY skill_id LIMIT ?", after, limit).toArray().map(row => this.head(row.skill_id)!);
  }
  public bundle(id: string, digest: string): SkillBundle | undefined {
    this.initialize();
    const row = this.storage.sql.exec<{ content_json: string }>("SELECT content_json FROM skill_bundles_v1 WHERE skill_id=? AND digest=?", id, digest).toArray()[0];
    if (!row) return undefined;
    if (row.content_json.length > SKILL_LIMITS.bundle_bytes + 128) throw new Error("skill_record_invalid");
    return JSON.parse(row.content_json) as SkillBundle;
  }
  public summary(id: string, digest: string): Omit<SkillSummary, "revision"> | undefined {
    this.initialize();
    const row = this.storage.sql.exec<{ summary_json: string }>("SELECT summary_json FROM skill_bundles_v1 WHERE skill_id=? AND digest=?", id, digest).toArray()[0];
    if (!row) return undefined;
    if (row.summary_json.length > 8192) throw new Error("skill_record_invalid");
    return JSON.parse(row.summary_json) as Omit<SkillSummary, "revision">;
  }
  public approved(id: string, digest: string): boolean {
    this.initialize();
    return this.storage.sql.exec<{ approved: number }>("SELECT approved FROM skill_bundles_v1 WHERE skill_id=? AND digest=?", id, digest).toArray()[0]?.approved === 1;
  }
  public stage(bundle: SkillBundle, revision: number): SkillMutation {
    this.initialize();
    return this.storage.transactionSync(() => {
      const current = this.head(bundle.skill_id);
      if ((current?.revision ?? 0) !== revision) return { state: "conflict", current_revision: current?.revision ?? 0 };
      const content = JSON.stringify(bundle), bytes = new TextEncoder().encode(content).byteLength;
      const previous = this.bundle(bundle.skill_id, bundle.digest);
      if (previous && JSON.stringify(previous) !== content) throw new Error("skill_digest_conflict");
      if (!previous) {
        const totals = this.storage.sql.exec<{ bytes: number; versions: number; skills: number }>("SELECT COALESCE(SUM(bytes),0) AS bytes, SUM(CASE WHEN skill_id=? THEN 1 ELSE 0 END) AS versions, COUNT(DISTINCT skill_id) AS skills FROM skill_bundles_v1", bundle.skill_id).toArray()[0]!;
        if (totals.bytes + bytes > SKILL_LIMITS.storage_bytes || totals.versions >= SKILL_LIMITS.versions || (!current && totals.skills >= SKILL_LIMITS.skills)) return { state: "capacity" };
        const { files: _files, schema_version: _schema, ...summary } = bundle;
        this.storage.sql.exec("INSERT INTO skill_bundles_v1 VALUES (?,?,?,?,?,0)", bundle.skill_id, bundle.digest, JSON.stringify(summary), content, bytes);
      }
      const head: SkillHead = { skill_id: bundle.skill_id, revision: revision + 1, staged_digest: bundle.digest, active_digest: current?.active_digest ?? null, enabled: current?.enabled ?? false };
      this.storage.sql.exec("INSERT INTO skill_heads_v1 VALUES (?,?,?,?,?) ON CONFLICT(skill_id) DO UPDATE SET revision=excluded.revision,staged_digest=excluded.staged_digest", head.skill_id, head.revision, head.staged_digest, head.active_digest, head.enabled ? 1 : 0);
      return { state: "written", head };
    });
  }
  public activate(id: string, digest: string, revision: number): SkillMutation { return this.update(id, digest, revision); }
  public disable(id: string, revision: number): SkillMutation { return this.update(id, null, revision); }
  private update(id: string, digest: string | null, revision: number): SkillMutation {
    this.initialize();
    return this.storage.transactionSync(() => {
      const current = this.head(id);
      if (!current) return { state: "missing" };
      if (current.revision !== revision) return { state: "conflict", current_revision: current.revision };
      if (digest !== null && !this.bundle(id, digest)) return { state: "missing" };
      if (digest !== null) this.storage.sql.exec("UPDATE skill_bundles_v1 SET approved=1 WHERE skill_id=? AND digest=?", id, digest);
      const head = { ...current, revision: revision + 1, active_digest: digest ?? current.active_digest, enabled: digest !== null };
      this.storage.sql.exec("UPDATE skill_heads_v1 SET revision=?,active_digest=?,enabled=? WHERE skill_id=?", head.revision, head.active_digest, head.enabled ? 1 : 0, id);
      return { state: "written", head };
    });
  }
}
