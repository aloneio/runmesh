import { DurableObject } from "cloudflare:workers";
import type { CapabilityGrant, GrantReplacement, GrantWriteResult } from "../../contracts/capabilities.js";
import { CapabilityState } from "./store.js";

/** Internal state adapter, reachable only through a trusted Worker binding.
 * No public HTTP API, caller authentication policy, plaintext vault or Runner state.
 * Construction performs no storage I/O. Public activation is not part of this batch. */
export class CapabilitiesDOv1 extends DurableObject<unknown> {
  private readonly repository: CapabilityState;
  public constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.repository = new CapabilityState(ctx.storage);
  }

  public async readGrant(clientId: string): Promise<CapabilityGrant | undefined> {
    return this.repository.readGrant(clientId);
  }

  public async replaceGrant(input: GrantReplacement): Promise<GrantWriteResult> {
    return this.repository.replaceGrant(input);
  }

  public override async fetch(): Promise<Response> {
    return new Response("not found", { status: 404 });
  }
}
