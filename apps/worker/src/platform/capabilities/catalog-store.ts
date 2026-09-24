import { CATALOG_LIMITS, type CatalogHead, type CatalogMutation, type CatalogRepository, type CatalogSnapshot } from "../../contracts/catalog.js";
import { catalogDigest, catalogJson, catalogRevision } from "../../contracts/catalog-json.js";
import { parseCatalogHead, parseCatalogSnapshot, parseToolNames } from "../../contracts/catalog-values.js";
import { isCapabilityIdentifier } from "../../contracts/capabilities.js";
import { newCatalogCursorKey } from "./catalog-crypto.js";

type Storage = Pick<DurableObjectStorage, "sql" | "transactionSync">;

/** Sole owner of immutable catalog bodies and reviewed heads. No credential
 * material, upstream requests, native Jobs or cross-repository SQL. */
export class CatalogState implements CatalogRepository {
  private ready = false;
  public constructor(private readonly storage: Storage, private readonly initializeOwner: () => void) {}

  private initialize(): void {
    if (this.ready) return;
    this.initializeOwner();
    this.storage.transactionSync(() => {
      const tables = this.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('catalog_meta','catalog_heads_v1','catalog_snapshots_v1')").toArray();
      if (tables.length === 0) {
        this.storage.sql.exec("CREATE TABLE catalog_meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, cursor_key TEXT NOT NULL)");
        this.storage.sql.exec("CREATE TABLE catalog_heads_v1 (profile_id TEXT PRIMARY KEY, head_json TEXT NOT NULL)");
        this.storage.sql.exec("CREATE TABLE catalog_snapshots_v1 (profile_id TEXT NOT NULL, digest TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes>0), snapshot_json TEXT NOT NULL, PRIMARY KEY(profile_id,digest))");
        this.storage.sql.exec("INSERT INTO catalog_meta VALUES (1,1,?)", newCatalogCursorKey());
      } else {
        if (tables.length !== 3) throw new Error("catalog_schema_unsupported");
        const row = this.storage.sql.exec<{ schema_version: number; cursor_key: string }>("SELECT schema_version,cursor_key FROM catalog_meta WHERE id=1").toArray();
        if (row.length !== 1 || row[0]?.schema_version !== 1 || !/^[A-Za-z0-9_-]{43}$/u.test(row[0].cursor_key)) throw new Error("catalog_schema_unsupported");
      }
    });
    this.ready = true;
  }

