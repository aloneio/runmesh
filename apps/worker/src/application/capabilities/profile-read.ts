import type { DirectoryReadPorts, SharedProfiles } from "../../contracts/catalog.js";
import { CONNECTOR_LIMITS } from "../../contracts/connectors.js";
import { isCapabilityIdentifier } from "../../contracts/capabilities.js";
import { parseProfile } from "../../contracts/connector-values.js";
import { parseClientIdentity, type CapturedIdentity } from "../../contracts/identity.js";

/** Bounded metadata discovery, independent of upstream I/O and direct tool limits. */
export function createSharedProfileReader(ports: Pick<DirectoryReadPorts, "profiles" | "profile" | "repository" | "identity">) {
  return async (principal: CapturedIdentity, signal: AbortSignal): Promise<SharedProfiles> => {
    try {
      if (!isCapabilityIdentifier(principal?.client_id) || !Number.isSafeInteger(principal.secret_version) || principal.secret_version < 1) return { state: "denied" };
      const first = await ports.identity(principal, signal);
      if (signal.aborted) return { state: "unavailable" };
      if (first.state !== "allowed") return { state: first.state === "denied" ? "denied" : "unavailable" };
      const identity = parseClientIdentity(first.identity);
      if (!identity) return { state: "unavailable" };
      if (identity.client_id !== principal.client_id || identity.secret_version !== principal.secret_version) return { state: "denied" };
      const profiles: { profile_id: string; name: string }[] = [], revisions = new Map<string, [number, number]>();
      let after = "", count = 0;
      do {
        const page = ports.profiles(after);
        for (const raw of page.profiles) {
          const profile = parseProfile(raw);
          if (!profile || profile.profile_id <= after || ++count > CONNECTOR_LIMITS.profiles) return { state: "unavailable" };
          after = profile.profile_id;
          const head = ports.repository.readHead(profile.profile_id);
          if (profile.enabled && head?.approved_digest && head.approved_names.length) {
            profiles.push({ profile_id: profile.profile_id, name: profile.display_name ?? profile.connector_id });
            revisions.set(profile.profile_id, [profile.revision, head.revision]);
          }
        }
        if (page.next_after === null) break;
        if (!page.profiles.length || page.next_after !== after) return { state: "unavailable" };
      } while (true);
      const final = await ports.identity(principal, signal);
      if (signal.aborted) return { state: "unavailable" };
      if (final.state !== "allowed") return { state: final.state === "denied" ? "denied" : "unavailable" };
      const current = parseClientIdentity(final.identity);
      if (!current) return { state: "unavailable" };
      if (current.client_id !== principal.client_id || current.secret_version !== principal.secret_version) return { state: "denied" };
      for (const [id, [profile, catalog]] of revisions) {
        if (ports.profile(id)?.revision !== profile || ports.repository.readHead(id)?.revision !== catalog) return { state: "unavailable" };
      }
      return { state: "listed", profiles };
    } catch { return { state: "unavailable" }; }
  };
}
