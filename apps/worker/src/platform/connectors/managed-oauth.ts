import { auth, refreshAuthorization, type FetchLike, type OAuthClientProvider, type StoredOAuthClientInformation, type StoredOAuthTokens } from "@modelcontextprotocol/client";
import type { AdminDecision, ConnectionProfile } from "../../contracts/connectors.js";
import { parseCredential } from "../../contracts/connector-values.js";
import { isCapabilityIdentifier } from "../../contracts/capabilities.js";
import { catalogKeys, catalogObject } from "../../contracts/catalog-json.js";
import { connectionClientMetadata, type ManagedConnectionResult } from "../../contracts/managed-connections.js";
import { OAuthFault, type CredentialLease, type OAuthCipher } from "../../contracts/oauth.js";
import type { ManagedOAuthRecord, ManagedOAuthRepository } from "./managed-store.js";
import { managedOAuthFetch, publicOAuthUrl, validDiscovery } from "./managed-oauth-http.js";

interface Ports {
  repository: ManagedOAuthRepository; cipher: OAuthCipher; profile: (id: string) => ConnectionProfile | undefined;
  admin: (hash: string, signal: AbortSignal) => Promise<AdminDecision>; origin: () => string | undefined;
  hash: (value: string) => Promise<string>; random: () => string; now: () => number; send?: FetchLike;
}
const fault = (code: ConstructorParameters<typeof OAuthFault>[0]): never => { throw new OAuthFault(code); };
const context = (record: ManagedOAuthRecord, kind: string) => `connection:${record.profile_id}:${record.state_hash}:${kind}`;

/** SDK adapter for an administrator-connected account. It never grants an AI
 * client access. Every credential use still passes the caller's grant fences. */
