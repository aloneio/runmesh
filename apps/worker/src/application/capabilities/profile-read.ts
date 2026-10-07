import type { DirectoryReadPorts, SharedProfiles } from "../../contracts/catalog.js";
import { publishedProfiles, type PublishedProfilePorts } from "./published-profiles.js";
import { isCapabilityIdentifier } from "../../contracts/capabilities.js";
import { capturedIdentityState, type CapturedIdentity } from "../../contracts/identity.js";

/** Bounded metadata discovery, independent of upstream I/O and direct tool limits. */
export function createSharedProfileReader(ports: PublishedProfilePorts & Pick<DirectoryReadPorts, "identity">) {
  return async (principal: CapturedIdentity, signal: AbortSignal): Promise<SharedProfiles> => {
    try {
      if (!isCapabilityIdentifier(principal?.client_id) || !Number.isSafeInteger(principal.secret_version) || principal.secret_version < 1) return { state: "denied" };
      const first = await ports.identity(principal, signal);
      if (signal.aborted) return { state: "unavailable" };
      const firstState = capturedIdentityState(principal, first);
      if (firstState !== "allowed") return { state: firstState };
      const snapshot = publishedProfiles(ports);
      const final = await ports.identity(principal, signal);
      if (signal.aborted) return { state: "unavailable" };
      const finalState = capturedIdentityState(principal, final);
      if (finalState !== "allowed") return { state: finalState };
      if (JSON.stringify(publishedProfiles(ports)) !== JSON.stringify(snapshot)) return { state: "unavailable" };
      return { state: "listed", profiles: snapshot.map(({ profile }) => ({ profile_id: profile.profile_id, name: profile.display_name ?? profile.connector_id })) };
    } catch { return { state: "unavailable" }; }
  };
}
