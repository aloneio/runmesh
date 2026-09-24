import { vi } from "vitest";
import { createOAuthManager } from "../../apps/worker/src/application/connectors/oauth.js";
import { OAuthFault, type OAuthFlow, type OAuthLink, type OAuthPolicy, type OAuthPorts, type OAuthRepository } from "../../apps/worker/src/contracts/oauth.js";
import type { ConnectionProfile, CredentialEnvelope } from "../../apps/worker/src/contracts/connectors.js";
import { parseOAuthSelection } from "../../apps/worker/src/contracts/oauth-values.js";

export const oauthPolicy: OAuthPolicy = { profile_id: "docs", resource: "https://remote.example.com/mcp", issuer: "https://login.example.com",
  metadata_endpoint: "https://login.example.com/.well-known/oauth-authorization-server", authorization_endpoint: "https://login.example.com/authorize",
  token_endpoint: "https://login.example.com/token", oauth_client_id: "registered-public-client", scopes: ["read"] };
export const oauthProfile: ConnectionProfile = { schema_version: 1, profile_id: "docs", connector_id: "remote", endpoint: oauthPolicy.resource,
  owner: { kind: "instance_admin" }, revision: 2, enabled: true, credential: null };
export const oauthPrincipal = { client_id: "client-a", secret_version: 1 };
export const adminHash = "a".repeat(64);
export async function oauthHash(text: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), b => b.toString(16).padStart(2, "0")).join("");
}
export function oauthFixture() {
  const links = new Map<string, OAuthLink>(), flows = new Map<string, OAuthFlow>(), encrypted = new Map<string, { context: string; value: unknown }>();
  let clock = 1_000_000, entropy = 0;
  let profile = structuredClone(oauthProfile), policy = structuredClone(oauthPolicy), identityAllowed = true, adminAllowed = true;
  const clone = <T>(value: T): T => structuredClone(value);
  const repository: OAuthRepository = {
    read: id => { const value = links.get(id); return value === undefined ? undefined : clone(value); },
    flow: hash => { const value = flows.get(hash); return value === undefined ? undefined : clone(value); },
    begin: (link, flow, expected) => {
      if ((links.get(link.link_id)?.revision ?? 0) !== expected) throw new OAuthFault("conflict");
      for (const [key, item] of flows) if (item.link_id === link.link_id) flows.delete(key);
      links.set(link.link_id, clone(link)); flows.set(flow.state_hash, clone(flow));
    },
    consume: (hash, session, now) => {
      const flow = flows.get(hash), link = flow === undefined ? undefined : links.get(flow.link_id);
      if (flow === undefined || flow.session_hash !== session || flow.expires_at_ms <= now || link?.state !== "pending" || link.revision !== flow.revision) throw new OAuthFault("invalid_callback");
      flows.delete(hash); const result: OAuthLink = { ...link, state: "exchanging" }; links.set(link.link_id, clone(result)); return result;
    },
    transition: (next, revision, state) => {
      const old = links.get(next.link_id);
      if (old?.revision !== revision || old.state !== state) throw new OAuthFault("conflict");
      links.set(next.link_id, clone(next));
      for (const [key, item] of flows) if (item.link_id === next.link_id) flows.delete(key);
    },
  };
  const verify = vi.fn(async () => undefined);
  const exchange = vi.fn(async () => ({ access_token: "access-first", refresh_token: "refresh-first", expires_in: 60, token_type: "Bearer", scope: "read" }));
  const refresh = vi.fn(async () => ({ access_token: "access-next", refresh_token: "refresh-next", expires_in: 60, token_type: "Bearer", scope: "read" }));
  const ports: OAuthPorts = {
    repository, profile: () => clone(profile), policy: () => clone(policy), redirect: () => "https://worker.test/admin/central/oauth/callback",
    admin: async () => adminAllowed ? "allowed" : "denied",
    identity: async principal => identityAllowed ? { state: "allowed", identity: { schema_version: 2, ...principal, label: "test", native_scopes: [] } } : { state: "denied" },
    now: () => clock, hash: oauthHash, random: () => String(++entropy).padStart(43, "A"), challenge: async () => "C".repeat(43),
    cipher: {
      seal: async (context, value) => {
        const ciphertext = "sealed" + String(++entropy).padStart(30, "A"); encrypted.set(ciphertext, { context, value: clone(value) });
        return { schema_version: 1, key_id: "test", iv: "A".repeat(16), ciphertext } satisfies CredentialEnvelope;
      },
      open: async (context, envelope) => {
        const item = encrypted.get(envelope.ciphertext); if (item?.context !== context) throw new OAuthFault("unavailable"); return clone(item.value);
      },
    },
    transport: { verify: async (p, signal, fence) => { await fence(); return verify(); },
      exchange: async (p, redirect, code, verifier, signal, fence) => { await fence(); return exchange(); },
      refresh: async (p, token, signal, fence) => { await fence(); return refresh(); } },
  };
  const manager = createOAuthManager(ports), signal = () => new AbortController().signal;
  const selection = (client_id = oauthPrincipal.client_id, expected_revision = 0) => ({ profile_id: "docs", principal: { client_id, secret_version: 1 }, expected_revision });
  const begin = async (client_id?: string) => {
    const result = await manager.begin(adminHash, selection(client_id), signal());
    if (result.state !== "started") throw new Error("start failed: " + JSON.stringify(result));
    return { result, callback: { state: new URL(result.authorization_url).searchParams.get("state")!, iss: oauthPolicy.issuer, code: "once-only-code" } };
  };
  const linked = async (client_id?: string) => {
    const start = await begin(client_id), result = await manager.complete(adminHash, start.callback, signal());
    if (result.state !== "linked") throw new Error("link failed: " + JSON.stringify(result));
    return { ...start, link: result.link };
  };
  return { ports, manager, links, flows, verify, exchange, refresh, begin, linked, selection, signal,
    advance: (ms: number) => { clock += ms; }, revokeIdentity: () => { identityAllowed = false; }, revokeAdmin: () => { adminAllowed = false; },
    changeProfile: () => { profile = { ...profile, revision: profile.revision + 1 }; }, changePolicy: () => { policy = { ...policy, oauth_client_id: "other" }; },
    credential: (client_id = oauthPrincipal.client_id) => manager.credential(oauthProfile, { client_id, secret_version: 1 }, signal(), async () => undefined),
  };
}
