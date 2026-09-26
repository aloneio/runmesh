import { CONNECTOR_LIMITS, type ProfileRecord, type ProfileRepository, type ProfileResult } from "../../contracts/connectors.js";
import { isCapabilityIdentifier } from "../../contracts/capabilities.js";
import { parseProfile, validProfileEnvelope } from "../../contracts/connector-values.js";

type Storage = Pick<DurableObjectStorage, "sql" | "transactionSync">;
type Row = { profile_id: string; revision: number; profile_json: string; envelope_json: string };

/** Connection metadata only; OAuth secrets belong to their own repository. Parent initialization is injected by composition. */
export class ConnectionState implements ProfileRepository {
  private ready = false;
  public constructor(private readonly storage: Storage, private readonly initializeOwner: () => void) {}

  private initialize(): void {
    if (this.ready) return;
    this.initializeOwner();
    this.storage.transactionSync(() => {
      const tables = this.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('connector_meta','connection_profiles_v1')").toArray();
      if (tables.length === 0) {
        this.storage.sql.exec("CREATE TABLE connector_meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL)");
        this.storage.sql.exec("CREATE TABLE connection_profiles_v1 (profile_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0), profile_json TEXT NOT NULL, envelope_json TEXT NOT NULL)");
        this.storage.sql.exec("INSERT INTO connector_meta VALUES (1,1)");
      } else {
        if (tables.length !== 2) throw new Error("connector_schema_unsupported");
        const meta = this.storage.sql.exec<{ schema_version: number }>("SELECT schema_version FROM connector_meta WHERE id=1").toArray();
        if (meta.length !== 1 || meta[0]?.schema_version !== 1) throw new Error("connector_schema_unsupported");
      }
    });
    this.ready = true;
  }

  public read(profileId: string): ProfileRecord | undefined {
    if (!isCapabilityIdentifier(profileId)) throw new Error("connector_input_invalid");
    this.initialize();
    const row = this.storage.sql.exec<Row>("SELECT profile_id,revision,profile_json,envelope_json FROM connection_profiles_v1 WHERE profile_id=?", profileId).toArray()[0];
    if (row === undefined) return undefined;
    try {
      if (row.profile_json.length > CONNECTOR_LIMITS.envelope_bytes || row.envelope_json.length > CONNECTOR_LIMITS.envelope_bytes) throw new Error();
      const profile = parseProfile(JSON.parse(row.profile_json)), rawEnvelope: unknown = JSON.parse(row.envelope_json);
      const envelope = rawEnvelope === null ? null : undefined;
      if (profile === undefined || envelope === undefined || !validProfileEnvelope(profile, envelope) || profile.profile_id !== profileId || row.profile_id !== profileId || profile.revision !== row.revision) throw new Error();
      return { profile, envelope };
    } catch { throw new Error("connector_record_invalid"); }
  }

  /** Bounded metadata-only page. Credential envelopes are never projected. */
  public list(after = ""): { profiles: ProfileRecord["profile"][]; next_after: string | null } {
    this.initialize();
    const rows = this.storage.sql.exec<{ profile_id: string }>("SELECT profile_id FROM connection_profiles_v1 WHERE profile_id>? ORDER BY profile_id LIMIT 51", after).toArray();
    const profiles = rows.slice(0, 50).map(row => this.read(row.profile_id)!.profile);
    return { profiles, next_after: rows.length > 50 ? profiles.at(-1)!.profile_id : null };
  }

  public replace(record: ProfileRecord, expectedRevision: number): ProfileResult {
    const profile = parseProfile(record?.profile), envelope = record?.envelope === null ? null : undefined;
    if (profile === undefined || envelope === undefined || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
      || profile.revision !== expectedRevision + 1 || !validProfileEnvelope(profile, envelope)) return { state: "invalid" };
    this.initialize();
    return this.storage.transactionSync(() => {
      const current = this.read(profile.profile_id), revision = current?.profile.revision ?? 0;
      if (revision !== expectedRevision) return { state: "conflict", current_revision: revision };
      if (current === undefined) {
        if (profile.enabled) return { state: "invalid" };
        const count = this.storage.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM connection_profiles_v1").toArray()[0]?.total;
        if (count === undefined || count >= CONNECTOR_LIMITS.profiles) return { state: "capacity" };
      } else {
        const old = current.profile;
        if (old.connector_id !== profile.connector_id || old.endpoint !== profile.endpoint || old.authentication !== profile.authentication) return { state: "invalid" };
      }
      this.storage.sql.exec("INSERT INTO connection_profiles_v1 VALUES (?,?,?,?) ON CONFLICT(profile_id) DO UPDATE SET revision=excluded.revision,profile_json=excluded.profile_json,envelope_json=excluded.envelope_json",
        profile.profile_id, profile.revision, JSON.stringify(profile), JSON.stringify(envelope));
      return { state: "written", profile };
    });
  }
}
