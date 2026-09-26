import { CATALOG_LIMITS, type CatalogCommand, type CatalogHead, type CatalogQuery, type CatalogSnapshot,
  type CatalogCursor, type RemoteToolDefinition } from "./catalog.js";
import { isCapabilityIdentifier } from "./capabilities.js";
import { catalogDigest, catalogJson, catalogKeys, catalogObject, catalogRevision, toolName } from "./catalog-json.js";
import { validCatalogSchema } from "./catalog-schema.js";

const text = (value: unknown, max: number): boolean => value === undefined || typeof value === "string" && value.length <= max;
const optionalFlags = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
export function parseRemoteTool(value: unknown): RemoteToolDefinition | undefined {
  const encoded = catalogJson(value, CATALOG_LIMITS.tool_bytes);
  if (encoded === undefined) return undefined;
  const item = catalogObject(JSON.parse(encoded));
  if (item === undefined || !catalogKeys(item, ["name", "title", "description", "inputSchema", "outputSchema", "annotations"])
    || !toolName(item.name) || !text(item.title, 256) || !text(item.description, 8192)
    || !validCatalogSchema(item.inputSchema, true) || (item.outputSchema !== undefined && !validCatalogSchema(item.outputSchema, false))) return undefined;
  if (item.annotations !== undefined) {
    const annotations = catalogObject(item.annotations);
    if (annotations === undefined || !catalogKeys(annotations, ["title", ...optionalFlags]) || !text(annotations.title, 256)
      || optionalFlags.some(key => annotations[key] !== undefined && typeof annotations[key] !== "boolean")) return undefined;
  }
  return item as unknown as RemoteToolDefinition;
}

export function parseToolNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > CATALOG_LIMITS.tools || !value.every(toolName) || new Set(value).size !== value.length) return undefined;
  return [...value].sort();
}

export function parseCatalogCommand(value: unknown): CatalogCommand | undefined {
  const item = catalogObject(value);
  if (item === undefined || !isCapabilityIdentifier(item.profile_id) || !catalogRevision(item.expected_revision, true)) return undefined;
  if (item.action === "disable" && catalogKeys(item, ["action", "profile_id", "expected_revision"]))
    return { action: "disable", profile_id: item.profile_id, expected_revision: item.expected_revision };
  if (item.action === "approve" && catalogKeys(item, ["action", "profile_id", "expected_revision", "digest", "tool_names"])) {
    const names = parseToolNames(item.tool_names);
    return !catalogDigest(item.digest) || names === undefined ? undefined : { action: "approve", profile_id: item.profile_id,
      expected_revision: item.expected_revision, digest: item.digest, tool_names: names };
  }
  if (item.action !== "stage" || !catalogKeys(item, ["action", "profile_id", "expected_revision", "tools"])
    || !Array.isArray(item.tools) || item.tools.length > CATALOG_LIMITS.tools
    || catalogJson(item.tools, CATALOG_LIMITS.request_bytes) === undefined) return undefined;
  const tools: RemoteToolDefinition[] = [], seen = new Set<string>();
  for (const value of item.tools) {
    const tool = parseRemoteTool(value);
    if (tool === undefined || seen.has(tool.name)) return undefined;
    tools.push(tool); seen.add(tool.name);
  }
  tools.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { action: "stage", profile_id: item.profile_id, expected_revision: item.expected_revision, tools };
}

export function parseCatalogHead(value: unknown): CatalogHead | undefined {
  const item = catalogObject(value), names = parseToolNames(item?.approved_names);
  if (item === undefined || !catalogKeys(item, ["schema_version", "profile_id", "revision", "observed_digest", "approved_digest", "approved_names"])
    || item.schema_version !== 1 || !isCapabilityIdentifier(item.profile_id) || !catalogRevision(item.revision)
    || !catalogDigest(item.observed_digest) || (item.approved_digest !== null && !catalogDigest(item.approved_digest))
    || names === undefined || (item.approved_digest === null && names.length > 0)) return undefined;
  return { schema_version: 1, profile_id: item.profile_id, revision: item.revision, observed_digest: item.observed_digest,
    approved_digest: item.approved_digest as string | null, approved_names: names };
}

export function catalogPublicName(profileId: string, name: string, idDigest: string): string {
  return `rm_${profileId.replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 12)}_${name.slice(0, 32)}_${idDigest}`;
}

export function parseCatalogSnapshot(value: unknown): CatalogSnapshot | undefined {
  const encoded = catalogJson(value, CATALOG_LIMITS.snapshot_bytes);
  if (encoded === undefined) return undefined;
  const item = catalogObject(JSON.parse(encoded));
  if (item === undefined || !catalogKeys(item, ["schema_version", "profile_id", "connector_id", "endpoint", "digest", "tools"])
    || item.schema_version !== 1 || !isCapabilityIdentifier(item.profile_id) || !isCapabilityIdentifier(item.connector_id)
    || typeof item.endpoint !== "string" || item.endpoint.length > 2048 || !catalogDigest(item.digest)
    || !Array.isArray(item.tools) || item.tools.length > CATALOG_LIMITS.tools) return undefined;
  const seen = new Set<string>(); let previous = "";
  for (const entry of item.tools) {
    const tool = catalogObject(entry), definition = parseRemoteTool(tool?.definition);
    if (tool === undefined || !catalogKeys(tool, ["tool_id", "public_name", "version", "definition"]) || definition === undefined
      || typeof tool.tool_id !== "string" || !/^mcp\.[a-f0-9]{64}$/u.test(tool.tool_id) || !catalogDigest(tool.version)
      || tool.public_name !== catalogPublicName(item.profile_id, definition.name, tool.tool_id.slice(4))
      || seen.has(tool.tool_id) || definition.name <= previous) return undefined;
    previous = definition.name; seen.add(tool.tool_id);
  }
  return item as unknown as CatalogSnapshot;
}

export function parseCatalogQuery(value: unknown): CatalogQuery | undefined {
  const item = catalogObject(value);
  if (item === undefined || !catalogKeys(item, ["profile_id", "limit", "cursor"]) || !isCapabilityIdentifier(item.profile_id)
    || (item.limit !== undefined && (!Number.isSafeInteger(item.limit) || (item.limit as number) < 1 || (item.limit as number) > CATALOG_LIMITS.page_tools))
    || (item.cursor !== undefined && (typeof item.cursor !== "string" || item.cursor.length === 0 || item.cursor.length > CATALOG_LIMITS.cursor_bytes))) return undefined;
  return { profile_id: item.profile_id, ...(item.limit === undefined ? {} : { limit: item.limit as number }),
    ...(item.cursor === undefined ? {} : { cursor: item.cursor as string }) };
}

export function parseCatalogCursor(value: unknown): CatalogCursor | undefined {
  const item = catalogObject(value);
  if (item === undefined || !catalogKeys(item, ["schema_version", "client_id", "secret_version", "profile_id", "profile_revision",
    "catalog_revision", "offset", "limit", "expires_at_ms"]) || item.schema_version !== 2
    || !isCapabilityIdentifier(item.client_id) || !isCapabilityIdentifier(item.profile_id)
    || ![item.secret_version, item.profile_revision, item.catalog_revision, item.expires_at_ms].every(v => catalogRevision(v))
    || !Number.isSafeInteger(item.offset) || (item.offset as number) < 1 || (item.offset as number) > CATALOG_LIMITS.tools
    || !Number.isSafeInteger(item.limit) || (item.limit as number) < 1 || (item.limit as number) > CATALOG_LIMITS.page_tools) return undefined;
  return item as unknown as CatalogCursor;
}
