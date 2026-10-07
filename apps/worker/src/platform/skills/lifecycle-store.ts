import { SKILL_LIMITS, SKILL_STORED_BUNDLE_BYTES, type SkillHead, type SkillRepository } from "../../contracts/skills.js";
import type { SkillCleanupPlan, SkillCleanupPreview, SkillCleanupResult, SkillLifecycleRepository, SkillRetentionResult, SkillVersion, SkillVersionHistory } from "../../contracts/skill-lifecycle.js";
import { skillDigest } from "../../contracts/skill-values.js";
import { initializeSkillSchema } from "./schema.js";
import { initializeSkillVersionMetadata } from "./version-metadata.js";
import { readSkillCapacity } from "./capacity.js";
import { deleteSkillContent } from "./content.js";

type Storage = Pick<DurableObjectStorage, "sql" | "transactionSync">;
const invalid = () => new Error("skill_lifecycle_record_invalid");

/** Maintenance shares content SQL and head revisions. There is at most one
 * expiring cleanup preview per Skill; no timer or background cleanup is used. */
export class SkillLifecycleState implements SkillLifecycleRepository {
  private ready = false;
  public constructor(private readonly storage: Storage, private readonly initializeOwner: () => void,
    private readonly content: Pick<SkillRepository, "head" | "bundle">) {}
  private initialize(): void {
    if (this.ready) return;
    this.initializeOwner();
    initializeSkillSchema(this.storage);
    initializeSkillVersionMetadata(this.storage.sql);
    if (this.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='skill_cleanup_plans_v1'").toArray().length === 0)
      this.storage.sql.exec("CREATE TABLE skill_cleanup_plans_v1 (skill_id TEXT PRIMARY KEY, session_hash TEXT NOT NULL, plan_json TEXT NOT NULL)");
    this.ready = true;
  }
  public history(id: string): SkillVersionHistory | undefined {
    this.initialize();
    const head = this.content.head(id); if (!head) return undefined;
    const rows = this.storage.sql.exec<{ digest: string; bytes: number; file_count: number; summary_json: string; created_at_ms: number | null; pinned: number }>(
      "SELECT b.digest,b.bytes,b.file_count,b.summary_json,m.created_at_ms,COALESCE(m.pinned,0) AS pinned FROM skill_bundles_v2 b LEFT JOIN skill_version_metadata_v1 m ON m.skill_id=b.skill_id AND m.digest=b.digest WHERE b.skill_id=? ORDER BY b.digest LIMIT ?", id, SKILL_LIMITS.versions + 1).toArray();
    if (rows.length === 0 || rows.length > SKILL_LIMITS.versions) throw invalid();
    const versions: SkillVersion[] = rows.map(row => {
      if (!skillDigest(row.digest) || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > SKILL_STORED_BUNDLE_BYTES
        || !Number.isSafeInteger(row.file_count) || row.file_count < 1 || row.file_count > SKILL_LIMITS.files
        || ![0, 1].includes(row.pinned) || (row.created_at_ms !== null && (!Number.isSafeInteger(row.created_at_ms) || row.created_at_ms < 0))
        || new TextEncoder().encode(row.summary_json).byteLength > SKILL_STORED_BUNDLE_BYTES) throw invalid();
      const summary = JSON.parse(row.summary_json) as Record<string, unknown>;
      if (!summary || summary.skill_id !== id || summary.digest !== row.digest || typeof summary.name !== "string" || summary.name.length > 64
        || typeof summary.description !== "string" || summary.description.length > 1024 || typeof summary.source !== "string" || summary.source.length > 2048
        || typeof summary.license !== "string" || summary.license.length > 256) throw invalid();
      return { digest: row.digest, bytes: row.bytes, file_count: row.file_count, created_at_ms: row.created_at_ms,
        pinned: row.pinned === 1, active: head.active_digest === row.digest, staged: head.staged_digest === row.digest,
        summary: { name: summary.name, description: summary.description, source: summary.source, license: summary.license } };
    });
    if (!versions.some(version => version.staged) || (head.active_digest !== null && !versions.some(version => version.active))) throw invalid();
    return { state: "listed", head, versions, capacity: readSkillCapacity(this.storage.sql, id) };
  }
  public bundle(id: string, digest: string) { this.initialize(); return this.content.bundle(id, digest); }
  public retain(id: string, digest: string, pinned: boolean, revision: number): SkillRetentionResult {
    this.initialize();
    return this.storage.transactionSync(() => {
      const history = this.history(id); if (!history) return { state: "missing" };
      if (history.head.revision !== revision) return { state: "conflict", current_revision: history.head.revision };
      if (!history.versions.some(version => version.digest === digest)) return { state: "missing" };
      this.storage.sql.exec("INSERT INTO skill_version_metadata_v1 (skill_id,digest,created_at_ms,pinned) VALUES (?,?,NULL,?) ON CONFLICT(skill_id,digest) DO UPDATE SET pinned=excluded.pinned WHERE pinned<>excluded.pinned", id, digest, pinned ? 1 : 0);
      const head = this.advance(history.head);
      return { state: "retained", head, digest, pinned };
    });
  }
  private advance(head: SkillHead): SkillHead {
    if (!Number.isSafeInteger(head.revision) || head.revision >= Number.MAX_SAFE_INTEGER) throw invalid();
    const next = { ...head, revision: head.revision + 1 };
    this.storage.sql.exec("UPDATE skill_heads_v1 SET revision=? WHERE skill_id=?", next.revision, head.skill_id);
    return next;
  }
  private selection(history: SkillVersionHistory, plan: SkillCleanupPlan): "ready" | "conflict" | "protected" {
    if (history.head.revision !== plan.revision) return "conflict";
    const selected = history.versions.filter(version => plan.digests.includes(version.digest));
    if (selected.length !== plan.digests.length || selected.reduce((sum, version) => sum + version.bytes, 0) !== plan.bytes) return "conflict";
    return selected.some(version => version.active || version.staged || version.pinned) ? "protected" : "ready";
  }
  public preview(plan: SkillCleanupPlan, sessionHash: string): SkillCleanupPreview {
    this.initialize();
    return this.storage.transactionSync(() => {
      const history = this.history(plan.skill_id); if (!history) return { state: "missing" };
      const selected = this.selection(history, plan); if (selected !== "ready") return { state: selected, current_revision: history.head.revision };
      this.storage.sql.exec("INSERT INTO skill_cleanup_plans_v1 (skill_id,session_hash,plan_json) VALUES (?,?,?) ON CONFLICT(skill_id) DO UPDATE SET session_hash=excluded.session_hash,plan_json=excluded.plan_json", plan.skill_id, sessionHash, JSON.stringify(plan));
      return { state: "previewed", plan };
    });
  }
  public cleanup(id: string, fingerprint: string, revision: number, sessionHash: string, nowMs: number): SkillCleanupResult {
    this.initialize();
    return this.storage.transactionSync(() => {
      const history = this.history(id); if (!history) return { state: "missing" };
      if (history.head.revision !== revision) return { state: "conflict", current_revision: history.head.revision };
      const stored = this.storage.sql.exec<{ session_hash: string; plan_json: string }>("SELECT session_hash,plan_json FROM skill_cleanup_plans_v1 WHERE skill_id=?", id).toArray()[0];
      if (!stored) return { state: "conflict" };
      if (stored.session_hash !== sessionHash) return { state: "denied" };
      if (stored.plan_json.length > 8192) throw invalid();
      const plan = JSON.parse(stored.plan_json) as SkillCleanupPlan;
      if (!plan || plan.skill_id !== id || plan.revision !== revision || plan.fingerprint !== fingerprint || !skillDigest(plan.fingerprint)
        || !Array.isArray(plan.digests) || plan.digests.length < 1 || plan.digests.length > SKILL_LIMITS.versions
        || plan.digests.some((digest, index) => !skillDigest(digest) || (index > 0 && digest <= plan.digests[index - 1]!))
        || !Number.isSafeInteger(plan.bytes) || plan.bytes < 1 || !Number.isSafeInteger(plan.expires_at_ms) || !Number.isSafeInteger(nowMs)) return { state: "conflict" };
      if (plan.expires_at_ms <= nowMs) return { state: "expired" };
      const selected = this.selection(history, plan); if (selected !== "ready") return { state: selected };
      for (const digest of plan.digests) {
        deleteSkillContent(this.storage.sql, id, digest);
        this.storage.sql.exec("DELETE FROM skill_version_metadata_v1 WHERE skill_id=? AND digest=?", id, digest);
      }
      const head = this.advance(history.head);
      this.storage.sql.exec("DELETE FROM skill_cleanup_plans_v1 WHERE skill_id=?", id);
      return { state: "cleaned", skill_id: id, head, deleted_digests: plan.digests, freed_bytes: plan.bytes, capacity: readSkillCapacity(this.storage.sql, id) };
    });
  }
}
