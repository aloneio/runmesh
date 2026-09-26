import { CONNECTOR_LIMITS } from "../../contracts/connectors.js";
import { parseClientIdentity } from "../../contracts/identity.js";
import type { CapturedIdentity } from "../../contracts/identity.js";
import { type DirectoryReadPorts, type CentralDirectory, type CatalogTool } from "../../contracts/catalog.js";
import { catalogJson } from "../../contracts/catalog-json.js";
import { createCatalogReader } from "./catalog-read.js";

/** Small direct directories reuse exactly the same per-profile publication/snapshot
 * reader. Large views explicitly fall back to the bounded discovery surface. */
export function createDirectoryReader(ports: DirectoryReadPorts) {
  const sharedProfiles = () => {
    const ids: string[] = []; let after = "", count = 0;
    do {
      const page = ports.profiles(after);
      for (const profile of page.profiles) {
        if (++count > CONNECTOR_LIMITS.profiles || profile.profile_id <= after) throw new Error("invalid_profile_page");
        after = profile.profile_id;
        if (profile.enabled && ports.repository.readHead(profile.profile_id)?.approved_digest) ids.push(profile.profile_id);
      }
      if (page.next_after === null) break;
      if (!page.profiles.length || page.next_after !== after) throw new Error("invalid_profile_page");
    } while (true);
    return ids;
  };
  return async (principal: CapturedIdentity, signal: AbortSignal, expired: () => boolean): Promise<CentralDirectory> => {
    try {
      const identity = await ports.identity(principal, signal);
      if (expired() || signal.aborted) return { state: "unavailable" };
      if (identity.state !== "allowed") return { state: identity.state === "denied" ? "denied" : "unavailable" };
      if (!parseClientIdentity(identity.identity)) return { state: "unavailable" };
      if (identity.identity.client_id !== principal.client_id || identity.identity.secret_version !== principal.secret_version) return { state: "denied" };
      const profiles = sharedProfiles();
      if (profiles.length > 8) return { state: "capacity" };
      const tools: (CatalogTool & { profile_id: string })[] = [], revisions = new Map<string, [number, number]>(), read = createCatalogReader(ports);
      for (const profile_id of profiles) {
        const profile = ports.profile(profile_id);
        if (!profile?.enabled) continue;
        const revision = ports.repository.readHead(profile_id)?.revision ?? 0;
        revisions.set(profile_id, [profile.revision, revision]);
        let cursor: string | undefined;
        do {
          const result = await read(principal, { profile_id, ...(cursor ? { cursor } : {}) }, signal, expired);
          if (result.state !== "listed") return { state: result.state === "denied" ? "denied" : "unavailable" };
          tools.push(...result.tools.map(t => ({ ...t, profile_id })));
          if (tools.length > 32) return { state: "capacity" };
          cursor = result.next_cursor ?? undefined;
        } while (cursor);
      }
      const body = catalogJson(tools, 524_288);
      if (!body) return { state: "capacity" };
      const view_version = await ports.digest(body);
      const final = await ports.identity(principal, signal);
      if (expired() || signal.aborted) return { state: "unavailable" };
      if (final.state === "allowed" && !parseClientIdentity(final.identity)) return { state: "unavailable" };
      if (final.state !== "allowed" || final.identity.client_id !== principal.client_id || final.identity.secret_version !== principal.secret_version) return { state: final.state === "unavailable" ? "unavailable" : "denied" };
      if (JSON.stringify(sharedProfiles()) !== JSON.stringify(profiles)) return { state: "unavailable" };
      for (const [id, [profile, catalog]] of revisions) if (ports.profile(id)?.revision !== profile || (ports.repository.readHead(id)?.revision ?? 0) !== catalog) return { state: "unavailable" };
      return { state: "listed", tools, view_version };
    } catch { return { state: "unavailable" }; }
  };
}
