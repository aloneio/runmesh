import { DurableObject } from "cloudflare:workers";
import type { OAuthAdministration, OAuthResult } from "./contracts/oauth.js";
import { OAuthFault } from "./contracts/oauth.js";
import { parseOAuthPolicies, parseOAuthSelection } from "./contracts/oauth-values.js";
import { OAuthState } from "./platform/connectors/oauth-store.js";
import { createOAuthCipher, oauthRandom, oauthChallenge } from "./platform/connectors/oauth-crypto.js";
import { createOAuthTransport } from "./platform/connectors/oauth-http.js";
import { createOAuthManager } from "./application/connectors/oauth.js";
import { createManagedOAuthProtocol } from "./platform/connectors/managed-oauth.js";
import { createManagedOAuth } from './application/connectors/managed-oauth.js';
import { ManagedOAuthState } from "./platform/connectors/managed-store.js";
import type { ManagedConnections } from "./contracts/managed-connections.js";
import type { AdminDecision, CentralAdministration, ProfileResult } from "./contracts/connectors.js";
import type { CapabilityGrant, GrantReplacement, GrantWriteResult, CentralToolVisibility } from "./contracts/capabilities.js";
import { isCapabilityIdentifier, parseCapabilityGrant } from "./contracts/capabilities.js";
import type { CentralManagement } from "./contracts/central-management.js";
import { CapabilityState } from "./platform/capabilities/store.js";
import { ConnectionState } from "./platform/connectors/store.js";
import { createCredentialCipher } from "./platform/connectors/cipher.js";
import { createProfileManager } from "./application/connectors/profiles.js";
import { boundedJsonResponse } from "./platform/bounded-json.js";
import { registryRequest } from "./platform/control-plane.js";
import type { WorkerEnv } from "./platform/env.js";
import type { CatalogAdministration, CatalogInspection, CatalogMutation, CatalogPage } from "./contracts/catalog.js";
import type { CapturedIdentity, IdentityDecision } from "./contracts/identity.js";
import { parseClientIdentity } from "./contracts/identity.js";
import { CatalogState } from "./platform/capabilities/catalog-store.js";
import { catalogSha256, createCatalogCursor } from "./platform/capabilities/catalog-crypto.js";
import { createCatalogManager } from "./application/capabilities/catalog-admin.js";
import { createCatalogReader } from "./application/capabilities/catalog-read.js";
import { createDirectoryReader } from "./application/capabilities/directory.js";
import { createDependencyReader } from "./application/capabilities/dependencies.js";
import type { CentralDirectory } from "./contracts/catalog.js";
import { withinDeadline } from "./application/connectors/deadline.js";
import { createRemoteCaller } from "./application/capabilities/remote-call.js";
import { createRemoteDiscovery } from "./application/capabilities/remote-discovery.js";
import { createHttpRemoteConnector } from "./platform/connectors/remote-client.js";
import { REMOTE_LIMITS, RemoteFault, type CentralRemote, type RemoteOutcome, type RemoteFailure } from "./contracts/remote.js";
import { connectionPolicy } from "./platform/connectors/connection-policy.js";
import { SkillState } from "./platform/skills/store.js";
import { createSkillService } from "./application/skills/service.js";
import type { CentralSkills } from "./contracts/skills.js";
import { CentralGovernance } from "./platform/capabilities/central-audit.js";
import type { CentralAuditRow } from "./contracts/central-audit.js";
import type { ToolsetAdministration } from "./contracts/toolsets.js";
import { ToolsetState } from "./platform/capabilities/toolsets.js";

/** Reviewed composition root. Feature repositories never import each other.
 * Binding-only APIs return metadata, never decrypted credentials. No public fetch API. */
