import type { ManagedOAuthRecord, ManagedOAuthRepository } from '../../contracts/managed-oauth.js';
import { parseEnvelope } from '../../contracts/connector-values.js';
import { isCapabilityIdentifier } from '../../contracts/capabilities.js';
import { publicMcpEndpoint } from '../../contracts/remote-values.js';

function valid(value: ManagedOAuthRecord): boolean {
  return !!value && isCapabilityIdentifier(value.profile_id) && [value.profile_revision, value.revision].every(n => Number.isSafeInteger(n) && n > 0)
    && publicMcpEndpoint(value.origin) !== undefined && new URL(value.origin).origin === value.origin
    && [value.expires_at, value.token_expires_at].every(n => Number.isSafeInteger(n) && n >= 0)
    && /^[a-f0-9]{64}$/u.test(value.session_hash) && /^[a-f0-9]{64}$/u.test(value.state_hash)
    && ["starting", "pending", "exchanging", "ready", "refreshing", "revoked"].includes(value.state)
    && [value.client, value.verifier, value.tokens].every(v => v === undefined || parseEnvelope(v) !== undefined)
    && JSON.stringify(value).length <= 65_536;
}
/** Secrets stay encrypted; state claims are synchronous and survive eviction. */
export class ManagedOAuthState implements ManagedOAuthRepository {
  private ready = false;
  constructor(private readonly storage: Pick<DurableObjectStorage, "sql" | "transactionSync">, private readonly initializeOwner: () => void) {}
  private initialize() {
    if (this.ready) return; this.initializeOwner();
    this.storage.sql.exec("CREATE TABLE IF NOT EXISTS managed_oauth_v1 (profile_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state_hash TEXT UNIQUE NOT NULL, record_json TEXT NOT NULL)");
    this.ready = true;
  }
  read(id: string): ManagedOAuthRecord | undefined {
    if (!isCapabilityIdentifier(id)) throw new Error("invalid_profile"); this.initialize();
    const row = this.storage.sql.exec<{ revision: number; record_json: string }>("SELECT revision,record_json FROM managed_oauth_v1 WHERE profile_id=?", id).toArray()[0];
    if (!row) return undefined;
    if (row.record_json.length > 65_536) throw new Error("invalid_oauth_record");
    const value = JSON.parse(row.record_json) as ManagedOAuthRecord;
    if (!valid(value) || value.profile_id !== id || value.revision !== row.revision) throw new Error("invalid_oauth_record");
    return value;
  }
  find(hash: string) {
    if (!/^[a-f0-9]{64}$/u.test(hash)) return undefined; this.initialize();
    const row = this.storage.sql.exec<{ profile_id: string }>("SELECT profile_id FROM managed_oauth_v1 WHERE state_hash=?", hash).toArray()[0];
    return row ? this.read(row.profile_id) : undefined;
  }
  replace(value: ManagedOAuthRecord, expected: number) {
    if (!valid(value) || !Number.isSafeInteger(expected) || expected < 0 || value.revision !== expected + 1) throw new Error("invalid_oauth_record");
    this.initialize();
    return this.storage.transactionSync(() => {
      if ((this.read(value.profile_id)?.revision ?? 0) !== expected) return false;
      this.storage.sql.exec("INSERT INTO managed_oauth_v1 VALUES (?,?,?,?) ON CONFLICT(profile_id) DO UPDATE SET revision=excluded.revision,state_hash=excluded.state_hash,record_json=excluded.record_json", value.profile_id, value.revision, value.state_hash, JSON.stringify(value));
      return true;
    });
  }
}
