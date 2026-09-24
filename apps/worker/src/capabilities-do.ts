import { DurableObject } from "cloudflare:workers";
import type { AdminDecision, CentralAdministration, ProfileResult } from "./contracts/connectors.js";
import type { CapabilityGrant, GrantReplacement, GrantWriteResult } from "./contracts/capabilities.js";
import { isCapabilityIdentifier } from "./contracts/capabilities.js";
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
import { withinDeadline } from "./application/connectors/deadline.js";

/** Reviewed composition root. Feature repositories never import each other.
 * Binding-only APIs return metadata, never decrypted credentials. No public fetch API. */
export class CapabilitiesDOv1 extends DurableObject<WorkerEnv> implements CentralAdministration, CatalogAdministration {
  readonly #grants: CapabilityState;
  readonly #profiles: ConnectionState;
  readonly #namespace: string;
  readonly #catalog: CatalogState;
  public constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.#namespace = ctx.id.toString();
    this.#grants = new CapabilityState(ctx.storage);
    this.#profiles = new ConnectionState(ctx.storage, () => this.#grants.initialize());
    this.#catalog = new CatalogState(ctx.storage, () => this.#grants.initialize());
  }

  public async readGrant(clientId: string): Promise<CapabilityGrant | undefined> {
    return this.#grants.readGrant(clientId);
  }
  public async replaceGrant(input: GrantReplacement): Promise<GrantWriteResult> {
    return this.#grants.replaceGrant(input);
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
  public async listCatalog(principal: CapturedIdentity, query: unknown): Promise<CatalogPage> {
    const read = createCatalogReader({ repository: this.#catalog, profile: id => this.#profiles.read(id)?.profile,
      grant: id => this.#grants.readGrant(id), identity: (value, signal) => this.#identity(value, signal), digest: catalogSha256,
      cursor: createCatalogCursor(this.#namespace, () => this.#catalog.cursorKey()), now: Date.now });
    return withinDeadline<CatalogPage>(new AbortController().signal, () => ({ state: "unavailable" }),
      (signal, expired) => read(principal, query, signal, expired));
  }

  public override async fetch(): Promise<Response> {
    return new Response("not found", { status: 404 });
  }
}
