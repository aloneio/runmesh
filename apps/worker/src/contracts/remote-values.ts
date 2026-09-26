import { REMOTE_LIMITS, type RemoteCall, type RemoteResult } from "./remote.js";
import { catalogDigest, catalogJson, catalogKeys, catalogObject } from "./catalog-json.js";
import { isCapabilityIdentifier } from "./capabilities.js";
import { profileEndpoint } from "./connector-values.js";

export function parseRemoteCall(value: unknown): RemoteCall | undefined {
  const encoded = catalogJson(value, REMOTE_LIMITS.request_bytes);
  const item = encoded === undefined ? undefined : catalogObject(JSON.parse(encoded));
  if (item === undefined || !catalogKeys(item, ["profile_id", "tool_id", "version", "arguments"])
    || !isCapabilityIdentifier(item.profile_id) || typeof item.tool_id !== "string" || !/^mcp\.[a-f0-9]{64}$/u.test(item.tool_id)
    || !catalogDigest(item.version) || catalogObject(item.arguments) === undefined) return undefined;
  return item as unknown as RemoteCall;
}

/** Exact administrator-owned destination allowlist. No wildcards, redirects, IP
 * literals, private-name shortcuts or public-origin recursion. Runtime public-only
 * fetch routing is an additional deployment requirement, not a DNS preflight. */
export function publicMcpEndpoint(value: unknown): string | undefined {
  const endpoint = profileEndpoint(value);
  if (endpoint === undefined) return undefined;
  const url = new URL(endpoint), host = url.hostname;
  if (url.port || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/u.test(host)
    || /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|test|invalid|example|onion)$/u.test(host)
    || /(?:^|\.)metadata(?:\.|$)/u.test(host)) return undefined;
  return endpoint;
}

/** Content stays data. Resource links are returned but never fetched. Transport
 * metadata/authentication hints are not forwarded into the client credential UI. */
export function parseRemoteResult(value: unknown): RemoteResult | undefined {
  const encoded = catalogJson(value, REMOTE_LIMITS.response_bytes);
  const item = encoded === undefined ? undefined : catalogObject(JSON.parse(encoded));
  if (item === undefined || (item.resultType !== undefined && item.resultType !== "complete")
    || item.task !== undefined || item.inputRequests !== undefined || !Array.isArray(item.content)
    || item.content.length > REMOTE_LIMITS.content_items || (item.isError !== undefined && typeof item.isError !== "boolean")
    || (item.structuredContent !== undefined && catalogObject(item.structuredContent) === undefined)) return undefined;
  const content: { [key: string]: import("./catalog.js").CatalogJson }[] = [];
  for (const raw of item.content) {
    const block = catalogObject(raw);
    if (block === undefined) return undefined;
    const safe = Object.fromEntries(Object.entries(block).filter(([key]) => key !== "_meta"));
    if (block.type === "text") { if (typeof block.text !== "string") return undefined; }
    else if (block.type === "image" || block.type === "audio") {
      if (typeof block.data !== "string" || block.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(block.data)
        || typeof block.mimeType !== "string" || block.mimeType.length > 256) return undefined;
    } else if (block.type === "resource") {
      const resource = catalogObject(block.resource);
      if (resource === undefined || typeof resource.uri !== "string" || resource.uri.length > 4096
        || (typeof resource.text !== "string" && typeof resource.blob !== "string")) return undefined;
      safe.resource = Object.fromEntries(Object.entries(resource).filter(([key]) => key !== "_meta"));
    } else if (block.type === "resource_link") {
      if (typeof block.uri !== "string" || block.uri.length > 4096 || typeof block.name !== "string") return undefined;
    } else return undefined;
    content.push(safe as { [key: string]: import("./catalog.js").CatalogJson });
  }
  return { content, ...(item.structuredContent === undefined ? {} : { structuredContent: item.structuredContent as NonNullable<RemoteResult["structuredContent"]> }), isError: item.isError === true };
}
