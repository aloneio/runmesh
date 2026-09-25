import { isCapabilityIdentifier, parseCapabilityGrant } from "../../contracts/capabilities.js";
import type { ToolsetProfile, ToolsetResult } from "../../contracts/toolsets.js";
type Storage = Pick<DurableObjectStorage, "sql" | "transactionSync">;
/** Explicit reusable grant templates. Editing a template never silently expands
 * existing clients: application requires both template and client revisions. */
export class ToolsetState {
  private ready = false;
  public constructor(private readonly storage: Storage, private readonly initializeOwner: () => void) {}
  private initialize(): void {
    if (this.ready) return; this.initializeOwner();
    this.storage.transactionSync(() => {
      const tables = this.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE name IN ('toolset_meta','toolset_profiles_v1')").toArray();
      if (!tables.length) {
        this.storage.sql.exec("CREATE TABLE toolset_meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL)");
        this.storage.sql.exec("INSERT INTO toolset_meta VALUES (1,1)");
        this.storage.sql.exec("CREATE TABLE toolset_profiles_v1 (toolset_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, enabled INTEGER NOT NULL, rules_json TEXT NOT NULL)");
      } else if (tables.length !== 2 || this.storage.sql.exec<{ schema_version: number }>("SELECT schema_version FROM toolset_meta WHERE id=1").one().schema_version !== 1) throw new Error('toolset_schema_unsupported');
    }); this.ready = true;
  }
  public read(id: string): ToolsetProfile | undefined {
    if (!isCapabilityIdentifier(id)) return undefined; this.initialize();
    const row = this.storage.sql.exec<{ revision: number; enabled: number; rules_json: string }>("SELECT revision,enabled,rules_json FROM toolset_profiles_v1 WHERE toolset_id=?", id).toArray()[0];
    if (!row) return undefined;
    if (row.rules_json.length > 65_536 || ![0, 1].includes(row.enabled)) throw new Error('toolset_record_invalid');
    const grant = parseCapabilityGrant({ schema_version: 1, client_id: id, revision: row.revision, enabled: row.enabled === 1, rules: JSON.parse(row.rules_json) });
    if (!grant) throw new Error('toolset_record_invalid');
    return { schema_version: 1, toolset_id: id, revision: grant.revision, enabled: grant.enabled, rules: grant.rules };
  }
  public replace(input: unknown): ToolsetResult {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return { state: 'invalid' };
    const v = input as Record<string, unknown>;
    if (v.action !== 'replace' || Object.keys(v).some(k => !['action', 'toolset_id', 'expected_revision', 'enabled', 'rules'].includes(k))
      || !Number.isSafeInteger(v.expected_revision) || (v.expected_revision as number) < 0 || (v.expected_revision as number) >= Number.MAX_SAFE_INTEGER) return { state: 'invalid' };
    const grant = parseCapabilityGrant({ schema_version: 1, client_id: v.toolset_id, revision: (v.expected_revision as number) + 1, enabled: v.enabled, rules: v.rules });
    if (!grant) return { state: 'invalid' }; this.initialize();
    return this.storage.transactionSync(() => {
      const current = this.read(grant.client_id);
      if ((current?.revision ?? 0) !== v.expected_revision) return { state: 'conflict', current_revision: current?.revision ?? 0 };
      if (!current && this.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM toolset_profiles_v1").one().n >= 64) return { state: 'capacity' };
      this.storage.sql.exec("INSERT INTO toolset_profiles_v1 VALUES (?,?,?,?) ON CONFLICT(toolset_id) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled,rules_json=excluded.rules_json", grant.client_id, grant.revision, grant.enabled ? 1 : 0, JSON.stringify(grant.rules));
      return { state: 'written', toolset: { schema_version: 1, toolset_id: grant.client_id, revision: grant.revision, enabled: grant.enabled, rules: grant.rules } };
    });
  }
}
