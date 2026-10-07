import { publishedProfiles } from "./published-profiles.js";
import { capturedIdentityState } from "../../contracts/identity.js";
import type { CapturedIdentity } from "../../contracts/identity.js";
import { type DirectoryReadPorts, type CentralDirectory, type CatalogTool } from "../../contracts/catalog.js";
import { catalogJson } from "../../contracts/catalog-json.js";
import { createCatalogReader } from "./catalog-read.js";

/** Small direct directories reuse exactly the same per-profile publication/snapshot
 * reader. Large views explicitly fall back to the bounded discovery surface. */
export function createDirectoryReader(ports: DirectoryReadPorts) {
  return async (principal: CapturedIdentity, signal: AbortSignal, expired: () => boolean): Promise<CentralDirectory> => {
    try {
      const identity = await ports.identity(principal, signal);
      if (expired() || signal.aborted) return { state: "unavailable" };
      const firstState = capturedIdentityState(principal, identity);
      if (firstState !== "allowed") return { state: firstState };
      const snapshot = publishedProfiles(ports), profiles = snapshot.map(entry => entry.profile.profile_id);
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
      const finalState = capturedIdentityState(principal, final);
      if (finalState !== "allowed") return { state: finalState };
      if (JSON.stringify(publishedProfiles(ports)) !== JSON.stringify(snapshot)) return { state: "unavailable" };
      for (const [id, [profile, catalog]] of revisions) if (ports.profile(id)?.revision !== profile || (ports.repository.readHead(id)?.revision ?? 0) !== catalog) return { state: "unavailable" };
      return { state: "listed", tools, view_version };
    } catch { return { state: "unavailable" }; }
  };
}
