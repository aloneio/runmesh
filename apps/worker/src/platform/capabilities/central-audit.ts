import { CENTRAL_GOVERNANCE_LIMITS as LIMITS, type CentralObservation, type CentralAuditRow } from "../../contracts/central-audit.js";
import { REMOTE_CODES, type RemoteCode } from "../../contracts/remote.js";

type Storage = Pick<DurableObjectStorage, "sql" | "transactionSync">;
type Counts = { admission_keys: number; receipt_count: number };
/** Only allowlisted metadata reaches this optional history. No replay queue. */
export class CentralGovernance implements CentralObservation {
  private ready = false;
  public constructor(private readonly storage: Storage, private readonly initializeOwner: () => void, private readonly now = Date.now) {}
  private initialize(): void {
    if (this.ready) return;
    this.initializeOwner();
    this.storage.transactionSync(() => {
      const tables = this.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE name IN ('central_governance_meta','central_admission_v1','central_receipts_v1')").toArray();
      if (!tables.length) {
        this.storage.sql.exec("CREATE TABLE central_governance_meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL)");
        this.storage.sql.exec("INSERT INTO central_governance_meta VALUES (1,1)");
        this.storage.sql.exec("CREATE TABLE central_admission_v1 (key TEXT PRIMARY KEY, window_ms INTEGER NOT NULL, count INTEGER NOT NULL, failures INTEGER NOT NULL, cooldown_ms INTEGER NOT NULL)");
        this.storage.sql.exec("CREATE TABLE central_receipts_v1 (request_id TEXT PRIMARY KEY, client_id TEXT NOT NULL, profile_id TEXT NOT NULL, tool_id TEXT NOT NULL, version TEXT NOT NULL, operation_state TEXT NOT NULL, code TEXT NOT NULL, created_at_ms INTEGER NOT NULL)");
      } else if (tables.length !== 3) throw new Error("central_governance_schema_unsupported");
      const version = this.storage.sql.exec<{ schema_version: number }>("SELECT schema_version FROM central_governance_meta WHERE id=1").toArray()[0]?.schema_version;
      if (version === 1) {
        // One atomic backfill; steady-state calls never count either full table.
        this.storage.sql.exec("ALTER TABLE central_governance_meta ADD COLUMN admission_keys INTEGER NOT NULL DEFAULT 0");
        this.storage.sql.exec("ALTER TABLE central_governance_meta ADD COLUMN receipt_count INTEGER NOT NULL DEFAULT 0");
        this.storage.sql.exec("CREATE INDEX central_admission_expiry_v2 ON central_admission_v1(MAX(window_ms+60000,cooldown_ms))");
        this.storage.sql.exec("CREATE INDEX central_receipt_time_v2 ON central_receipts_v1(created_at_ms,request_id)");
        this.storage.sql.exec("UPDATE central_governance_meta SET schema_version=2,admission_keys=(SELECT COUNT(*) FROM central_admission_v1),receipt_count=(SELECT COUNT(*) FROM central_receipts_v1) WHERE id=1");
      } else if (version !== 2) throw new Error("central_governance_schema_unsupported");
    });
    this.ready = true;
  }
  private counts(): Counts {
    const row = this.storage.sql.exec<Counts>("SELECT admission_keys,receipt_count FROM central_governance_meta WHERE id=1").toArray()[0];
    if (!row || Object.values(row).some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error("central_governance_count_invalid");
    return row;
  }
  public admit: CentralObservation["admit"] = (principal, command) => {
    this.initialize();
    return this.storage.transactionSync(() => {
      const now = this.now();
      const counts = this.counts();
      const expired = this.storage.sql.exec("DELETE FROM central_admission_v1 WHERE MAX(window_ms+60000,cooldown_ms)<? RETURNING key", now).toArray().length;
      const keys = [{ key: "client:" + principal.client_id, max: LIMITS.calls_per_minute },
        { key: "profile:" + command.profile_id, max: LIMITS.profile_calls_per_minute }];
      const rows = keys.map(({ key, max }) => {
        const row = this.storage.sql.exec<{ window_ms: number; count: number; cooldown_ms: number }>("SELECT window_ms,count,cooldown_ms FROM central_admission_v1 WHERE key=?", key).toArray()[0];
        return { key, max, row, count: row && now - row.window_ms < 60_000 ? row.count : 0 };
      });
      const total = counts.admission_keys - expired, added = rows.filter(r => !r.row).length;
      if (total < 0) throw new Error("central_governance_count_invalid");
      const admitted = total + added <= LIMITS.keys && rows.every(r => r.count < r.max && (r.row?.cooldown_ms ?? 0) <= now);
      const next = total + (admitted ? added : 0);
      if (next !== counts.admission_keys) this.storage.sql.exec("UPDATE central_governance_meta SET admission_keys=? WHERE id=1", next);
      if (!admitted) return false;
      for (const r of rows) {
        if (!r.row) this.storage.sql.exec("INSERT INTO central_admission_v1 VALUES (?,?,1,0,0)", r.key, now);
        else if (now - r.row.window_ms < 60_000) this.storage.sql.exec("UPDATE central_admission_v1 SET count=? WHERE key=?", r.count + 1, r.key);
        else this.storage.sql.exec("UPDATE central_admission_v1 SET window_ms=?,count=1 WHERE key=?", now, r.key);
      }
      return true;
    });
  };
  public record: CentralObservation["record"] = (principal, command, outcome) => {
    const request_id = crypto.randomUUID();
    try {
      this.initialize();
      this.storage.transactionSync(() => {
        const now = this.now(), key = "profile:" + command.profile_id;
        const failure = outcome.state === "failed" && ["upstream_unavailable", "upstream_protocol_error", "operation_timed_out", "result_unconfirmed", "result_invalid"].includes(outcome.code ?? "");
        if (failure) this.storage.sql.exec("UPDATE central_admission_v1 SET failures=failures+1,cooldown_ms=CASE WHEN failures+1>=? THEN ? ELSE cooldown_ms END WHERE key=?", LIMITS.failures, now + LIMITS.cooldown_ms, key);
        else if (outcome.state === "completed") this.storage.sql.exec("UPDATE central_admission_v1 SET failures=0,cooldown_ms=0 WHERE key=? AND (failures<>0 OR cooldown_ms<>0)", key);
        const counts = this.counts();
        const expired = this.storage.sql.exec("DELETE FROM central_receipts_v1 WHERE created_at_ms<? RETURNING request_id", now - LIMITS.retention_ms).toArray().length;
        let next = counts.receipt_count - expired + 1;
        if (next < 1) throw new Error("central_governance_count_invalid");
        const code = outcome.state === "completed" ? "completed" : REMOTE_CODES.includes(outcome.code as RemoteCode) ? outcome.code! : "result_unconfirmed";
        this.storage.sql.exec("INSERT INTO central_receipts_v1 VALUES (?,?,?,?,?,?,?,?)", request_id, principal.client_id, command.profile_id, command.tool_id, command.version, outcome.operation_state, code, now);
        if (next > LIMITS.receipts) next -= this.storage.sql.exec("DELETE FROM central_receipts_v1 WHERE request_id IN (SELECT request_id FROM central_receipts_v1 ORDER BY created_at_ms,request_id LIMIT ?) RETURNING request_id", next - LIMITS.receipts).toArray().length;
        if (next !== counts.receipt_count) this.storage.sql.exec("UPDATE central_governance_meta SET receipt_count=? WHERE id=1", next);
      });
      return { request_id, audit_status: "recorded" };
    } catch { return { request_id, audit_status: "unavailable" }; }
  };
  public list(): CentralAuditRow[] {
    this.initialize();
    return this.storage.sql.exec<CentralAuditRow & Record<string, SqlStorageValue>>("SELECT * FROM central_receipts_v1 WHERE created_at_ms>=? ORDER BY created_at_ms DESC,request_id DESC LIMIT 50", this.now() - LIMITS.retention_ms).toArray();
  }
}
