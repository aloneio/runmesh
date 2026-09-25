import type { CapturedIdentity } from "../../contracts/identity.js";
import type { CatalogReadPorts, CentralDirectory, CatalogTool } from "../../contracts/catalog.js";
import { catalogJson } from "../../contracts/catalog-json.js";
import { parseCapabilityGrant } from "../../contracts/capabilities.js";
import { createCatalogReader } from "./catalog-read.js";

/** Small direct directories reuse exactly the same per-profile ACL/snapshot
 * reader. Large views explicitly fall back to the bounded discovery surface. */
export function createDirectoryReader(ports: CatalogReadPorts) {
  return async (principal: CapturedIdentity, signal: AbortSignal, expired: () => boolean): Promise<CentralDirectory> => {
    try {
      const identity = await ports.identity(principal, signal);
      if (expired()) return { state: "unavailable" };
      if (identity.state !== "allowed") return { state: identity.state === "denied" ? "denied" : "unavailable" };
      if (identity.identity.client_id !== principal.client_id || identity.identity.secret_version !== principal.secret_version) return { state: "denied" };
      const grant = parseCapabilityGrant(ports.grant(principal.client_id));
      if (!grant || !grant.enabled || grant.client_id !== principal.client_id) return { state: "denied" };
      const profiles = [...new Set(grant.rules.flatMap(r => r.kind === "remote_tool" ? [r.connection_profile_id] : []))].sort();
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
      if (expired()) return { state: "unavailable" };
      if (final.state !== "allowed" || final.identity.client_id !== principal.client_id || final.identity.secret_version !== principal.secret_version) return { state: final.state === "unavailable" ? "unavailable" : "denied" };
      const current = parseCapabilityGrant(ports.grant(principal.client_id));
      if (!current?.enabled || current.client_id !== principal.client_id || current.revision !== grant.revision) return { state: "denied" };
      for (const [id, [profile, catalog]] of revisions) if (ports.profile(id)?.revision !== profile || (ports.repository.readHead(id)?.revision ?? 0) !== catalog) return { state: "unavailable" };
      return { state: "listed", tools, view_version };
    } catch { return { state: "unavailable" }; }
  };
}
