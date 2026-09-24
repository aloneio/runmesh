import { CATALOG_LIMITS, type CatalogDelta, type CatalogSnapshot, type CatalogTool, type RemoteToolDefinition } from "../../contracts/catalog.js";
import type { ConnectionProfile } from "../../contracts/connectors.js";
import { catalogDigest, catalogJson } from "../../contracts/catalog-json.js";
import { catalogPublicName, parseCatalogSnapshot } from "../../contracts/catalog-values.js";

export function snapshotContent(snapshot: Omit<CatalogSnapshot, "digest">): string | undefined {
  return catalogJson({ schema_version: 1, profile_id: snapshot.profile_id, connector_id: snapshot.connector_id,
    endpoint: snapshot.endpoint, tools: snapshot.tools }, CATALOG_LIMITS.snapshot_bytes);
}

/** Digesting is injected; rules never load a crypto or MCP implementation. */
export async function buildCatalogSnapshot(profile: ConnectionProfile, definitions: readonly RemoteToolDefinition[],
  digest: (canonical: string) => Promise<string>, expired: () => boolean): Promise<CatalogSnapshot | undefined> {
  const tools: CatalogTool[] = [];
  for (const definition of definitions) {
    if (expired()) return undefined;
    const identity = catalogJson(["runmesh-remote-tool-id-v1", profile.profile_id, profile.connector_id, profile.endpoint, definition.name], 4096);
    const content = catalogJson(["runmesh-remote-tool-v1", profile.profile_id, definition], CATALOG_LIMITS.tool_bytes + 512);
    if (identity === undefined || content === undefined) return undefined;
    const id = await digest(identity);
    if (expired() || !catalogDigest(id)) return undefined;
    const version = await digest(content);
    if (expired() || !catalogDigest(version)) return undefined;
    tools.push({ tool_id: "mcp." + id, public_name: catalogPublicName(profile.profile_id, definition.name, id), version, definition });
  }
  const snapshot = { schema_version: 1 as const, profile_id: profile.profile_id, connector_id: profile.connector_id, endpoint: profile.endpoint, tools };
  const content = snapshotContent(snapshot);
  if (content === undefined || expired()) return undefined;
  return parseCatalogSnapshot({ ...snapshot, digest: await digest(content) });
}

export async function verifiedCatalogSnapshot(snapshot: CatalogSnapshot, profile: ConnectionProfile,
  expectedDigest: string, digest: (canonical: string) => Promise<string>): Promise<boolean> {
  const parsed = parseCatalogSnapshot(snapshot);
  if (parsed === undefined || parsed.profile_id !== profile.profile_id || parsed.connector_id !== profile.connector_id
    || parsed.endpoint !== profile.endpoint || parsed.digest !== expectedDigest) return false;
  const content = snapshotContent(parsed);
  return content !== undefined && await digest(content) === expectedDigest;
}

export function catalogChanges(observed: CatalogSnapshot, approved: CatalogSnapshot | undefined): CatalogDelta[] {
  const current = new Map(observed.tools.map(tool => [tool.definition.name, tool.version]));
  const previous = new Map(approved?.tools.map(tool => [tool.definition.name, tool.version]) ?? []);
  return [...new Set([...current.keys(), ...previous.keys()])].sort().map(name => ({ name,
    state: !current.has(name) ? "removed" : !previous.has(name) ? "added" : current.get(name) !== previous.get(name) ? "changed" : "unchanged" }));
}

/** Staging never approves changes. Changed/removed tools are quarantined from
 * the old approved view; unchanged reviewed tools can remain visible. */
export function compatibleApprovedTools(observed: CatalogSnapshot, approved: CatalogSnapshot, names: readonly string[]): CatalogTool[] {
  const selected = new Set(names), current = new Map(observed.tools.map(tool => [tool.tool_id, tool.version]));
  return approved.tools.filter(tool => selected.has(tool.definition.name) && current.get(tool.tool_id) === tool.version);
}
