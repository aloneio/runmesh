import { SKILL_STORED_BUNDLE_BYTES, type SkillBundle, type SkillHead, type SkillMutation, type SkillRepository, type SkillSummary } from "../../contracts/skills.js";
import { insertSkillContent, readSkillContent } from "./content.js";
import { initializeSkillSchema } from "./schema.js";
import { initializeSkillVersionMetadata, recordSkillVersionCreated } from "./version-metadata.js";
import { readSkillCapacity } from "./capacity.js";

type Storage = Pick<DurableObjectStorage, "sql" | "transactionSync">;
/** One immutable content authority, isolated from identity/Runner tables. */
export class SkillState implements SkillRepository {
  private ready = false;
  public constructor(private readonly storage: Storage, private readonly initializeOwner: () => void) {}
  private initialize(): void {
    if (this.ready) return;
    this.initializeOwner();
    initializeSkillSchema(this.storage);
    initializeSkillVersionMetadata(this.storage.sql);
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
    return readSkillContent(this.storage.sql, id, digest);
  }
  public summary(id: string, digest: string): Omit<SkillSummary, "revision"> | undefined {
    this.initialize();
    const row = this.storage.sql.exec<{ summary_json: string }>("SELECT summary_json FROM skill_bundles_v2 WHERE skill_id=? AND digest=?", id, digest).toArray()[0];
    if (!row) return undefined;
    if (new TextEncoder().encode(row.summary_json).byteLength > SKILL_STORED_BUNDLE_BYTES) throw new Error("skill_record_invalid");
    return JSON.parse(row.summary_json) as Omit<SkillSummary, "revision">;
  }
  public approved(id: string, digest: string): boolean {
    this.initialize();
    return this.storage.sql.exec<{ approved: number }>("SELECT approved FROM skill_bundles_v2 WHERE skill_id=? AND digest=?", id, digest).toArray()[0]?.approved === 1;
  }
  public install(bundle: SkillBundle, revision: number): SkillMutation { return this.stage(bundle, revision, true); }
  public stage(bundle: SkillBundle, revision: number, install = false): SkillMutation {
    this.initialize();
    return this.storage.transactionSync(() => {
      const current = this.head(bundle.skill_id);
      if ((current?.revision ?? 0) !== revision) return { state: "conflict", current_revision: current?.revision ?? 0 };
      const content = JSON.stringify(bundle), bytes = new TextEncoder().encode(content).byteLength;
      const previous = this.bundle(bundle.skill_id, bundle.digest);
      if (previous && JSON.stringify(previous) !== content) throw new Error("skill_digest_conflict");
      if (!previous) {
        const capacity = readSkillCapacity(this.storage.sql, bundle.skill_id);
        if (capacity.library_bytes + bytes > capacity.max_library_bytes || capacity.skill_versions >= capacity.max_versions
          || (!current && capacity.library_skills >= capacity.max_skills)) return { state: "capacity" };
        insertSkillContent(this.storage.sql, bundle, bytes, install);
        recordSkillVersionCreated(this.storage.sql, bundle.skill_id, bundle.digest, Date.now());
      }
      if (install && previous) this.storage.sql.exec("UPDATE skill_bundles_v2 SET approved=1 WHERE skill_id=? AND digest=? AND approved<>1", bundle.skill_id, bundle.digest);
      const head: SkillHead = { skill_id: bundle.skill_id, revision: revision + 1, staged_digest: bundle.digest, active_digest: install ? bundle.digest : current?.active_digest ?? null, enabled: install || (current?.enabled ?? false) };
      this.storage.sql.exec("INSERT INTO skill_heads_v1 VALUES (?,?,?,?,?) ON CONFLICT(skill_id) DO UPDATE SET revision=excluded.revision,staged_digest=excluded.staged_digest,active_digest=excluded.active_digest,enabled=excluded.enabled", head.skill_id, head.revision, head.staged_digest, head.active_digest, head.enabled ? 1 : 0);
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
      if (digest !== null) this.storage.sql.exec("UPDATE skill_bundles_v2 SET approved=1 WHERE skill_id=? AND digest=? AND approved<>1", id, digest);
      const head = { ...current, revision: revision + 1, active_digest: digest ?? current.active_digest, enabled: digest !== null };
      this.storage.sql.exec("UPDATE skill_heads_v1 SET revision=?,active_digest=?,enabled=? WHERE skill_id=?", head.revision, head.active_digest, head.enabled ? 1 : 0, id);
      return { state: "written", head };
    });
  }
}
