const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const owns = (value, key) => Object.hasOwn(value, key);
const picked = (value, fields) => Object.fromEntries(fields.filter(field => owns(value, field)).map(field => [field, value[field]]));

/** Keep credential-bearing URLs off the wire, even on invalid imports. */
function safeEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash ? value : '';
  } catch { return ''; }
}

function projectedHeaders(value) {
  const headers = record(value);
  if (!headers || Object.keys(headers).length > 32 || Object.keys(headers).some(name => !/^[A-Za-z0-9-]{1,128}$/.test(name))) return null;
  return Object.fromEntries(Object.keys(headers).map(name => [name, '']));
}

function clientServer(value) {
  const server = record(value);
  if (!server) return {};
  if (owns(server, 'command') || server.type === 'stdio' || server.transport === 'stdio') return { type: 'stdio' };
  const result = {};
  if (owns(server, 'type')) result.type = ['http', 'streamable-http', 'sse'].includes(server.type) ? server.type : 'unsupported';
  if (owns(server, 'transport')) result.transport = ['http', 'streamable-http', 'sse'].includes(server.transport) ? server.transport : 'unsupported';
  if (owns(server, 'url')) result.url = safeEndpoint(server.url);
  if (owns(server, 'headers')) result.headers = projectedHeaders(server.headers);
  // Only presence indicators are retained. Values, args and launch settings
  // never leave the browser, including values embedded in unknown properties.
  for (const key of ['env', 'auth', 'authentication', 'authorization', 'oauth', 'token']) {
    if (owns(server, key)) result[key] = {};
  }
  return result;
}

function registryServer(value) {
  const server = record(value);
  if (!server) return {};
  const result = picked(server, ['$schema', 'name', 'version', 'description']);
  if (owns(server, 'remotes')) result.remotes = Array.isArray(server.remotes) ? server.remotes.map(remote => {
    const item = record(remote);
    if (!item) return null;
    const entry = picked(item, ['type']);
    if (owns(item, 'url')) entry.url = safeEndpoint(item.url);
    if (owns(item, 'variables')) entry.variables = {};
    if (owns(item, 'headers')) entry.headers = Array.isArray(item.headers) ? item.headers.map(header => {
      const h = record(header);
      return { name: h && typeof h.name === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(h.name) ? h.name : '' };
    }) : null;
    return entry;
  }) : null;
  if (owns(server, 'packages')) result.packages = Array.isArray(server.packages)
    ? server.packages.map(item => record(item) ? picked(item, ['registryType', 'identifier', 'version']) : null) : null;
  return result;
}

/** Untrusted import files are parsed locally. Only allowlisted connection
 * metadata is submitted for preview; never upload secrets, commands or args. */
export function sanitizeRegistryUpload(raw) {
  const value = record(raw);
  if (!value) return {};
  if (owns(value, 'mcpServers') || owns(value, 'servers') || owns(value, 'mcp')) {
    const nested = record(value.mcp);
    const kind = owns(value, 'mcpServers') ? 'mcpServers' : owns(value, 'servers') ? 'servers' : 'mcp';
    const servers = record(kind === 'mcp' ? nested?.servers : value[kind]);
    if (!servers) return {};
    const mapped = Object.fromEntries(Object.entries(servers).map(([name, item]) => [name, clientServer(item)]));
    return kind === 'mcp' ? { mcp: { servers: mapped } } : { [kind]: mapped };
  }
  if (owns(value, 'server')) return { server: registryServer(value.server) };
  return registryServer(value);
}
