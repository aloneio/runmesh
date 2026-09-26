import { CATALOG_LIMITS, type CatalogPage, type CatalogReadPorts, type CatalogTool } from "../../contracts/catalog.js";
import { parseCatalogQuery } from "../../contracts/catalog-values.js";
import { isCapabilityIdentifier } from "../../contracts/capabilities.js";
import { parseProfile } from "../../contracts/connector-values.js";
import { parseClientIdentity, type CapturedIdentity } from "../../contracts/identity.js";
import { catalogRevision } from "../../contracts/catalog-json.js";
import { compatibleApprovedTools, verifiedCatalogSnapshot } from "../../domain/capabilities/catalog.js";

/** Per-profile bounded directory view. No upstream fan-out or cached permission.
 * This is directory access only; it does not grant execution admission. */
export function createCatalogReader(ports: CatalogReadPorts) {
  return async (principal: CapturedIdentity, input: unknown, signal: AbortSignal, expired: () => boolean): Promise<CatalogPage> => {
    const query = parseCatalogQuery(input);
    if (query === undefined || !isCapabilityIdentifier(principal?.client_id) || !catalogRevision(principal.secret_version)) return { state: "invalid" };
    try {
      const first = await ports.identity(principal, signal);
      if (expired() || signal.aborted) return { state: "unavailable" };
      if (first.state !== "allowed") return { state: first.state === "denied" ? "denied" : "unavailable" };
      const identity = parseClientIdentity(first.identity);
      if (identity === undefined) return { state: "unavailable" };
      if (identity.client_id !== principal.client_id || identity.secret_version !== principal.secret_version) return { state: "denied" };
      // Authenticated instance clients share the published catalog.
      const rawProfile = ports.profile(query.profile_id);
      if (rawProfile === undefined) return { state: "denied" };
      const profile = parseProfile(rawProfile), head = ports.repository.readHead(query.profile_id);
      if (profile === undefined || profile.profile_id !== query.profile_id) return { state: "unavailable" };
      if (!profile.enabled) return { state: "denied" };
      if (head === undefined) return query.cursor === undefined ? { state: "listed", tools: [], next_cursor: null } : { state: "stale_cursor" };
      const cursor = query.cursor === undefined ? undefined : await ports.cursor.open(query.cursor);
      const now = ports.now(), limit = query.limit ?? cursor?.limit ?? CATALOG_LIMITS.page_tools;
      if (expired() || signal.aborted || !Number.isSafeInteger(now) || now < 0) return { state: "unavailable" };
      if (query.cursor !== undefined && (cursor === undefined || cursor.client_id !== principal.client_id || cursor.secret_version !== principal.secret_version
        || cursor.profile_id !== profile.profile_id || cursor.profile_revision !== profile.revision || cursor.catalog_revision !== head.revision
        || cursor.limit !== limit || cursor.expires_at_ms <= now
        || cursor.expires_at_ms > now + CATALOG_LIMITS.cursor_ttl_ms)) return { state: "stale_cursor" };
      let tools: CatalogTool[] = [];
      if (head.approved_digest !== null) {
        const observed = ports.repository.readSnapshot(profile.profile_id, head.observed_digest);
        const approved = head.approved_digest === head.observed_digest ? observed : ports.repository.readSnapshot(profile.profile_id, head.approved_digest);
        if (observed === undefined || approved === undefined
          || !await verifiedCatalogSnapshot(observed, profile, head.observed_digest, ports.digest)) return { state: "unavailable" };
        if (expired() || signal.aborted) return { state: "unavailable" };
        if (approved !== observed && !await verifiedCatalogSnapshot(approved, profile, head.approved_digest, ports.digest)) return { state: "unavailable" };
        if (head.approved_names.some(name => !approved.tools.some(tool => tool.definition.name === name))) return { state: "unavailable" };
        tools = compatibleApprovedTools(observed, approved, head.approved_names);
        tools.sort((a, b) => a.public_name < b.public_name ? -1 : a.public_name > b.public_name ? 1 : 0);
      }
      if (expired() || signal.aborted) return { state: "unavailable" };
      const offset = cursor?.offset ?? 0;
      if (cursor !== undefined && offset >= tools.length) return { state: "stale_cursor" };
      const page = tools.slice(offset, offset + limit), nextOffset = offset + page.length;
      const next = nextOffset >= tools.length ? null : await ports.cursor.seal({ schema_version: 2, client_id: principal.client_id,
        secret_version: principal.secret_version, profile_id: profile.profile_id, profile_revision: profile.revision,
        catalog_revision: head.revision, offset: nextOffset, limit, expires_at_ms: cursor?.expires_at_ms ?? now + CATALOG_LIMITS.cursor_ttl_ms });
      if (expired() || signal.aborted) return { state: "unavailable" };
      const final = await ports.identity(principal, signal);
      if (expired() || signal.aborted) return { state: "unavailable" };
      if (final.state !== "allowed") return { state: final.state === "denied" ? "denied" : "unavailable" };
      const latestIdentity = parseClientIdentity(final.identity);
      if (latestIdentity === undefined) return { state: "unavailable" };
      if (latestIdentity.client_id !== principal.client_id || latestIdentity.secret_version !== principal.secret_version) return { state: "denied" };
      const profileRecord = ports.profile(profile.profile_id);
      if (profileRecord === undefined) return { state: "denied" };
      const latestProfile = parseProfile(profileRecord);
      if (latestProfile === undefined) return { state: "unavailable" };
      if (latestProfile.profile_id !== profile.profile_id || !latestProfile.enabled) return { state: "denied" };
      if (latestProfile.revision !== profile.revision
        || latestProfile.endpoint !== profile.endpoint || latestProfile.connector_id !== profile.connector_id
        || ports.repository.readHead(profile.profile_id)?.revision !== head.revision) return { state: "stale_cursor" };
      if (cursor !== undefined && cursor.expires_at_ms <= ports.now()) return { state: "stale_cursor" };
      return { state: "listed", tools: page, next_cursor: next };
    } catch { return { state: "unavailable" }; }
  };
}
