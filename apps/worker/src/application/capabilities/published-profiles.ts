import type { CatalogRepository, DirectoryReadPorts } from "../../contracts/catalog.js";
import { CONNECTOR_LIMITS, type ConnectionProfile } from "../../contracts/connectors.js";
import { parseProfile } from "../../contracts/connector-values.js";
import { parseCatalogHead } from "../../contracts/catalog-values.js";

export interface PublishedProfilePorts {
  readonly profiles: DirectoryReadPorts["profiles"];
  readonly repository: Pick<CatalogRepository, "readHead">;
}
export interface PublishedProfile {
  readonly profile: ConnectionProfile;
  readonly catalog_revision: number;
}

/** One ordered, bounded publication snapshot for both metadata and tool discovery.
 * Call again after asynchronous admission to fence membership and revision changes. */
export function publishedProfiles(ports: PublishedProfilePorts): readonly PublishedProfile[] {
  const result: PublishedProfile[] = [];
  let after = "", count = 0;
  do {
    const page = ports.profiles(after);
    for (const raw of page.profiles) {
      const profile = parseProfile(raw);
      if (!profile || profile.profile_id <= after || ++count > CONNECTOR_LIMITS.profiles) throw new Error("invalid_profile_page");
      after = profile.profile_id;
      const rawHead = ports.repository.readHead(profile.profile_id), head = rawHead === undefined ? undefined : parseCatalogHead(rawHead);
      if (rawHead !== undefined && (!head || head.profile_id !== profile.profile_id)) throw new Error("invalid_catalog_head");
      if (profile.enabled && head?.approved_digest && head.approved_names.length) result.push({ profile, catalog_revision: head.revision });
    }
    if (page.next_after === null) return result;
    if (!page.profiles.length || page.next_after !== after) throw new Error("invalid_profile_page");
  } while (true);
}
