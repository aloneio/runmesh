import type { DirectoryReadPorts, SharedProfiles } from "../../contracts/catalog.js";
import { publishedProfiles, type PublishedProfilePorts } from "./published-profiles.js";
import { isCapabilityIdentifier } from "../../contracts/capabilities.js";
import { parseClientIdentity, type CapturedIdentity } from "../../contracts/identity.js";

/** Bounded metadata discovery, independent of upstream I/O and direct tool limits. */
export function createSharedProfileReader(ports: PublishedProfilePorts & Pick<DirectoryReadPorts, "identity">) {
  return async (principal: CapturedIdentity, signal: AbortSignal): Promise<SharedProfiles> => {
    try {
      if (!isCapabilityIdentifier(principal?.client_id) || !Number.isSafeInteger(principal.secret_version) || principal.secret_version < 1) return { state: "denied" };
      const first = await ports.identity(principal, signal);
      if (signal.aborted) return { state: "unavailable" };
      if (first.state !== "allowed") return { state: first.state === "denied" ? "denied" : "unavailable" };
      const identity = parseClientIdentity(first.identity);
      if (!identity) return { state: "unavailable" };
      if (identity.client_id !== principal.client_id || identity.secret_version !== principal.secret_version) return { state: "denied" };
      const snapshot = publishedProfiles(ports);
      const final = await ports.identity(principal, signal);
      if (signal.aborted) return { state: "unavailable" };
      if (final.state !== "allowed") return { state: final.state === "denied" ? "denied" : "unavailable" };
      const current = parseClientIdentity(final.identity);
      if (!current) return { state: "unavailable" };
      if (current.client_id !== principal.client_id || current.secret_version !== principal.secret_version) return { state: "denied" };
      if (JSON.stringify(publishedProfiles(ports)) !== JSON.stringify(snapshot)) return { state: "unavailable" };
      return { state: "listed", profiles: snapshot.map(({ profile }) => ({ profile_id: profile.profile_id, name: profile.display_name ?? profile.connector_id })) };
    } catch { return { state: "unavailable" }; }
  };
}
