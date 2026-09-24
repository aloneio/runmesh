import { CAPABILITY_LIMITS, isCapabilityIdentifier, parseCapabilityGrant } from "../../contracts/capabilities.js";
import type { CapabilityGrant, GrantReplacement, GrantWriteResult } from "../../contracts/capabilities.js";

type Row = { client_id: string; revision: number; enabled: number; rules_json: string };
type Storage = Pick<DurableObjectStorage, "sql" | "transactionSync">;

/** Sole owner of central grant tables. No Registry, Runner or optional audit fallback. */
export class CapabilityState {
  private initialized = false;
  public constructor(private readonly storage: Storage) {}

  /** Explicit owner composition; construction itself still performs no I/O. */
  public initialize(): void { this.ensureSchema(); }

  private ensureSchema(): void {
    if (this.initialized) return;
    this.storage.transactionSync(() => {
      const tables = this.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__cf_%'").toArray();
      if (!tables.some(table => table.name === "capabilities_meta")) {
        if (tables.length !== 0) throw new Error("capabilities_schema_unsupported");
        this.storage.sql.exec("CREATE TABLE capabilities_meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL)");
        this.storage.sql.exec("CREATE TABLE capability_grants_v1 (client_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision > 0), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), rules_json TEXT NOT NULL)");
        this.storage.sql.exec("INSERT INTO capabilities_meta VALUES (1,1)");
      } else {
        const meta = this.storage.sql.exec<{ schema_version: number }>("SELECT schema_version FROM capabilities_meta WHERE id=1").toArray();
        if (meta.length !== 1 || meta[0]?.schema_version !== 1 || !tables.some(table => table.name === "capability_grants_v1")) throw new Error("capabilities_schema_unsupported");
      }
    });
    this.initialized = true;
  }

  public readGrant(clientId: string): CapabilityGrant | undefined {
    if (!isCapabilityIdentifier(clientId)) throw new Error("capability_input_invalid");
    this.ensureSchema();
    const row = this.storage.sql.exec<Row>("SELECT client_id, revision, enabled, rules_json FROM capability_grants_v1 WHERE client_id=?", clientId).toArray()[0];
    if (row === undefined) return undefined;
    if (row.rules_json.length > CAPABILITY_LIMITS.grant_bytes || (row.enabled !== 0 && row.enabled !== 1)) throw new Error("capability_record_invalid");
    let rules: unknown;
    try { rules = JSON.parse(row.rules_json); } catch { throw new Error("capability_record_invalid"); }
    const grant = parseCapabilityGrant({ schema_version: 1, client_id: row.client_id, revision: row.revision, enabled: row.enabled === 1, rules });
    if (grant === undefined || grant.client_id !== clientId) throw new Error("capability_record_invalid");
    return grant;
  }

  public replaceGrant(input: GrantReplacement): GrantWriteResult {
    if (typeof input !== "object" || input === null || !Number.isSafeInteger(input.expected_revision)
      || input.expected_revision < 0 || input.expected_revision >= Number.MAX_SAFE_INTEGER) return { state: "invalid" };
    const grant = parseCapabilityGrant({ schema_version: 1, client_id: input.client_id, revision: input.expected_revision + 1,
      enabled: input.enabled, rules: input.rules });
    if (grant === undefined) return { state: "invalid" };
    this.ensureSchema();
    return this.storage.transactionSync(() => {
      const current = this.readGrant(grant.client_id);
      const revision = current?.revision ?? 0;
      if (revision !== input.expected_revision) return { state: "conflict", current_revision: revision };
      if (current === undefined) {
        const count = this.storage.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM capability_grants_v1").toArray()[0]?.total;
        if (count === undefined || count >= CAPABILITY_LIMITS.grant_clients) return { state: "capacity" };
      }
      this.storage.sql.exec("INSERT INTO capability_grants_v1 (client_id,revision,enabled,rules_json) VALUES (?,?,?,?) ON CONFLICT(client_id) DO UPDATE SET revision=excluded.revision, enabled=excluded.enabled, rules_json=excluded.rules_json",
        grant.client_id, grant.revision, grant.enabled ? 1 : 0, JSON.stringify(grant.rules));
      return { state: "written", grant };
    });
  }
}
