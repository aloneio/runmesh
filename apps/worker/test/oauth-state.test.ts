import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { CapabilitiesDOv1 } from "../src/capabilities-do.js";
import { OAuthState } from "../src/platform/connectors/oauth-store.js";
import { CapabilityState } from "../src/platform/capabilities/store.js";
import { OAUTH_LIMITS, type OAuthFlow, type OAuthLink } from "../src/contracts/oauth.js";

const owner = () => {
  const ns = (env as unknown as { CAPABILITIES: DurableObjectNamespace<CapabilitiesDOv1> }).CAPABILITIES;
  return ns.get(ns.idFromName("oauth-storage-" + crypto.randomUUID()));
};
function records(i: number) {
  const id = (i + 1).toString(16).padStart(64, "0");
  const link: OAuthLink = { schema_version: 1, link_id: id, revision: 1, state: "pending", expires_at_ms: 0, envelope: null,
    binding: { profile_id: "docs", client_id: "client-" + i, secret_version: 1, endpoint: "https://remote.example.com/mcp", policy_digest: "b".repeat(64) } };
  const flow: OAuthFlow = { state_hash: id, link_id: id, revision: 1, session_hash: "a".repeat(64), expires_at_ms: 301000,
    verifier: { schema_version: 1, key_id: "test", iv: "A".repeat(16), ciphertext: "A".repeat(32) } };
  return { link, flow };
}
it("W06 constructing an owner creates no OAuth schema or timers", async () => {
  await runInDurableObject(owner(), (_, state) => {
    expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'oauth_%'").toArray()).toEqual([]);
  });
});
it("W06 flow and link writes roll back together on invalid replacement", async () => {
  await runInDurableObject(owner(), (_, state) => {
    const repo = new OAuthState(state.storage, () => new CapabilityState(state.storage).initialize()), { link, flow } = records(0);
    repo.begin(link, flow, 0, 1000);
    expect(() => repo.begin({ ...link, revision: 2, binding: { ...link.binding, client_id: "../bad" } }, { ...flow, revision: 2 }, 1, 1000)).toThrow();
    expect(repo.flow(flow.state_hash)?.revision).toBe(1); expect(repo.read(link.link_id)?.revision).toBe(1);
    expect(repo.consume(flow.state_hash, flow.session_hash, 1000).state).toBe("exchanging");
    expect(() => repo.consume(flow.state_hash, flow.session_hash, 1000)).toThrow();
  });
});
it("W06 pending flows have a real row cap and expired capacity is reclaimed only on demand", async () => {
  await runInDurableObject(owner(), (_, state) => {
    const repo = new OAuthState(state.storage, () => new CapabilityState(state.storage).initialize());
    for (let i = 0; i < OAUTH_LIMITS.flows; i++) { const { link, flow } = records(i); repo.begin(link, flow, 0, 1000); }
    const next = records(OAUTH_LIMITS.flows);
    expect(() => repo.begin(next.link, next.flow, 0, 1000)).toThrow();
    expect(state.storage.sql.exec("SELECT * FROM oauth_flows_v1").toArray()).toHaveLength(OAUTH_LIMITS.flows);
    repo.begin(next.link, { ...next.flow, expires_at_ms: 601001 }, 0, 301001);
    expect(state.storage.sql.exec("SELECT * FROM oauth_flows_v1").toArray()).toHaveLength(1);
    expect(state.storage.sql.exec("SELECT * FROM oauth_links_v1").toArray()).toHaveLength(OAUTH_LIMITS.flows + 1);
  });
});
it("W06 incomplete schemas and malformed records fail without replacing preserved state", async () => {
  await runInDurableObject(owner(), (_, state) => {
    new CapabilityState(state.storage).initialize();
    state.storage.sql.exec("CREATE TABLE oauth_meta (id INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL)");
    state.storage.sql.exec("INSERT INTO oauth_meta VALUES (1,1)");
    expect(() => new OAuthState(state.storage, () => undefined).read("a".repeat(64))).toThrow();
    expect(state.storage.sql.exec("SELECT * FROM oauth_meta").toArray()).toHaveLength(1);
    expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='oauth_links_v1'").toArray()).toHaveLength(0);
  });
});
