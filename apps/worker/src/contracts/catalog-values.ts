import { CATALOG_LIMITS, type CatalogCommand, type CatalogHead, type CatalogQuery, type CatalogSnapshot, type CatalogTool,
  type CatalogCursor, type RemoteToolDefinition } from "./catalog.js";
import { isCapabilityIdentifier } from "./capabilities.js";
import { catalogDigest, catalogJson, catalogKeys, catalogObject, catalogRevision, toolName } from "./catalog-json.js";
import { validCatalogSchema } from "./catalog-schema.js";

const text = (value: unknown, max: number): boolean => value === undefined || typeof value === "string" && value.length <= max;
const optionalFlags = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;
export function parseRemoteTool(value: unknown): RemoteToolDefinition | undefined {
  const encoded = catalogJson(value, CATALOG_LIMITS.tool_bytes);
  if (encoded === undefined) return undefined;
  const item = catalogObject(JSON.parse(encoded));
  // Tool descriptors are an extension point in current MCP servers. Validate
  // the fields Runmesh executes or persists, and deliberately discard bounded
  // presentation/provider metadata instead of rejecting the entire catalog.
  if (item === undefined || !toolName(item.name) || !text(item.title, 256) || !text(item.description, 8192)
    || !validCatalogSchema(item.inputSchema, true) || (item.outputSchema !== undefined && !validCatalogSchema(item.outputSchema, false))) return undefined;
  let annotations: RemoteToolDefinition["annotations"];
  if (item.annotations !== undefined) {
    const raw = catalogObject(item.annotations);
    if (raw === undefined || !text(raw.title, 256)
      || optionalFlags.some(key => raw[key] !== undefined && typeof raw[key] !== "boolean")) return undefined;
    const projected = {
      ...(raw.title === undefined ? {} : { title: raw.title as string }),
      ...Object.fromEntries(optionalFlags.filter(key => raw[key] !== undefined).map(key => [key, raw[key] as boolean])),
    } as NonNullable<RemoteToolDefinition["annotations"]>;
    if (Object.keys(projected).length) annotations = projected;
  }
  if (item.execution !== undefined) {
    const execution = catalogObject(item.execution);
    if (execution === undefined || execution.taskSupport !== undefined
      && !["required", "optional", "forbidden"].includes(execution.taskSupport as string)) return undefined;
  }
  if (item.icons !== undefined) {
    if (!Array.isArray(item.icons) || item.icons.length > 32 || item.icons.some(value => {
      const icon = catalogObject(value);
      return icon === undefined || typeof icon.src !== "string" || !icon.src || icon.src.length > 2048
        || !text(icon.mimeType, 256)
        || icon.sizes !== undefined && (!Array.isArray(icon.sizes) || icon.sizes.length > 32
          || icon.sizes.some(size => typeof size !== "string" || size.length > 64))
        || icon.theme !== undefined && !["light", "dark"].includes(icon.theme as string);
    })) return undefined;
  }
  if (item._meta !== undefined && catalogObject(item._meta) === undefined) return undefined;
  return {
    name: item.name,
    ...(item.title === undefined ? {} : { title: item.title as string }),
    ...(item.description === undefined ? {} : { description: item.description as string }),
    inputSchema: item.inputSchema as RemoteToolDefinition["inputSchema"],
    ...(item.outputSchema === undefined ? {} : { outputSchema: item.outputSchema as NonNullable<RemoteToolDefinition["outputSchema"]> }),
    ...(annotations === undefined ? {} : { annotations }),
  };
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
  if (!["stage", "publish"].includes(item.action as string) || !catalogKeys(item, ["action", "profile_id", "expected_revision", "tools"])
    || !Array.isArray(item.tools) || item.tools.length > CATALOG_LIMITS.tools
    || catalogJson(item.tools, CATALOG_LIMITS.request_bytes) === undefined) return undefined;
  const tools: RemoteToolDefinition[] = [], seen = new Set<string>();
  for (const value of item.tools) {
    const tool = parseRemoteTool(value);
    if (tool === undefined || seen.has(tool.name)) return undefined;
    tools.push(tool); seen.add(tool.name);
  }
  tools.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { action: item.action as "stage" | "publish", profile_id: item.profile_id, expected_revision: item.expected_revision, tools };
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

/** Project a published entry; containers own field, ordering and aggregate budgets. */
export function parseCatalogTool(profileId: unknown, value: unknown): CatalogTool | undefined {
  if (!isCapabilityIdentifier(profileId)) return undefined;
  const item = catalogObject(value), definition = parseRemoteTool(item?.definition);
  if (item === undefined || definition === undefined || typeof item.tool_id !== "string" || !/^mcp\.[a-f0-9]{64}$/u.test(item.tool_id)
    || !catalogDigest(item.version) || item.public_name !== catalogPublicName(profileId, definition.name, item.tool_id.slice(4))) return undefined;
  return { tool_id: item.tool_id, public_name: item.public_name, version: item.version, definition };
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
    const raw = catalogObject(entry), tool = parseCatalogTool(item.profile_id, raw);
    if (raw === undefined || !catalogKeys(raw, ["tool_id", "public_name", "version", "definition"]) || tool === undefined
      || seen.has(tool.tool_id) || tool.definition.name <= previous) return undefined;
    previous = tool.definition.name; seen.add(tool.tool_id);
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
