import { MCP_REGISTRY_LIMITS, type RegistryCandidate, type RegistryPreview, type RegistrySkippedClient } from "../../contracts/mcp-registry.js";
import { catalogObject, catalogJson } from "../../contracts/catalog-json.js";
import { publicMcpEndpoint } from "../../contracts/remote-values.js";
import { profileEndpoint } from "../../contracts/connector-values.js";

const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0
  && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);

/** Client configurations only provide inert HTTPS connection candidates; they
 * never authorize running stdio packages, copying tokens or fetching URLs. */
function previewClientConfig(raw: Record<string, unknown>): RegistryPreview | undefined {
  const nested = catalogObject(raw.mcp);
  const servers = catalogObject(raw.mcpServers) ?? catalogObject(raw.servers) ?? catalogObject(nested?.servers);
  if (!servers || Object.keys(servers).length === 0 || Object.keys(servers).length > MCP_REGISTRY_LIMITS.remotes + MCP_REGISTRY_LIMITS.packages) return undefined;
  const remotes: RegistryCandidate[] = [], skipped: RegistrySkippedClient[] = [];
  for (const [name, source] of Object.entries(servers)) {
    if (!text(name, 128)) return undefined;
    const value = catalogObject(source);
    if (!value) { skipped.push({ name, reason: "invalid_definition" }); continue; }
    // A command is *never* trusted, including a config that also supplies a URL.
    if (Object.hasOwn(value, "command") || value.type === "stdio" || value.transport === "stdio") {
      skipped.push({ name, reason: "stdio" }); continue;
    }
    const transport = value.type ?? value.transport ?? (value.url !== undefined ? "http" : undefined);
    if (transport !== "http" && transport !== "streamable-http" && transport !== "sse") {
      skipped.push({ name, reason: transport === undefined ? "invalid_definition" : "unsupported_transport" }); continue;
    }
    // Keep unsafe, credential-bearing and non-HTTPS URLs out of all receipts.
    if (!text(value.url, 2048) || !profileEndpoint(value.url)) {
      skipped.push({ name, reason: "invalid_endpoint" }); continue;
    }
    const headerMap = value.headers === undefined ? {} : catalogObject(value.headers);
    if (!headerMap || Object.keys(headerMap).length > MCP_REGISTRY_LIMITS.fields
      || Object.keys(headerMap).some(header => !/^[A-Za-z0-9-]{1,128}$/u.test(header))) {
      skipped.push({ name, reason: "invalid_definition" }); continue;
    }
    // Header values, environment variables, OAuth/client settings and launch
    // arguments are deliberately not part of the preview or the connection.
    const headers = Object.keys(headerMap), endpoint = publicMcpEndpoint(value.url);
    remotes.push({ name, endpoint: endpoint ?? value.url, transport: transport === "http" ? "streamable-http" : transport,
      mode: transport !== "sse" && endpoint && !/[{}]|%7[bd]/iu.test(value.url) && headers.length === 0
        && !["env", "auth", "authentication", "authorization", "oauth", "token"].some(key => Object.hasOwn(value, key)) ? "connect" : "configure",
      headers });
  }
  return { state: "previewed", format: "client_config", name: "MCP client configuration", version: "", description: "",
    schema: null, remotes, packages: [], skipped };
}

/** Official Registry server.json and common MCP client configurations are
 * previews only. Nothing here can launch a subprocess or persist credentials. */
export function previewRegistryEntry(raw: unknown): RegistryPreview | undefined {
  if (!catalogJson(raw, MCP_REGISTRY_LIMITS.bytes)) return undefined;
  const wrapper = catalogObject(raw), value = catalogObject(wrapper?.server) ?? wrapper;
  if (value && (Object.hasOwn(value, "mcpServers") || Object.hasOwn(value, "servers") || Object.hasOwn(value, "mcp"))) {
    return previewClientConfig(value);
  }
  if (!value || !text(value.name, 200) || !text(value.version, 128) || (value.description !== undefined && !text(value.description, 2048))
    || (value.$schema !== undefined && !text(value.$schema, 512))) return undefined;
  const rawRemotes = value.remotes ?? [], rawPackages = value.packages ?? [];
  if (!Array.isArray(rawRemotes) || rawRemotes.length > MCP_REGISTRY_LIMITS.remotes
    || !Array.isArray(rawPackages) || rawPackages.length > MCP_REGISTRY_LIMITS.packages || (!rawRemotes.length && !rawPackages.length)) return undefined;
  const remotes: RegistryCandidate[] = [];
  for (const raw of rawRemotes) {
    const remote = catalogObject(raw);
    if (!remote || !text(remote.type, 64) || !text(remote.url, 2048) || !profileEndpoint(remote.url)) return undefined;
    const headers = remote.headers ?? [];
    if (!Array.isArray(headers) || headers.length > MCP_REGISTRY_LIMITS.fields) return undefined;
    const names: string[] = [];
    for (const rawHeader of headers) {
      const header = catalogObject(rawHeader);
      if (!header || !text(header.name, 128)) return undefined;
      names.push(header.name);
    }
    const endpoint = publicMcpEndpoint(remote.url);
    // Header values, secrets, variables and package launch arguments stay out
    // of the response. Connecting remains the administrator's separate action.
    remotes.push({ endpoint: endpoint ?? remote.url, transport: remote.type,
      mode: endpoint && !/[{}]|%7[bd]/iu.test(remote.url) && remote.variables === undefined
        && remote.type === "streamable-http" && names.length === 0 ? "connect" : "configure", headers: names });
  }
  const packages: { registry: string; identifier: string; version: string }[] = [];
  for (const raw of rawPackages) {
    const pkg = catalogObject(raw);
    if (!pkg || !text(pkg.registryType, 64) || !text(pkg.identifier, 256) || (pkg.version !== undefined && !text(pkg.version, 128))) return undefined;
    packages.push({ registry: pkg.registryType, identifier: pkg.identifier, version: typeof pkg.version === "string" ? pkg.version : "" });
  }
  return { state: "previewed", name: value.name, version: value.version, description: typeof value.description === "string" ? value.description : "",
    schema: typeof value.$schema === "string" ? value.$schema : null, remotes, packages };
}
