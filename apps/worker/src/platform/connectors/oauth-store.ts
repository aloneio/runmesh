import { OAUTH_LIMITS, OAuthFault, type OAuthFlow, type OAuthLink, type OAuthLinkState, type OAuthRepository } from "../../contracts/oauth.js";
import { parseOAuthLink } from "../../contracts/oauth-values.js";
import { catalogDigest, catalogJson, catalogRevision } from "../../contracts/catalog-json.js";
import { parseEnvelope } from "../../contracts/connector-values.js";

type Storage = Pick<DurableObjectStorage, "sql" | "transactionSync">;
/** Bounded owner-local state and one-use claims, never restart replay. */
export class OAuthState implements OAuthRepository {
  private ready = false;
  constructor(private readonly storage: Storage, private readonly initializeOwner: () => void) {}
  private initialize() {
    if (this.ready) return;
    this.initializeOwner();
    this.storage.transactionSync(() => {
      const names = this.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('oauth_meta','oauth_links_v1','oauth_flows_v1')").toArray();
      if (names.length === 0) {
        this.storage.sql.exec("CREATE TABLE oauth_meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL)");
        this.storage.sql.exec("CREATE TABLE oauth_links_v1 (link_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, link_json TEXT NOT NULL)");
        this.storage.sql.exec("CREATE TABLE oauth_flows_v1 (state_hash TEXT PRIMARY KEY, link_id TEXT NOT NULL, expires_at_ms INTEGER NOT NULL, flow_json TEXT NOT NULL)");
        this.storage.sql.exec("INSERT INTO oauth_meta VALUES (1,1)");
      } else if (names.length !== 3 || this.storage.sql.exec<{ schema_version: number }>("SELECT schema_version FROM oauth_meta WHERE id=1").toArray()[0]?.schema_version !== 1) {
        throw new OAuthFault("unavailable");
      }
    }); this.ready = true;
  }
  read(id: string): OAuthLink | undefined {
    if (!catalogDigest(id)) throw new OAuthFault("invalid_request");
    this.initialize();
    const row = this.storage.sql.exec<{ revision: number; link_json: string }>("SELECT revision,link_json FROM oauth_links_v1 WHERE link_id=?", id).toArray()[0];
    if (row === undefined) return undefined;
    try {
      if (row.link_json.length > 16_384) throw new Error();
      const link = parseOAuthLink(JSON.parse(row.link_json));
      if (link === undefined || link.link_id !== id || link.revision !== row.revision) throw new Error();
      return link;
    } catch { throw new OAuthFault("unavailable"); }
  }
  flow(hash: string): OAuthFlow | undefined {
    if (!catalogDigest(hash)) throw new OAuthFault("invalid_request");
    this.initialize();
    const row = this.storage.sql.exec<{ flow_json: string; link_id: string; expires_at_ms: number }>("SELECT flow_json,link_id,expires_at_ms FROM oauth_flows_v1 WHERE state_hash=?", hash).toArray()[0];
    if (row === undefined) return undefined;
    try {
      if (row.flow_json.length > 8192) throw new Error();
      const flow = JSON.parse(row.flow_json) as OAuthFlow;
      if (flow.state_hash !== hash || !catalogDigest(flow.link_id) || flow.link_id !== row.link_id || !catalogDigest(flow.session_hash)
        || !catalogRevision(flow.revision) || !catalogRevision(flow.expires_at_ms) || flow.expires_at_ms !== row.expires_at_ms
        || parseEnvelope(flow.verifier) === undefined) throw new Error();
      return flow;
    } catch { throw new OAuthFault("unavailable"); }
  }
  private write(link: OAuthLink) {
    const parsed = parseOAuthLink(link), encoded = catalogJson(link, 16_384);
    if (parsed === undefined || encoded === undefined) throw new OAuthFault("invalid_request");
    this.storage.sql.exec("INSERT INTO oauth_links_v1 VALUES (?,?,?) ON CONFLICT(link_id) DO UPDATE SET revision=excluded.revision,link_json=excluded.link_json", link.link_id, link.revision, encoded);
  }
  begin(link: OAuthLink, flow: OAuthFlow, expected: number, now: number): void {
    if (!catalogRevision(expected, true) || !catalogRevision(now, true) || link.revision !== expected + 1 || link.state !== "pending"
      || flow.link_id !== link.link_id || flow.revision !== link.revision || !catalogDigest(flow.state_hash) || !catalogDigest(flow.session_hash)
      || flow.expires_at_ms <= now || flow.expires_at_ms > now + OAUTH_LIMITS.flow_ttl_ms || parseEnvelope(flow.verifier) === undefined) throw new OAuthFault("invalid_request");
    this.initialize();
    this.storage.transactionSync(() => {
      const current = this.read(link.link_id);
      if ((current?.revision ?? 0) !== expected) throw new OAuthFault("conflict");
      this.storage.sql.exec("DELETE FROM oauth_flows_v1 WHERE expires_at_ms<=? OR link_id=?", now, link.link_id);
      const count = (table: "oauth_links_v1" | "oauth_flows_v1") => this.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;
      if (count("oauth_flows_v1") >= OAUTH_LIMITS.flows || (current === undefined && count("oauth_links_v1") >= OAUTH_LIMITS.links)) throw new OAuthFault("capacity");
      this.write(link);
      this.storage.sql.exec("INSERT INTO oauth_flows_v1 VALUES (?,?,?,?)", flow.state_hash, flow.link_id, flow.expires_at_ms, JSON.stringify(flow));
    });
  }
  consume(hash: string, sessionHash: string, now: number): OAuthLink {
    this.initialize();
    return this.storage.transactionSync(() => {
      const flow = this.flow(hash), link = flow === undefined ? undefined : this.read(flow.link_id);
      if (flow === undefined || flow.session_hash !== sessionHash || flow.expires_at_ms <= now || link?.state !== "pending" || link.revision !== flow.revision) throw new OAuthFault("invalid_callback");
      const next: OAuthLink = { ...link, state: "exchanging" };
      this.write(next); this.storage.sql.exec("DELETE FROM oauth_flows_v1 WHERE state_hash=?", hash);
      return next;
    });
  }
  transition(next: OAuthLink, expected: number, state: OAuthLinkState): void {
    this.initialize();
    this.storage.transactionSync(() => {
      const current = this.read(next.link_id);
      if (current === undefined || current.revision !== expected || current.state !== state) throw new OAuthFault("conflict");
      const allowed = next.state === "revoked" || ((state === "exchanging" || state === "refreshing") && ["ready", "reauthorize"].includes(next.state))
        || (state === "ready" && (next.state === "refreshing" || next.state === "reauthorize"));
      if (!allowed || next.revision !== expected + 1 || catalogJson(next.binding, 4096) !== catalogJson(current.binding, 4096)) throw new OAuthFault("invalid_request");
      this.write(next); this.storage.sql.exec("DELETE FROM oauth_flows_v1 WHERE link_id=?", next.link_id);
    });
  }
}
