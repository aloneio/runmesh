import { DurableObject } from "cloudflare:workers";
import { createOAuthCipher, oauthRandom } from "./platform/connectors/oauth-crypto.js";
import { createManagedOAuthProtocol } from "./platform/connectors/managed-oauth.js";
import { createManagedOAuth } from './application/connectors/managed-oauth.js';
import { ManagedOAuthState } from "./platform/connectors/managed-store.js";
import type { ManagedConnections } from "./contracts/managed-connections.js";
import type { AdminDecision, CentralAdministration, ProfileResult } from "./contracts/connectors.js";
import type { CentralToolVisibility } from "./contracts/capabilities.js";
import { isCapabilityIdentifier } from "./contracts/capabilities.js";
import type { CentralManagement } from "./contracts/central-management.js";
import { CentralSchema } from "./platform/capabilities/schema.js";
import { ConnectionState } from "./platform/connectors/store.js";
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
import { createSharedProfileReader } from "./application/capabilities/profile-read.js";
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

/** Reviewed composition root. Feature repositories never import each other.
 * Binding-only APIs return metadata, never decrypted credentials. No public fetch API. */
export class CapabilitiesDOv1 extends DurableObject<WorkerEnv> implements CentralAdministration, CatalogAdministration, CentralRemote {
  readonly #schema: CentralSchema;
  readonly #profiles: ConnectionState;
  readonly #namespace: string;
  readonly #catalog: CatalogState;
  readonly #skills: SkillState;
  readonly #governance: CentralGovernance;
  readonly #managedState: ManagedOAuthState;
  #managedService: ReturnType<typeof createManagedOAuth> | undefined;
  readonly #remoteClients = new Set<string>();
  public constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.#namespace = ctx.id.toString();
    this.#schema = new CentralSchema(ctx.storage);
    this.#profiles = new ConnectionState(ctx.storage, () => this.#schema.initialize());
    this.#catalog = new CatalogState(ctx.storage, () => this.#schema.initialize());
    this.#managedState = new ManagedOAuthState(ctx.storage, () => this.#schema.initialize());
    this.#skills = new SkillState(ctx.storage, () => this.#schema.initialize());
    this.#governance = new CentralGovernance(ctx.storage, () => this.#schema.initialize());
  }

  public async toolVisibility(principal: CapturedIdentity): Promise<CentralToolVisibility> {
    return withinDeadline<CentralToolVisibility>(new AbortController().signal, () => ({ state: "unavailable" }), async (signal, expired) => {
      try {
        const identity = await this.#identity(principal, signal);
        if (expired()) return { state: "unavailable" };
        if (identity.state !== "allowed") return { state: identity.state === "denied" ? "denied" : "unavailable" };
        return { state: "visible", skill: this.env.CENTRAL_SKILLS_ENABLED === "1", remote: true };
      } catch { return { state: "unavailable" }; }
    });
  }
  public async listCentralReceipts(hash: string): Promise<{ state: "listed"; receipts: CentralAuditRow[] } | { state: "denied" | "unavailable" }> {
    if (this.env.CENTRAL_GOVERNANCE_ENABLED !== "1") return { state: "unavailable" };
    try {
      const decision = await this.#authorize(hash, new AbortController().signal);
      return decision === "allowed" ? { state: "listed", receipts: this.#governance.list() } : { state: decision };
    } catch { return { state: "unavailable" }; }
  }

  #skillService() {
    return createSkillService({ repository: this.#skills, digest: catalogSha256,
      remoteDependency: (target, signal) => {
        const profile = this.#profiles.read(target.connection_profile_id)?.profile;
        if (profile && connectionPolicy(profile) === undefined) return Promise.resolve("disabled");
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
    return createProfileManager({ repository: this.#profiles,
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
    const read = createDirectoryReader({ profiles: after => this.#profiles.list(after), repository: this.#catalog, profile: id => this.#profiles.read(id)?.profile,
      identity: (value, signal) => this.#identity(value, signal), digest: catalogSha256,
      cursor: createCatalogCursor(this.#namespace, () => this.#catalog.cursorKey()), now: Date.now });
    return withinDeadline<CentralDirectory>(new AbortController().signal, () => ({ state: "unavailable" }), (signal, expired) => read(principal, signal, expired));
  }

  /** Per-profile discovery remains available for larger direct directories. */
  public async listRemoteProfiles(principal: CapturedIdentity): ReturnType<CentralRemote["listRemoteProfiles"]> {
    const read = createSharedProfileReader({ repository: this.#catalog, profiles: after => this.#profiles.list(after),
      identity: (value, signal) => this.#identity(value, signal) });
    return withinDeadline(new AbortController().signal, () => ({ state: "unavailable" } as const), signal => read(principal, signal));
  }

  public async listCatalog(principal: CapturedIdentity, query: unknown): Promise<CatalogPage> {
    const read = createCatalogReader({ repository: this.#catalog, profile: id => this.#profiles.read(id)?.profile,
      identity: (value, signal) => this.#identity(value, signal), digest: catalogSha256,
      cursor: createCatalogCursor(this.#namespace, () => this.#catalog.cursorKey()), now: Date.now });
    return withinDeadline<CatalogPage>(new AbortController().signal, () => ({ state: "unavailable" }),
      (signal, expired) => read(principal, query, signal, expired));
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

  #remoteConnector() {
    return createHttpRemoteConnector({
      rules: profile => { const current = this.#profiles.read(profile.profile_id)?.profile; return current?.revision === profile.revision && current.enabled ? connectionPolicy(current) : undefined; },
      ...(this.env.RUNMESH_PUBLIC_ORIGIN === undefined ? {} : { selfOrigin: this.env.RUNMESH_PUBLIC_ORIGIN }),
      credential: async (profile, signal, authorize) => {
        const record = this.#profiles.read(profile.profile_id);
        if (record?.profile.revision !== profile.revision || !record.profile.enabled || record.profile.endpoint !== profile.endpoint)
          throw new RemoteFault("permission_denied");
        if (record.profile.authentication === "none") return null;
        try { return await this.#managedOAuth().credential(profile, signal, authorize); }
        catch { throw new RemoteFault("authorization_required"); }
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
        identity: (value, signal) => this.#identity(value, signal),
        digest: catalogSha256, connector: this.#remoteConnector(),
        ...(this.env.CENTRAL_GOVERNANCE_ENABLED === "1" ? { observation: this.#governance } : {}) })(principal, command, new AbortController().signal);
    } finally { this.#remoteClients.delete(key); }
  }

  public async discoverRemote(sessionHash: string, profileId: string, expectedRevision: number): Promise<CatalogMutation | RemoteFailure> {
    if (typeof sessionHash !== "string" || !/^[a-f0-9]{64}$/u.test(sessionHash)) return { state: "denied" };
    const key = "admin:" + sessionHash;
    if (this.#remoteClients.has(key) || this.#remoteClients.size >= REMOTE_LIMITS.active) return { state: "failed", code: "busy", operation_state: "not_started" };
    this.#remoteClients.add(key);
    try {
      return await createRemoteDiscovery({ repository: this.#catalog, profile: id => this.#profiles.read(id)?.profile,
        authorize: signal => this.#authorize(sessionHash, signal), digest: catalogSha256,
        connector: this.#remoteConnector() })(profileId, expectedRevision, new AbortController().signal);
    } finally { this.#remoteClients.delete(key); }
  }

  public override async fetch(): Promise<Response> {
    return new Response("not found", { status: 404 });
  }
}
