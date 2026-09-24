import type { CatalogAdminPorts, CatalogMutation } from "../../contracts/catalog.js";
import { RemoteFault, type RemoteConnector, type RemoteFailure, type RemoteSession } from "../../contracts/remote.js";
import { isCapabilityIdentifier } from "../../contracts/capabilities.js";
import { catalogRevision } from "../../contracts/catalog-json.js";
import { parseProfile } from "../../contracts/connector-values.js";
import { createCatalogManager } from "./catalog-admin.js";
import { remoteDeadline } from "./remote-deadline.js";

/** Complete, bounded discovery stages a candidate, never an approval. Partial
 * pages and failed observations leave the previously reviewed state intact. */
export function createRemoteDiscovery(ports: CatalogAdminPorts & { readonly connector: RemoteConnector }) {
  return async (profileId: string, expectedRevision: number, parent: AbortSignal): Promise<CatalogMutation | RemoteFailure> => {
    if (!isCapabilityIdentifier(profileId) || !catalogRevision(expectedRevision, true)) return { state: "invalid" };
    let staging = false;
    return remoteDeadline<CatalogMutation | RemoteFailure>(parent, () => ({ state: staging ? "unknown" : "unavailable" }), async (signal, expired) => {
      let session: RemoteSession | undefined;
      try {
        const admission = await ports.authorize(signal);
        if (expired()) return { state: "unavailable" };
        if (admission !== "allowed") return { state: admission };
        const profile = parseProfile(ports.profile(profileId));
        if (profile === undefined || profile.profile_id !== profileId || !profile.enabled) return { state: "denied" };
        if ((ports.repository.readHead(profileId)?.revision ?? 0) !== expectedRevision)
          return { state: "conflict", current_revision: ports.repository.readHead(profileId)?.revision ?? 0 };
        const fence = async () => {
          const current = await ports.authorize(signal);
          if (expired()) throw new RemoteFault("operation_timed_out");
          if (current !== "allowed") throw new RemoteFault(current === "denied" ? "permission_denied" : "dependency_unavailable");
          const latest = ports.profile(profileId);
          if (latest?.revision !== profile.revision || !latest.enabled || latest.endpoint !== profile.endpoint
            || (ports.repository.readHead(profileId)?.revision ?? 0) !== expectedRevision) throw new RemoteFault("stale_catalog");
        };
        session = await ports.connector.open(profile, signal, () => { throw new RemoteFault("upstream_protocol_error"); }, fence);
        const tools = await session.listTools();
        if (expired()) return { state: "unavailable" };
        await fence();
        const manager = createCatalogManager({ ...ports, profile: id => {
          const current = ports.profile(id);
          return current?.revision === profile.revision && current.enabled && current.endpoint === profile.endpoint ? current : undefined;
        } });
        staging = true;
        return await manager.mutate({ action: "stage", profile_id: profileId, expected_revision: expectedRevision, tools }, signal, expired);
      } catch (error) {
        return { state: "failed", code: error instanceof RemoteFault ? error.code : "dependency_unavailable", operation_state: staging ? "unknown" : "not_started" };
      } finally { await session?.close().catch(() => undefined); }
    });
  };
}
