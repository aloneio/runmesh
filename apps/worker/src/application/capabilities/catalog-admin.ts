import type { CatalogAdminPorts, CatalogInspection, CatalogMutation } from "../../contracts/catalog.js";
import { catalogDigest } from "../../contracts/catalog-json.js";
import { parseCatalogCommand } from "../../contracts/catalog-values.js";
import { isCapabilityIdentifier } from "../../contracts/capabilities.js";
import { parseProfile } from "../../contracts/connector-values.js";
import { buildCatalogSnapshot, catalogChanges, verifiedCatalogSnapshot } from "../../domain/capabilities/catalog.js";

/** Pure orchestration over synchronous owner-local repositories and injected
 * authorization/hash ports. Composition supplies the request-local deadline. */
export function createCatalogManager(ports: CatalogAdminPorts) {
  return {
    async mutate(value: unknown, signal: AbortSignal, expired: () => boolean): Promise<CatalogMutation> {
      const command = parseCatalogCommand(value);
      if (command === undefined) return { state: "invalid" };
      let writing = false;
      try {
        const initial = await ports.authorize(signal);
        if (signal.aborted || expired()) return { state: "unavailable" };
        if (initial !== "allowed") return { state: initial };
        const rawProfile = ports.profile(command.profile_id);
        if (rawProfile === undefined) return { state: "missing" };
        const profile = parseProfile(rawProfile);
        if (profile === undefined || profile.profile_id !== command.profile_id) return { state: "unavailable" };
        const current = ports.repository.readHead(command.profile_id), revision = current?.revision ?? 0;
        if (revision !== command.expected_revision) return { state: "conflict", current_revision: revision };
        const snapshot = command.action === "stage" ? await buildCatalogSnapshot(profile, command.tools, ports.digest, expired) : undefined;
        if (signal.aborted || expired()) return { state: "unavailable" };
        if (command.action === "stage" && snapshot === undefined) return { state: "invalid" };
        if (command.action === "approve") {
          const captured = ports.repository.readSnapshot(command.profile_id, command.digest);
          if (captured === undefined || current?.observed_digest !== command.digest) return { state: "invalid" };
          if (!await verifiedCatalogSnapshot(captured, profile, command.digest, ports.digest)) return { state: "unavailable" };
        }
        if (signal.aborted || expired()) return { state: "unavailable" };
        const final = await ports.authorize(signal);
        if (signal.aborted || expired()) return { state: "unavailable" };
        if (final !== "allowed") return { state: final };
        const latest = ports.profile(command.profile_id);
        if (latest === undefined || latest.revision !== profile.revision || latest.endpoint !== profile.endpoint
          || latest.connector_id !== profile.connector_id) return { state: "stale_profile" };
        writing = true;
        // No await from the final observations to a revision-checked transaction.
        if (snapshot !== undefined) return ports.repository.stage(snapshot, command.expected_revision);
        return command.action === "approve" ? ports.repository.approve(command.profile_id, command.digest, command.tool_names, command.expected_revision)
          : ports.repository.disable(command.profile_id, command.expected_revision);
      } catch { return { state: writing ? "unknown" : "unavailable" }; }
    },

    async inspect(profileId: string, requestedDigest: string | undefined, signal: AbortSignal, expired: () => boolean): Promise<CatalogInspection> {
      if (!isCapabilityIdentifier(profileId) || (requestedDigest !== undefined && !catalogDigest(requestedDigest))) return { state: "invalid" };
      try {
        const initial = await ports.authorize(signal);
        if (signal.aborted || expired()) return { state: "unavailable" };
        if (initial !== "allowed") return { state: initial };
        const rawProfile = ports.profile(profileId), head = ports.repository.readHead(profileId);
        if (rawProfile === undefined || head === undefined) return { state: "missing" };
        const profile = parseProfile(rawProfile);
        if (profile === undefined || profile.profile_id !== profileId) return { state: "unavailable" };
        const digest = requestedDigest ?? head.observed_digest, snapshot = ports.repository.readSnapshot(profileId, digest);
        if (snapshot === undefined) return { state: "missing" };
        if (!await verifiedCatalogSnapshot(snapshot, profile, digest, ports.digest)) return { state: "unavailable" };
        const approved = head.approved_digest === null ? undefined : ports.repository.readSnapshot(profileId, head.approved_digest);
        if (head.approved_digest !== null && (approved === undefined || !await verifiedCatalogSnapshot(approved, profile, head.approved_digest, ports.digest))) return { state: "unavailable" };
        if (signal.aborted || expired()) return { state: "unavailable" };
        const final = await ports.authorize(signal);
        if (signal.aborted || expired()) return { state: "unavailable" };
        if (final !== "allowed") return { state: final };
        if (ports.repository.readHead(profileId)?.revision !== head.revision || ports.profile(profileId)?.revision !== profile.revision) return { state: "unavailable" };
        return { state: "found", head, snapshot, changes: catalogChanges(snapshot, approved) };
      } catch { return { state: "unavailable" }; }
    },
  };
}
