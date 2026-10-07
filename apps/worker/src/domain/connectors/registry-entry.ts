import { MCP_REGISTRY_LIMITS, type RegistryCandidate, type RegistryPreview } from "../../contracts/mcp-registry.js";
import { catalogObject, catalogJson } from "../../contracts/catalog-json.js";
import { publicMcpEndpoint } from "../../contracts/remote-values.js";
import { profileEndpoint } from "../../contracts/connector-values.js";

const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0
  && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);

/** Official server.json metadata is a source of form values, never authority. */
export function previewRegistryEntry(raw: unknown): RegistryPreview | undefined {
  if (!catalogJson(raw, MCP_REGISTRY_LIMITS.bytes)) return undefined;
  const wrapper = catalogObject(raw), value = catalogObject(wrapper?.server) ?? wrapper;
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
