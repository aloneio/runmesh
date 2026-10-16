import type { CatalogSnapshotPorts } from "../../contracts/catalog.js";
import type { ConnectionProfile } from "../../contracts/connectors.js";
import { parseProfile } from "../../contracts/connector-values.js";
import { verifiedCatalogSnapshot } from "../../domain/capabilities/catalog.js";

/** Only fully published and verified catalog heads permit an automatic rebase.
 * Disabled, staged and partly approved heads remain manual conflicts. */
export async function recoverableCatalogRevision(ports: CatalogSnapshotPorts, profile: ConnectionProfile,
  staleRevision: number, expired: () => boolean): Promise<number | undefined> {
  if (expired()) return undefined;
  const current = parseProfile(ports.profile(profile.profile_id));
  if (current === undefined || !current.enabled || current.revision !== profile.revision
    || current.endpoint !== profile.endpoint || current.connector_id !== profile.connector_id) return undefined;
  const head = ports.repository.readHead(profile.profile_id);
  if (head === undefined || head.revision <= staleRevision || head.approved_digest === null
    || head.approved_digest !== head.observed_digest) return undefined;
  const snapshot = ports.repository.readSnapshot(profile.profile_id, head.observed_digest);
  if (snapshot === undefined || head.approved_names.length !== snapshot.tools.length
    || !snapshot.tools.every(tool => head.approved_names.includes(tool.definition.name))
    || !await verifiedCatalogSnapshot(snapshot, current, head.observed_digest, ports.digest) || expired()) return undefined;
  // Any further concurrent update must be handled as a new conflict, not a loop.
  if (ports.repository.readHead(profile.profile_id)?.revision !== head.revision
    || ports.profile(profile.profile_id)?.revision !== current.revision) return undefined;
  return head.revision;
}
