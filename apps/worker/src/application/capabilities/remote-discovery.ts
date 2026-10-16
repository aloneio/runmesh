import type { CatalogAdminPorts } from "../../contracts/catalog.js";
import { RemoteFault, type RemoteConnector, type RemoteSession, type RemoteDiscoveryResult } from "../../contracts/remote.js";
import { isCapabilityIdentifier } from "../../contracts/capabilities.js";
import { catalogRevision } from "../../contracts/catalog-json.js";
import { parseProfile } from "../../contracts/connector-values.js";
import type { ConnectionProfile } from "../../contracts/connectors.js";
import { createCatalogManager } from "./catalog-admin.js";
import { buildCatalogSnapshot } from "../../domain/capabilities/catalog.js";
import { remoteDeadline } from "./remote-deadline.js";
import { recoverableCatalogRevision } from "./catalog-revision-recovery.js";

class CatalogVersionChanged extends Error {
  public constructor(readonly currentRevision: number) { super("catalog_version_changed"); }
}

/** Full, bounded discovery publishes compatible tools atomically on initial
 * connection and subsequent refreshes, without a separate approval step.
 * Incomplete observations retain the last working catalog. */
export function createRemoteDiscovery(ports: CatalogAdminPorts & { readonly connector: RemoteConnector }) {
  return async (profileId: string, expectedRevision: number, parent: AbortSignal): Promise<RemoteDiscoveryResult> => {
    if (!isCapabilityIdentifier(profileId) || !catalogRevision(expectedRevision, true)) return { state: "invalid" };
    let publishing = false;
    const originalRevision = expectedRevision;
    return remoteDeadline<RemoteDiscoveryResult>(parent, () => ({ state: publishing ? "unknown" : "unavailable" }), async (signal, expired) => {
      // A confirmed version conflict can trigger one additional fresh discovery,
      // never an upstream tools/call or an unbounded polling loop.
      const attempt = async (expectedRevision: number, recovered: boolean): Promise<RemoteDiscoveryResult> => {
        let session: RemoteSession | undefined;
        let openedProfile: ConnectionProfile | undefined;
        const safeRebase = async (profile: ConnectionProfile, currentRevision: number) => {
          const next = recovered || expired() || !catalogRevision(currentRevision, true) ? undefined
            : await recoverableCatalogRevision(ports, profile, expectedRevision, expired);
          return next === currentRevision ? next : undefined;
        };
        try {
          const admission = await ports.authorize(signal);
          if (expired()) return { state: "unavailable" };
          if (admission !== "allowed") return { state: admission };
          const profile = parseProfile(ports.profile(profileId));
          if (profile === undefined || profile.profile_id !== profileId || !profile.enabled) return { state: "denied" };
          openedProfile = profile;
          const existing = ports.repository.readHead(profileId);
          if ((existing?.revision ?? 0) !== expectedRevision) {
            const next = await safeRebase(profile, existing?.revision ?? 0);
            return next === undefined ? { state: "conflict", current_revision: existing?.revision ?? 0 } : attempt(next, true);
          }
          const fence = async () => {
            const current = await ports.authorize(signal);
            if (expired()) throw new RemoteFault("operation_timed_out");
            if (current !== "allowed") throw new RemoteFault(current === "denied" ? "permission_denied" : "dependency_unavailable");
            const latest = ports.profile(profileId);
            if (latest?.revision !== profile.revision || !latest.enabled || latest.endpoint !== profile.endpoint
              || latest.connector_id !== profile.connector_id) throw new RemoteFault("stale_catalog");
            const currentRevision = ports.repository.readHead(profileId)?.revision ?? 0;
            if (currentRevision !== expectedRevision) throw new CatalogVersionChanged(currentRevision);
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
          // Avoid redundant writes only if the latest observation is fully
          // published. An older staged or partially approved snapshot must
          // advance to a complete publication even when its digest is unchanged.
          const orderedTools = [...tools].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
          const candidate = await buildCatalogSnapshot(profile, orderedTools, ports.digest, expired);
          if (candidate === undefined || expired()) return { state: "unavailable" };
          await fence();
          // A credential or egress revision can change while hashing. This is
          // an explicit pre-publication denial, not a dispatched tool failure.
          if (!completedSession.current()) return { state: "denied" };
          const fullyPublished = existing?.observed_digest === candidate.digest
            && existing.approved_digest === candidate.digest
            && existing.approved_names.length === candidate.tools.length
            && candidate.tools.every(tool => existing.approved_names.includes(tool.definition.name));
          const recoveredReceipt = recovered ? { recovered_from_revision: originalRevision } : {};
          if (fullyPublished) return { state: "unchanged", head: existing, ...recoveredReceipt,
            ...(excluded.length ? { excluded_tools: excluded } : {}) };
          publishing = true;
          const result = await manager.mutate({ action: "publish",
            profile_id: profileId, expected_revision: expectedRevision, tools }, signal, expired);
          if (result.state === "conflict") {
            // Only a confirmed CAS rejection can be retried: no mutation ran.
            publishing = false;
            const next = await safeRebase(profile, result.current_revision);
            if (next !== undefined) return attempt(next, true);
          }
          return result.state === "written" ? { ...result, ...recoveredReceipt,
            ...(excluded.length ? { excluded_tools: excluded } : {}) } : result;
        } catch (error) {
          if (error instanceof CatalogVersionChanged) {
            const next = openedProfile === undefined ? undefined : await safeRebase(openedProfile, error.currentRevision);
            if (next !== undefined) {
              // Release the superseded session before opening another one.
              await session?.close().catch(() => undefined);
              session = undefined;
              return attempt(next, true);
            }
            return { state: "conflict", current_revision: error.currentRevision };
          }
          return { state: "failed", code: error instanceof RemoteFault ? error.code : "dependency_unavailable",
            operation_state: publishing ? "unknown" : "not_started" };
        } finally { await session?.close().catch(() => undefined); }
      };
      return attempt(expectedRevision, false);
    });
  };
}
