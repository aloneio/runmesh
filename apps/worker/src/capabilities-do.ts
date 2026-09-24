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

/** Reviewed composition root. Feature repositories never import each other.
 * Binding-only APIs return metadata, never decrypted credentials. No public fetch API. */
export class CapabilitiesDOv1 extends DurableObject<WorkerEnv> implements CentralAdministration {
  readonly #grants: CapabilityState;
  readonly #profiles: ConnectionState;
  readonly #namespace: string;
  public constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.#namespace = ctx.id.toString();
    this.#grants = new CapabilityState(ctx.storage);
    this.#profiles = new ConnectionState(ctx.storage, () => this.#grants.initialize());
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

  public override async fetch(): Promise<Response> {
    return new Response("not found", { status: 404 });
  }
}