export function createManagedOAuth(ports: Ports) {
  const active = new Set<string>();
  const origin = (requestOrigin?: string) => {
    const configured = ports.origin(), value = configured ?? requestOrigin;
    if (configured !== undefined && requestOrigin !== undefined && configured !== requestOrigin) return fault("denied");
    if (!value || publicOAuthUrl(value) === undefined || new URL(value).origin !== value) return fault("unavailable");
    return value;
  };
  const profile = (id: string, revision?: number, disabled = false) => {
    const value = ports.profile(id);
    if (!value || value.authentication !== "oauth" || (!disabled && !value.enabled)) return fault("denied");
    if (revision !== undefined && value.revision !== revision) return fault("conflict");
    return value;
  };
  const admin = async (hash: string, signal: AbortSignal) => {
    if (!/^[a-f0-9]{64}$/u.test(hash)) return fault("denied");
    const decision = await ports.admin(hash, signal); signal.throwIfAborted();
    if (decision !== "allowed") return fault(decision === "denied" ? "denied" : "unavailable");
  };
  const current = (record: ManagedOAuthRecord) => {
    const live = ports.profile(record.profile_id), stored = ports.repository.read(record.profile_id);
    return live?.enabled === true && live.authentication === "oauth" && live.revision === record.profile_revision && stored?.revision === record.revision;
  };
  const commit = async (record: ManagedOAuthRecord, patch: Partial<ManagedOAuthRecord>, authorize: () => Promise<void>) => {
    await authorize(); if (!current(record)) return fault("conflict");
    const next = { ...record, ...patch, revision: record.revision + 1 };
    if (!ports.repository.replace(next, record.revision)) return fault("conflict"); return next;
  };
  const tokenValues = (raw: StoredOAuthTokens, previous?: StoredOAuthTokens) => {
    if (raw.token_type?.toLowerCase() !== "bearer" || parseCredential({ kind: "bearer", token: raw.access_token }) === undefined
      || (raw.refresh_token !== undefined && (typeof raw.refresh_token !== "string" || raw.refresh_token.length > 4096))
      || (raw.expires_in !== undefined && (!Number.isFinite(raw.expires_in) || raw.expires_in <= 0 || raw.expires_in > 31_536_000))) return fault("unavailable");
    return { tokens: { ...raw, ...(raw.refresh_token === undefined && previous?.refresh_token ? { refresh_token: previous.refresh_token } : {}) },
      expires: ports.now() + Math.floor((raw.expires_in ?? 3600) * 1000) };
  };
  async function provider(record: ManagedOAuthRecord, base: string, state?: string) {
    let discovery = record.discovery, client = record.client ? await ports.cipher.open(context(record, "client"), record.client) as StoredOAuthClientInformation : undefined;
    let verifier = record.verifier ? await ports.cipher.open(context(record, "verifier"), record.verifier) as string : undefined;
    let tokens: StoredOAuthTokens | undefined, redirect: string | undefined;
    const value: OAuthClientProvider = {
      redirectUrl: connectionClientMetadata(base).redirect_uris[0]!, clientMetadata: connectionClientMetadata(base),
      clientMetadataUrl: base + "/admin/central/connections/client-metadata",
      state: () => state ?? fault("invalid_callback"), clientInformation: () => client, tokens: () => undefined,
      saveClientInformation: value => { client = value; },
      saveTokens: value => { tokens = value; },
      saveCodeVerifier: value => { verifier = value; }, codeVerifier: () => verifier ?? fault("invalid_callback"),
      discoveryState: () => discovery, saveDiscoveryState: value => {
        if (!validDiscovery(value, base)) return fault("provider_unsupported"); discovery = value;
      },
      redirectToAuthorization: url => {
        if (!discovery || !validDiscovery(discovery, base) || publicOAuthUrl(url.href, base) === undefined
          || url.searchParams.get("state") !== state || url.searchParams.get("code_challenge_method") !== "S256") return fault("provider_unsupported");
        redirect = url.href;
      },
      // Prevent the SDK's invalid-client / invalid-grant retry from replaying a
      // one-use code or rotating refresh token. Reconnection is explicit.
      invalidateCredentials: () => fault("reauthorization_required"),
    };
    return { value, discovery: () => discovery, client: () => client, verifier: () => verifier, tokens: () => tokens, redirect: () => redirect };
  }
  async function begin(hash: string, input: Record<string, unknown>, signal: AbortSignal, requestOrigin?: string): Promise<ManagedConnectionResult> {
    if (!catalogKeys(input, ["profile_id", "expected_revision"]) || !isCapabilityIdentifier(input.profile_id) || !Number.isSafeInteger(input.expected_revision)) return fault("invalid_request");
    const selected = profile(input.profile_id, input.expected_revision as number), base = origin(requestOrigin);
    await admin(hash, signal);
    // Check independent encryption availability before registering a client.
    await ports.cipher.seal("connection-readiness", { ready: true });
    const state = ports.random(), stateHash = await ports.hash(state); await admin(hash, signal); profile(selected.profile_id, selected.revision);
    const old = ports.repository.read(selected.profile_id);
    let record: ManagedOAuthRecord = { profile_id: selected.profile_id, profile_revision: selected.revision, revision: (old?.revision ?? 0) + 1,
      state: "starting", session_hash: hash, state_hash: stateHash, origin: base, expires_at: ports.now() + 600_000, token_expires_at: 0 };
    if (!ports.repository.replace(record, old?.revision ?? 0)) return fault("conflict");
    const authorize = async () => { await admin(hash, signal); if (!current(record)) return fault("conflict"); };
    const p = await provider(record, base, state);
    const result = await auth(p.value, { serverUrl: selected.endpoint, forceReauthorization: true,
      fetchFn: managedOAuthFetch({ signal, authorize, origin: base, discovery: p.discovery, phase: "begin", ...(ports.send ? { send: ports.send } : {}) }) });
    if (result !== "REDIRECT" || !p.redirect() || !p.client() || !p.verifier() || !p.discovery()) return fault("provider_unsupported");
    const client = await ports.cipher.seal(context(record, "client"), p.client()), verifier = await ports.cipher.seal(context(record, "verifier"), p.verifier());
    record = await commit(record, { state: "pending", discovery: p.discovery()!, client, verifier }, authorize);
    return { state: "started", authorization_url: p.redirect()!, profile_id: record.profile_id };
  }
  async function complete(hash: string, input: Record<string, unknown>, signal: AbortSignal, requestOrigin?: string): Promise<ManagedConnectionResult> {
    if (!catalogKeys(input, ["state", "code", "iss", "error"]) || typeof input.state !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(input.state)
      || (input.iss !== undefined && (typeof input.iss !== "string" || input.iss.length > 2048))
      || (input.code !== undefined && (typeof input.code !== "string" || !input.code || input.code.length > 4096))
      || (input.error !== undefined && (typeof input.error !== "string" || input.error.length > 256))
      || (input.code === undefined) === (input.error === undefined)) return fault("invalid_callback");
    await admin(hash, signal);
    let record = ports.repository.find(await ports.hash(input.state));
    if (!record || record.state !== "pending" || record.session_hash !== hash || record.expires_at <= ports.now()) return fault("invalid_callback");
    const selected = profile(record.profile_id, record.profile_revision), base = origin(requestOrigin ?? record.origin);
    if (base !== record.origin) return fault("invalid_callback");
    const authorize = async () => { await admin(hash, signal); if (!current(record!)) return fault("conflict"); };
    record = await commit(record, { state: "exchanging" }, authorize);
    if (input.error !== undefined) { await commit(record, { state: "revoked", verifier: undefined, client: undefined, discovery: undefined }, authorize); return fault("reauthorization_required"); }
    if (!record.discovery || !validDiscovery(record.discovery, base)) return fault("invalid_callback");
    const p = await provider(record, base);
    const result = await auth(p.value, { serverUrl: selected.endpoint, authorizationCode: input.code as string, ...(input.iss === undefined ? {} : { iss: input.iss as string }),
      fetchFn: managedOAuthFetch({ signal, authorize, origin: base, discovery: p.discovery, phase: "complete", ...(ports.send ? { send: ports.send } : {}) }) });
    if (result !== "AUTHORIZED" || !p.tokens()) return fault("unavailable");
    const value = tokenValues(p.tokens()!), tokens = await ports.cipher.seal(context(record, "tokens"), value.tokens);
    await commit(record, { state: "ready", tokens, token_expires_at: value.expires, verifier: undefined }, authorize);
    return { state: "linked", profile_id: record.profile_id };
  }
  return {
    async run(hash: string, action: "begin" | "complete" | "revoke", raw: unknown, requestOrigin?: string): Promise<ManagedConnectionResult> {
      const input = catalogObject(raw); if (!input) return { state: "failed", code: "invalid_request", operation_state: "not_started" };
      if (active.has(hash) || active.size >= 4) return { state: "failed", code: "conflict", operation_state: "not_started" };
      active.add(hash); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20_000);
      try {
        if (action === "begin") return await begin(hash, input, controller.signal, requestOrigin);
        if (action === "complete") return await complete(hash, input, controller.signal, requestOrigin);
        if (!catalogKeys(input, ["profile_id", "expected_revision"]) || !isCapabilityIdentifier(input.profile_id) || !Number.isSafeInteger(input.expected_revision)) return fault("invalid_request");
        await admin(hash, controller.signal); profile(input.profile_id, input.expected_revision as number, true);
        const old = ports.repository.read(input.profile_id);
        if (old && !ports.repository.replace({ ...old, revision: old.revision + 1, state: "revoked", tokens: undefined, client: undefined, verifier: undefined, discovery: undefined }, old.revision)) return fault("conflict");
        return { state: "revoked", profile_id: input.profile_id };
      } catch (error) {
        const code = error instanceof OAuthFault && ["invalid_request", "denied", "conflict", "invalid_callback", "provider_unsupported", "reauthorization_required"].includes(error.code) ? error.code : "unavailable";
        return { state: "failed", code, operation_state: code === "unavailable" ? "unknown" : "not_started" } as ManagedConnectionResult;
      } finally { clearTimeout(timer); controller.abort(); active.delete(hash); }
    },
    async credential(selected: ConnectionProfile, signal: AbortSignal, admit: () => Promise<void>): Promise<CredentialLease> {
      await admit(); signal.throwIfAborted();
      let record = ports.repository.read(selected.profile_id);
      if (!record || record.state !== "ready" || !record.tokens || !record.discovery || !record.client || !current(record)) return fault("reauthorization_required");
      const base = origin(record.origin);
      const authorize = async () => { await admit(); signal.throwIfAborted(); if (!current(record!)) return fault("reauthorization_required"); };
      let tokens = await ports.cipher.open(context(record, "tokens"), record.tokens) as StoredOAuthTokens;
      if (record.token_expires_at <= ports.now() + 30_000) {
        if (!tokens.refresh_token || !validDiscovery(record.discovery, base)) return fault("reauthorization_required");
        const client = await ports.cipher.open(context(record, "client"), record.client) as StoredOAuthClientInformation;
        record = await commit(record, { state: "refreshing" }, authorize);
        const discovery = record.discovery!;
        const fresh = await refreshAuthorization(discovery.authorizationServerUrl, { metadata: discovery.authorizationServerMetadata!, clientInformation: client,
          refreshToken: tokens.refresh_token, resource: new URL(discovery.resourceMetadata?.resource ?? selected.endpoint),
          fetchFn: managedOAuthFetch({ signal, authorize, origin: base, discovery: () => discovery, phase: "refresh", ...(ports.send ? { send: ports.send } : {}) }) });
        const value = tokenValues({ ...fresh, ...(tokens.issuer === undefined ? {} : { issuer: tokens.issuer }) }, tokens); tokens = value.tokens;
        const envelope = await ports.cipher.seal(context(record, "tokens"), tokens);
        record = await commit(record, { state: "ready", tokens: envelope, token_expires_at: value.expires }, authorize);
      }
      await authorize();
      const credential = parseCredential({ kind: "bearer", token: tokens.access_token }); if (!credential) return fault("unavailable");
      const lease = record; return { credential, current: () => current(lease) && ports.repository.read(lease.profile_id)?.state === "ready" };
    },
  };
}
