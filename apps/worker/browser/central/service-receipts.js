/** Service metadata is validated without importing DOM workflows into the API. */
export function validProfileWriteReceipt(request, value) {
  const profile = value.profile;
  return profile?.profile_id === request.id && Number.isSafeInteger(profile?.revision) && profile.revision >= 1
    && typeof profile.enabled === 'boolean' && ['none', 'oauth'].includes(profile.authentication);
}

export function validAuthorizationStartReceipt(value) {
  if (typeof value.authorization_url !== 'string' || !value.authorization_url.trim()) return false;
  try { new URL(value.authorization_url, 'https://runmesh.invalid'); return true; }
  catch { return false; }
}

export function validServiceInspection(value) {
  if (value.state === 'authorization_required') return true;
  const server = value.server, capabilities = server?.capabilities;
  return typeof value.endpoint === 'string' && value.endpoint.startsWith('https://')
    && typeof server?.protocol_version === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(server.protocol_version)
    && capabilities && ['tools', 'resources', 'prompts', 'tasks', 'apps'].every(key => typeof capabilities[key] === 'boolean')
    && (capabilities.tools ? Number.isSafeInteger(value.tools_count) && value.tools_count >= 0 : value.tools_count === null)
    && Number.isSafeInteger(value.observed_at_ms) && value.observed_at_ms > 0;
}

export function validRegistryPreview(value) {
  return ['name', 'version', 'description'].every(key => typeof value[key] === 'string')
    && (value.format === undefined || value.format === 'client_config')
    && (value.schema === null || typeof value.schema === 'string')
    && typeof value.digest === 'string' && /^[a-f0-9]{64}$/.test(value.digest)
    && Number.isSafeInteger(value.observed_at_ms) && value.observed_at_ms > 0
    && Array.isArray(value.remotes) && value.remotes.length <= 32 && value.remotes.every(remote => typeof remote?.endpoint === 'string'
      && remote.endpoint.startsWith('https://') && remote.endpoint.length <= 2048 && !/[?#\u0000-\u0020\u007f\\]/.test(remote.endpoint)
      && !/^https:\/\/[^/]*@/.test(remote.endpoint)
      && (remote.name === undefined || typeof remote.name === 'string' && remote.name.length > 0 && remote.name.length <= 128)
      && typeof remote.transport === 'string' && ['connect', 'configure'].includes(remote.mode)
      && Array.isArray(remote.headers) && remote.headers.length <= 32 && remote.headers.every(header => typeof header === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(header)))
    && Array.isArray(value.packages) && value.packages.length <= 16
    && value.packages.every(item => item && ['registry', 'identifier', 'version'].every(key => typeof item[key] === 'string'))
    && (value.skipped === undefined || value.format === 'client_config' && Array.isArray(value.skipped)
      && value.skipped.length <= 32 && value.skipped.every(item => item && typeof item.name === 'string' && item.name.length > 0
        && item.name.length <= 128 && ['stdio', 'unsupported_transport', 'invalid_endpoint', 'invalid_definition'].includes(item.reason)));
}