  public cursorKey(): string {
    this.initialize();
    const row = this.storage.sql.exec<{ cursor_key: string }>("SELECT cursor_key FROM catalog_meta WHERE id=1").one();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(row.cursor_key)) throw new Error("catalog_cursor_key_invalid");
    return row.cursor_key;
  }

  public readHead(profileId: string): CatalogHead | undefined {
    if (!isCapabilityIdentifier(profileId)) throw new Error("catalog_input_invalid");
    this.initialize();
    const row = this.storage.sql.exec<{ head_json: string }>("SELECT head_json FROM catalog_heads_v1 WHERE profile_id=?", profileId).toArray()[0];
    if (row === undefined) return undefined;
    if (row.head_json.length > 32_768) throw new Error("catalog_record_invalid");
    let head: CatalogHead | undefined;
    try { head = parseCatalogHead(JSON.parse(row.head_json)); } catch { /* Fixed, non-reflective failure below. */ }
    if (head === undefined || head.profile_id !== profileId) throw new Error("catalog_record_invalid");
    return head;
  }

  public readSnapshot(profileId: string, digest: string): CatalogSnapshot | undefined {
    if (!isCapabilityIdentifier(profileId) || !catalogDigest(digest)) throw new Error("catalog_input_invalid");
    this.initialize();
    const row = this.storage.sql.exec<{ snapshot_json: string; bytes: number }>("SELECT snapshot_json,bytes FROM catalog_snapshots_v1 WHERE profile_id=? AND digest=?", profileId, digest).toArray()[0];
    if (row === undefined) return undefined;
    if (row.snapshot_json.length > CATALOG_LIMITS.snapshot_bytes || new TextEncoder().encode(row.snapshot_json).byteLength !== row.bytes) throw new Error("catalog_record_invalid");
    let snapshot: CatalogSnapshot | undefined;
    try { snapshot = parseCatalogSnapshot(JSON.parse(row.snapshot_json)); } catch { /* Never expose stored text. */ }
    if (snapshot === undefined || snapshot.profile_id !== profileId || snapshot.digest !== digest) throw new Error("catalog_record_invalid");
    return snapshot;
  }

  private writeHead(head: CatalogHead): CatalogMutation {
    if (parseCatalogHead(head) === undefined) return { state: "invalid" };
    this.storage.sql.exec("INSERT INTO catalog_heads_v1 VALUES (?,?) ON CONFLICT(profile_id) DO UPDATE SET head_json=excluded.head_json", head.profile_id, JSON.stringify(head));
    return { state: "written", head };
  }

  public stage(value: CatalogSnapshot, expectedRevision: number): CatalogMutation {
    const snapshot = parseCatalogSnapshot(value);
    if (snapshot === undefined || !catalogRevision(expectedRevision, true) || !catalogRevision(expectedRevision + 1)) return { state: "invalid" };
    const canonical = catalogJson(snapshot, CATALOG_LIMITS.snapshot_bytes)!;
    const bytes = new TextEncoder().encode(canonical).byteLength;
    this.initialize();
    return this.storage.transactionSync(() => {
      const head = this.readHead(snapshot.profile_id), revision = head?.revision ?? 0;
      if (expectedRevision !== revision) return { state: "conflict", current_revision: revision };
      if (head === undefined && this.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM catalog_heads_v1").one().n >= CATALOG_LIMITS.profiles) return { state: "capacity" };
      const previous = this.readSnapshot(snapshot.profile_id, snapshot.digest);
      if (previous !== undefined && catalogJson(previous, CATALOG_LIMITS.snapshot_bytes) !== canonical) throw new Error("catalog_digest_conflict");
      if (previous === undefined) {
        const budget = this.storage.sql.exec<{ n: number; bytes: number }>("SELECT COUNT(*) AS n,COALESCE(SUM(bytes),0) AS bytes FROM catalog_snapshots_v1").one();
        const versions = this.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM catalog_snapshots_v1 WHERE profile_id=?", snapshot.profile_id).one().n;
        if (budget.n >= CATALOG_LIMITS.snapshots || budget.bytes + bytes > CATALOG_LIMITS.storage_bytes || versions >= CATALOG_LIMITS.versions_per_profile) return { state: "capacity" };
        this.storage.sql.exec("INSERT INTO catalog_snapshots_v1 VALUES (?,?,?,?)", snapshot.profile_id, snapshot.digest, bytes, canonical);
      }
      return this.writeHead({ schema_version: 1, profile_id: snapshot.profile_id, revision: revision + 1, observed_digest: snapshot.digest,
        approved_digest: head?.approved_digest ?? null, approved_names: head?.approved_names ?? [] });
    });
  }

  public approve(profileId: string, digest: string, toolNames: readonly string[], expectedRevision: number): CatalogMutation {
    const names = parseToolNames(toolNames);
    if (!isCapabilityIdentifier(profileId) || !catalogDigest(digest) || names === undefined || !catalogRevision(expectedRevision) || !catalogRevision(expectedRevision + 1)) return { state: "invalid" };
    this.initialize();
    return this.storage.transactionSync(() => {
      const head = this.readHead(profileId);
      if (head === undefined) return { state: "missing" };
      if (head.revision !== expectedRevision) return { state: "conflict", current_revision: head.revision };
      const snapshot = this.readSnapshot(profileId, digest);
      if (head.observed_digest !== digest || snapshot === undefined || names.some(name => !snapshot.tools.some(tool => tool.definition.name === name))) return { state: "invalid" };
      return this.writeHead({ ...head, revision: expectedRevision + 1, approved_digest: digest, approved_names: names });
    });
  }

  public disable(profileId: string, expectedRevision: number): CatalogMutation {
    if (!isCapabilityIdentifier(profileId) || !catalogRevision(expectedRevision) || !catalogRevision(expectedRevision + 1)) return { state: "invalid" };
    this.initialize();
    return this.storage.transactionSync(() => {
      const head = this.readHead(profileId);
      if (head === undefined) return { state: "missing" };
      return head.revision !== expectedRevision ? { state: "conflict", current_revision: head.revision }
        : this.writeHead({ ...head, revision: expectedRevision + 1, approved_digest: null, approved_names: [] });
    });
  }
}
