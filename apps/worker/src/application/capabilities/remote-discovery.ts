import type { CatalogAdminPorts } from "../../contracts/catalog.js";
import { RemoteFault, type RemoteConnector, type RemoteSession, type RemoteDiscoveryResult } from "../../contracts/remote.js";
import { isCapabilityIdentifier } from "../../contracts/capabilities.js";
import { catalogRevision } from "../../contracts/catalog-json.js";
import { parseProfile } from "../../contracts/connector-values.js";
import { createCatalogManager } from "./catalog-admin.js";
import { buildCatalogSnapshot } from "../../domain/capabilities/catalog.js";
import { remoteDeadline } from "./remote-deadline.js";

/** Initial discovery preserves the existing connect-and-publish flow. Subsequent
 * refreshes stage provider changes for explicit approval. Failed or incomplete
 * observations never replace a published definition. */
export function createRemoteDiscovery(ports: CatalogAdminPorts & { readonly connector: RemoteConnector }) {
  return async (profileId: string, expectedRevision: number, parent: AbortSignal): Promise<RemoteDiscoveryResult> => {
    if (!isCapabilityIdentifier(profileId) || !catalogRevision(expectedRevision, true)) return { state: "invalid" };
    let publishing = false;
    return remoteDeadline<RemoteDiscoveryResult>(parent, () => ({ state: publishing ? "unknown" : "unavailable" }), async (signal, expired) => {
      let session: RemoteSession | undefined;
      try {
        const admission = await ports.authorize(signal);
        if (expired()) return { state: "unavailable" };
        if (admission !== "allowed") return { state: admission };
        const profile = parseProfile(ports.profile(profileId));
        if (profile === undefined || profile.profile_id !== profileId || !profile.enabled) return { state: "denied" };
        const existing = ports.repository.readHead(profileId);
        if ((existing?.revision ?? 0) !== expectedRevision)
          return { state: "conflict", current_revision: existing?.revision ?? 0 };
        const fence = async () => {
          const current = await ports.authorize(signal);
          if (expired()) throw new RemoteFault("operation_timed_out");
          if (current !== "allowed") throw new RemoteFault(current === "denied" ? "permission_denied" : "dependency_unavailable");
          const latest = ports.profile(profileId);
          if (latest?.revision !== profile.revision || !latest.enabled || latest.endpoint !== profile.endpoint
            || (ports.repository.readHead(profileId)?.revision ?? 0) !== expectedRevision) throw new RemoteFault("stale_catalog");
        };
        session = await ports.connector.open(profile, signal, () => { throw new RemoteFault("upstream_protocol_error"); }, fence);
        const tools = await session.listTools(), excluded = session.issues?.() ?? [];
        if (expired()) return { state: "unavailable" };
        // Publication changes the catalog revision used by session cleanup.
        // Close first, then revalidate admission after that asynchronous wait.
        const completedSession = session; session = undefined;
        await completedSession.close().catch(() => undefined);
        await fence();
        if (!completedSession.current()) throw new RemoteFault("result_withheld");
        const manager = createCatalogManager({ ...ports, authorize: async signal => {
          const decision = await ports.authorize(signal);
          return decision === "allowed" && !completedSession.current() ? "denied" : decision;
        }, profile: id => {
          const current = ports.profile(id);
          return current?.revision === profile.revision && current.enabled && current.endpoint === profile.endpoint ? current : undefined;
        } });
        // Avoid a storage write and cursor invalidation for identical live
        // tools, including when a previously staged review is still pending.
        const orderedTools = [...tools].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        const candidate = await buildCatalogSnapshot(profile, orderedTools, ports.digest, expired);
        if (candidate === undefined || expired()) return { state: "unavailable" };
        await fence();
        // A credential or egress revision can change while hashing. This is
        // an explicit pre-publication denial, not a dispatched tool failure.
        if (!completedSession.current()) return { state: "denied" };
        if (existing?.observed_digest === candidate.digest) return { state: "unchanged", head: existing,
          ...(excluded.length ? { excluded_tools: excluded } : {}) };
        publishing = true;
        const result = await manager.mutate({ action: existing === undefined ? "publish" : "stage",
          profile_id: profileId, expected_revision: expectedRevision, tools }, signal, expired);
        return result.state === "written" && excluded.length ? { ...result, excluded_tools: excluded } : result;
      } catch (error) {
        return { state: "failed", code: error instanceof RemoteFault ? error.code : "dependency_unavailable", operation_state: publishing ? "unknown" : "not_started" };
      } finally { await session?.close().catch(() => undefined); }
    });
  };
}