export class CapabilitiesDOv1 extends DurableObject<WorkerEnv> implements CentralAdministration, CatalogAdministration, CentralRemote, OAuthAdministration {
  readonly #grants: CapabilityState;
  readonly #profiles: ConnectionState;
  readonly #namespace: string;
  readonly #catalog: CatalogState;
  readonly #oauthState: OAuthState;
  readonly #skills: SkillState;
  readonly #governance: CentralGovernance;
  readonly #toolsets: ToolsetState;
  #oauthService: ReturnType<typeof createOAuthManager> | undefined;
  readonly #managedState: ManagedOAuthState;
  #managedService: ReturnType<typeof createManagedOAuth> | undefined;
  readonly #remoteClients = new Set<string>();
  public constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.#namespace = ctx.id.toString();
    this.#grants = new CapabilityState(ctx.storage);
    this.#profiles = new ConnectionState(ctx.storage, () => this.#grants.initialize());
    this.#catalog = new CatalogState(ctx.storage, () => this.#grants.initialize());
    this.#oauthState = new OAuthState(ctx.storage, () => this.#grants.initialize());
    this.#managedState = new ManagedOAuthState(ctx.storage, () => this.#grants.initialize());
    this.#skills = new SkillState(ctx.storage, () => this.#grants.initialize());
    this.#governance = new CentralGovernance(ctx.storage, () => this.#grants.initialize());
    this.#toolsets = new ToolsetState(ctx.storage, () => this.#grants.initialize());
  }

  public async readGrant(clientId: string): Promise<CapabilityGrant | undefined> {
    return this.#grants.readGrant(clientId);
  }
  public async toolVisibility(principal: CapturedIdentity): Promise<CentralToolVisibility> {
    return withinDeadline<CentralToolVisibility>(new AbortController().signal, () => ({ state: "unavailable" }), async (signal, expired) => {
      try {
        const identity = await this.#identity(principal, signal);
        if (expired()) return { state: "unavailable" };
        if (identity.state !== "allowed") return { state: identity.state === "denied" ? "denied" : "unavailable" };
        const grant = parseCapabilityGrant(this.#grants.readGrant(principal.client_id));
        if (!grant?.enabled || grant.client_id !== principal.client_id) return { state: "denied" };
        return { state: "visible", skill: grant.rules.some(rule => rule.kind === "skill"), remote: grant.rules.some(rule => rule.kind === "remote_tool") };
      } catch { return { state: "unavailable" }; }
    });
  }
  public async getToolset(hash: string, id: string): ReturnType<ToolsetAdministration['getToolset']> {
    try {
      if (!isCapabilityIdentifier(id)) return { state: 'invalid' };
      const decision = await this.#authorize(hash, new AbortController().signal);
      if (decision !== 'allowed') return { state: decision };
      const toolset = this.#toolsets.read(id); return toolset ? { state: 'found', toolset } : { state: 'missing' };
    } catch { return { state: 'unavailable' }; }
  }
  public async mutateToolset(hash: string, input: unknown): ReturnType<ToolsetAdministration['mutateToolset']> {
    try {
      const decision = await this.#authorize(hash, new AbortController().signal);
      if (decision !== 'allowed') return { state: decision };
      if (typeof input !== 'object' || input === null || Array.isArray(input)) return { state: 'invalid' };
      const value = input as Record<string, unknown>;
      if (value.action !== 'apply') return this.#toolsets.replace(input);
      if (!isCapabilityIdentifier(value.toolset_id) || !isCapabilityIdentifier(value.client_id)
        || Object.keys(value).some(k => !['action', 'toolset_id', 'client_id', 'toolset_revision', 'expected_revision'].includes(k))
        || !Number.isSafeInteger(value.toolset_revision) || (value.toolset_revision as number) < 1) return { state: 'invalid' };
      const toolset = this.#toolsets.read(value.toolset_id);
      if (!toolset?.enabled) return { state: 'missing' };
      if (toolset.revision !== value.toolset_revision) return { state: 'conflict', current_revision: toolset.revision };
      return this.#grants.replaceGrant({ client_id: value.client_id, enabled: true, expected_revision: value.expected_revision as number, rules: toolset.rules });
    } catch { return { state: 'unavailable' }; }
  }
  public async listCentralReceipts(hash: string): Promise<{ state: "listed"; receipts: CentralAuditRow[] } | { state: "denied" | "unavailable" }> {
    if (this.env.CENTRAL_GOVERNANCE_ENABLED !== "1") return { state: "unavailable" };
    try {
      const decision = await this.#authorize(hash, new AbortController().signal);
      return decision === "allowed" ? { state: "listed", receipts: this.#governance.list() } : { state: decision };
    } catch { return { state: "unavailable" }; }
  }

  #skillService() {
    return createSkillService({ repository: this.#skills, digest: catalogSha256, grant: id => this.#grants.readGrant(id),
      remoteDependency: (target, signal) => {
        const profile = this.#profiles.read(target.connection_profile_id)?.profile;
        if (profile && connectionPolicy(profile, this.env.CENTRAL_MCP_EGRESS) === undefined) return Promise.resolve("disabled");
        return createDependencyReader({ repository: this.#catalog, profile: id => this.#profiles.read(id)?.profile, digest: catalogSha256 })(target, signal);
      },
      identity: (principal, signal) => this.#identity(principal, signal), admin: (hash, signal) => this.#authorize(hash, signal) });
  }
  public async installSkill(hash: string, input: unknown): ReturnType<CentralSkills["installSkill"]> {
    return withinDeadline(new AbortController().signal, () => ({ state: "unknown" } as const),
      signal => this.#skillService().install(hash, input, signal));
  }
  public async mutateSkill(hash: string, input: unknown): ReturnType<CentralSkills["mutateSkill"]> {
    return withinDeadline(new AbortController().signal, () => ({ state: "unknown" } as const),
      signal => this.#skillService().mutate(hash, input, signal));
  }
  public async listSkillLibrary(hash: string, after?: string): ReturnType<CentralSkills["listSkillLibrary"]> {
    return withinDeadline(new AbortController().signal, () => ({ state: "unavailable" } as const),
      signal => this.#skillService().library(hash, after, signal));
  }
  public async inspectSkill(hash: string, id: string, digest?: string): ReturnType<CentralSkills["inspectSkill"]> {
    return withinDeadline(new AbortController().signal, () => ({ state: "unavailable" } as const),
      signal => this.#skillService().inspect(hash, id, digest, signal));
  }
  public async listSkills(principal: CapturedIdentity, query: unknown): ReturnType<CentralSkills["listSkills"]> {
    return withinDeadline(new AbortController().signal, () => ({ state: "unavailable" } as const),
      signal => this.#skillService().list(principal, query, signal));
  }
  public async readSkill(principal: CapturedIdentity, input: unknown): ReturnType<CentralSkills["readSkill"]> {
    return withinDeadline(new AbortController().signal, () => ({ state: "unavailable" } as const),
      signal => this.#skillService().read(principal, input, signal));
  }
  public async replaceGrant(input: GrantReplacement): Promise<GrantWriteResult> {
    return this.#grants.replaceGrant(input);
  }

  public async getClientGrant(hash: string, id: string): ReturnType<CentralManagement["getClientGrant"]> {
    try {
      if (!isCapabilityIdentifier(id)) return { state: "invalid" };
      const decision = await this.#authorize(hash, new AbortController().signal);
      if (decision !== "allowed") return { state: decision };
      const grant = this.#grants.readGrant(id);
      return grant ? { state: "found", grant } : { state: "missing" };
    } catch { return { state: "unavailable" }; }
  }
  public async setClientGrant(hash: string, input: unknown): ReturnType<CentralManagement["setClientGrant"]> {
    try {
      if (typeof input !== "object" || input === null || Array.isArray(input)) return { state: "invalid" };
      const value = input as Record<string, unknown>;
      if (Object.keys(value).some(k => !["client_id", "expected_revision", "enabled", "rules"].includes(k))
        || !Number.isSafeInteger(value.expected_revision) || (value.expected_revision as number) < 0 || (value.expected_revision as number) >= Number.MAX_SAFE_INTEGER) return { state: "invalid" };
      const grant = parseCapabilityGrant({ ...value, schema_version: 1, revision: (value.expected_revision as number) + 1 });
      if (!grant) return { state: "invalid" };
      const decision = await this.#authorize(hash, new AbortController().signal);
      if (decision !== "allowed") return { state: decision };
      // Grants remain exact immutable capability references. Approval and actual
      // execution checks are independent; granting cannot approve content.
      return this.#grants.replaceGrant({ client_id: grant.client_id, expected_revision: value.expected_revision as number, enabled: grant.enabled, rules: grant.rules });
    } catch { return { state: "unavailable" }; }
  }
  public async listProfiles(hash: string, after?: string): ReturnType<CentralManagement["listProfiles"]> {
    try {
      if (after !== undefined && !isCapabilityIdentifier(after)) return { state: "invalid" };
      const decision = await this.#authorize(hash, new AbortController().signal);
      if (decision !== "allowed") return { state: decision };
      return { state: "listed", ...this.#profiles.list(after) };
    } catch { return { state: "unavailable" }; }
  }

  async #authorize(sessionHash: string, signal: AbortSignal): Promise<AdminDecision> {
    if (typeof sessionHash !== "string" || !/^[a-f0-9]{64}$/u.test(sessionHash)) return "denied";
    if (signal.aborted) return "unavailable";
    const response = await boundedJsonResponse(local => registryRequest(this.env, "/auth/sessions/verify", "POST",
      JSON.stringify({ session_hash: sessionHash }), AbortSignal.any([signal, local])));
    if (signal.aborted || response === undefined) return "unavailable";
    if ([401, 403, 404].includes(response.status)) return "denied";
    if (response.status !== 200 || typeof response.value !== "object" || response.value === null || Array.isArray(response.value)) return "unavailable";
    const csrf = (response.value as Record<string, unknown>).csrf_hash;
    return typeof csrf === "string" && /^[a-f0-9]{64}$/u.test(csrf) ? "allowed" : "unavailable";
  }

  public async getProfile(sessionHash: string, profileId: string): ReturnType<CentralAdministration["getProfile"]> {
    if (!isCapabilityIdentifier(profileId)) return { state: "missing" };
    try {
      const admission = await this.#authorize(sessionHash, new AbortController().signal);
      if (admission !== "allowed") return { state: admission };
      const record = this.#profiles.read(profileId);
      return record === undefined ? { state: "missing" } : { state: "found", profile: record.profile };
    } catch { return { state: "unavailable" }; }
  }

  public async mutateProfile(sessionHash: string, command: unknown): Promise<ProfileResult> {
    const cipher = createCredentialCipher(this.#namespace, () => this.env.CENTRAL_VAULT_KEYRING,
      () => [this.env.INTERNAL_CONTROL_SECRET, this.env.RUNNER_TOKEN_PEPPER]);
    return createProfileManager({ repository: this.#profiles, cipher,
      authorize: signal => this.#authorize(sessionHash, signal) }).mutate(command, new AbortController().signal);
  }

  #catalogManager(sessionHash: string) {
    return createCatalogManager({ repository: this.#catalog, profile: id => this.#profiles.read(id)?.profile,
      authorize: signal => this.#authorize(sessionHash, signal), digest: catalogSha256 });
  }

  public async mutateCatalog(sessionHash: string, command: unknown): Promise<CatalogMutation> {
    // A deadline after dispatch cannot prove that an owner-local mutation did not run.
    return withinDeadline<CatalogMutation>(new AbortController().signal, () => ({ state: "unknown" }),
      (signal, expired) => this.#catalogManager(sessionHash).mutate(command, signal, expired));
  }

  public async getCatalog(sessionHash: string, profileId: string, digest?: string): Promise<CatalogInspection> {
    return withinDeadline<CatalogInspection>(new AbortController().signal, () => ({ state: "unavailable" }),
      (signal, expired) => this.#catalogManager(sessionHash).inspect(profileId, digest, signal, expired));
  }

  async #identity(principal: CapturedIdentity, signal: AbortSignal): Promise<IdentityDecision> {
    const response = await boundedJsonResponse(local => registryRequest(this.env, "/auth/mcp/revalidate", "POST",
      JSON.stringify({ client_id: principal.client_id, secret_version: principal.secret_version, identity_version: 2 }), AbortSignal.any([signal, local])));
    if (signal.aborted || response === undefined) return { state: "unavailable" };
    if ([401, 403, 404].includes(response.status)) return { state: "denied" };
    if (response.status !== 200) return { state: "unavailable" };
    const identity = parseClientIdentity(response.value);
    if (identity === undefined) return { state: "malformed" };
    return identity.client_id !== principal.client_id || identity.secret_version !== principal.secret_version
      ? { state: "denied" } : { state: "allowed", identity };
  }

  /** Internal reader for the later remote MCP provider; never selects a Runner. */
  public async listDirectory(principal: CapturedIdentity): Promise<CentralDirectory> {
    const read = createDirectoryReader({ repository: this.#catalog, profile: id => this.#profiles.read(id)?.profile,
      grant: id => this.#grants.readGrant(id), identity: (value, signal) => this.#identity(value, signal), digest: catalogSha256,
      cursor: createCatalogCursor(this.#namespace, () => this.#catalog.cursorKey()), now: Date.now });
    return withinDeadline<CentralDirectory>(new AbortController().signal, () => ({ state: "unavailable" }), (signal, expired) => read(principal, signal, expired));
  }

  /** Per-profile discovery remains available for larger direct directories. */
  public async listCatalog(principal: CapturedIdentity, query: unknown): Promise<CatalogPage> {
    const read = createCatalogReader({ repository: this.#catalog, profile: id => this.#profiles.read(id)?.profile,
      grant: id => this.#grants.readGrant(id), identity: (value, signal) => this.#identity(value, signal), digest: catalogSha256,
      cursor: createCatalogCursor(this.#namespace, () => this.#catalog.cursorKey()), now: Date.now });
    return withinDeadline<CatalogPage>(new AbortController().signal, () => ({ state: "unavailable" }),
      (signal, expired) => read(principal, query, signal, expired));
  }

  #oauthManager() {
    if (this.#oauthService === undefined) this.#oauthService = createOAuthManager({
      repository: this.#oauthState,
      cipher: createOAuthCipher(this.#namespace, () => this.env.CENTRAL_VAULT_KEYRING,
        () => [this.env.INTERNAL_CONTROL_SECRET, this.env.RUNNER_TOKEN_PEPPER]),
      transport: createOAuthTransport(),
      profile: id => this.#profiles.read(id)?.profile,
      policy: id => {
        const policy = parseOAuthPolicies(this.env.CENTRAL_OAUTH_POLICIES)?.find(p => p.profile_id === id);
        if (policy === undefined) return undefined;
        if ([policy.resource, policy.issuer, policy.authorization_endpoint, policy.token_endpoint].some(url => new URL(url).origin === this.env.RUNMESH_PUBLIC_ORIGIN)) return undefined;
        return policy;
      },
      redirect: () => {
        try {
          const origin = this.env.RUNMESH_PUBLIC_ORIGIN, url = new URL(origin ?? "");
          return url.protocol === "https:" && !url.port && origin === url.origin
            ? origin + "/admin/central/oauth/callback" : undefined;
        } catch { return undefined; }
      },
      admin: (hash, signal) => this.#authorize(hash, signal),
      identity: (principal, signal) => this.#identity(principal, signal),
      hash: catalogSha256, random: oauthRandom, challenge: oauthChallenge, now: Date.now,
    });
    return this.#oauthService;
  }

  public async beginOAuth(sessionHash: string, input: unknown): Promise<OAuthResult> {
    if (parseOAuthPolicies(this.env.CENTRAL_OAUTH_POLICIES) === undefined) return { state: "failed", code: "disabled", operation_state: "not_started" };
    return this.#oauthManager().begin(sessionHash, input, new AbortController().signal);
  }
  public async completeOAuth(sessionHash: string, input: unknown): Promise<OAuthResult> {
    if (parseOAuthPolicies(this.env.CENTRAL_OAUTH_POLICIES) === undefined) return { state: "failed", code: "disabled", operation_state: "not_started" };
    return this.#oauthManager().complete(sessionHash, input, new AbortController().signal);
  }
  public async inspectOAuth(sessionHash: string, input: unknown): Promise<OAuthResult> {
    return this.#oauthManager().inspect(sessionHash, input, new AbortController().signal);
  }
  public async revokeOAuth(sessionHash: string, input: unknown): Promise<OAuthResult> {
    // Local revocation remains available without provider configuration or a vault key.
    return this.#oauthManager().revoke(sessionHash, input, new AbortController().signal);
  }

  #managedOAuth() {
    if (!this.#managedService) this.#managedService = createManagedOAuth({ repository: this.#managedState, protocol: createManagedOAuthProtocol(),
      cipher: createOAuthCipher(this.#namespace, () => this.env.CENTRAL_VAULT_KEYRING, () => [this.env.INTERNAL_CONTROL_SECRET, this.env.RUNNER_TOKEN_PEPPER]),
      profile: id => this.#profiles.read(id)?.profile, admin: (hash, signal) => this.#authorize(hash, signal),
      origin: () => this.env.RUNMESH_PUBLIC_ORIGIN, hash: catalogSha256, random: oauthRandom, now: Date.now });
    return this.#managedService;
  }
  public async connectionOAuth(hash: string, action: "begin" | "complete" | "revoke", input: unknown, requestOrigin?: string): ReturnType<ManagedConnections["connectionOAuth"]> {
    return this.#managedOAuth().run(hash, action, input, requestOrigin);
  }

  #remoteConnector(principal?: CapturedIdentity) {
    const cipher = createCredentialCipher(this.#namespace, () => this.env.CENTRAL_VAULT_KEYRING,
      () => [this.env.INTERNAL_CONTROL_SECRET, this.env.RUNNER_TOKEN_PEPPER]);
    return createHttpRemoteConnector({ policy: () => this.env.CENTRAL_MCP_EGRESS,
      rules: profile => { const current = this.#profiles.read(profile.profile_id)?.profile; return current?.revision === profile.revision && current.enabled ? connectionPolicy(current, this.env.CENTRAL_MCP_EGRESS) : undefined; },
      ...(this.env.RUNMESH_PUBLIC_ORIGIN === undefined ? {} : { selfOrigin: this.env.RUNMESH_PUBLIC_ORIGIN }),
      credential: async (profile, signal, authorize) => {
        const record = this.#profiles.read(profile.profile_id);
        if (record?.profile.revision !== profile.revision || !record.profile.enabled || record.profile.endpoint !== profile.endpoint)
          throw new RemoteFault("permission_denied");
        if (record.profile.authentication === "none") return null;
        if (record.profile.authentication === "oauth") {
          try { return await this.#managedOAuth().credential(profile, signal, authorize); }
          catch { throw new RemoteFault("authorization_required"); }
        }
        if (record.profile.credential === null) {
          if (principal === undefined) throw new RemoteFault("authorization_required");
          try { return await this.#oauthManager().credential(profile, principal, signal, authorize); }
          catch (error) {
            if (error instanceof RemoteFault) throw error;
            throw new RemoteFault(error instanceof OAuthFault && error.code === "denied" ? "permission_denied"
              : error instanceof OAuthFault && error.code === "capacity" ? "busy"
              : error instanceof OAuthFault && ["disabled", "reauthorization_required"].includes(error.code) ? "authorization_required" : "dependency_unavailable");
          }
        }
        if (record.envelope === null) throw new RemoteFault("dependency_unavailable");
        const credential = await cipher.open(record.profile, record.envelope);
        const latest = this.#profiles.read(profile.profile_id)?.profile;
        if (latest?.revision !== profile.revision || !latest.enabled || latest.credential?.secret_version !== profile.credential?.secret_version)
          throw new RemoteFault("permission_denied");
        return credential;
      } });
  }

  /** In-memory admission bounds active work on this owner; no persistent queues,
   * restart replay or exactly-once remote execution is implied. */
  public async callRemote(principal: CapturedIdentity, command: unknown): Promise<RemoteOutcome> {
    if (!isCapabilityIdentifier(principal?.client_id) || !Number.isSafeInteger(principal.secret_version) || principal.secret_version < 1)
      return { state: "failed", code: "invalid_request", operation_state: "not_started" };
    const key = "client:" + principal.client_id;
    if (this.#remoteClients.has(key) || this.#remoteClients.size >= REMOTE_LIMITS.active) return { state: "failed", code: "busy", operation_state: "not_started" };
    this.#remoteClients.add(key);
    try {
      return await createRemoteCaller({ repository: this.#catalog, profile: id => this.#profiles.read(id)?.profile,
        grant: id => this.#grants.readGrant(id), identity: (value, signal) => this.#identity(value, signal),
        digest: catalogSha256, connector: this.#remoteConnector(principal),
        ...(this.env.CENTRAL_GOVERNANCE_ENABLED === "1" ? { observation: this.#governance } : {}) })(principal, command, new AbortController().signal);
    } finally { this.#remoteClients.delete(key); }
  }

  public async discoverRemote(sessionHash: string, profileId: string, expectedRevision: number, principal?: CapturedIdentity): Promise<CatalogMutation | RemoteFailure> {
    if (typeof sessionHash !== "string" || !/^[a-f0-9]{64}$/u.test(sessionHash)) return { state: "denied" };
    if (principal !== undefined && parseOAuthSelection({ profile_id: profileId, principal, expected_revision: expectedRevision }) === undefined) return { state: "invalid" };
    const key = "admin:" + sessionHash;
    if (this.#remoteClients.has(key) || this.#remoteClients.size >= REMOTE_LIMITS.active) return { state: "failed", code: "busy", operation_state: "not_started" };
    this.#remoteClients.add(key);
    try {
      return await createRemoteDiscovery({ repository: this.#catalog, profile: id => this.#profiles.read(id)?.profile,
        authorize: async signal => {
          const admin = await this.#authorize(sessionHash, signal);
          if (admin !== "allowed" || principal === undefined) return admin;
          const identity = await this.#identity(principal, signal);
          return identity.state === "allowed" ? "allowed" : identity.state === "denied" ? "denied" : "unavailable";
        }, digest: catalogSha256,
        connector: this.#remoteConnector(principal) })(profileId, expectedRevision, new AbortController().signal);
    } finally { this.#remoteClients.delete(key); }
  }

  public override async fetch(): Promise<Response> {
    return new Response("not found", { status: 404 });
  }
}
