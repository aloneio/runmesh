/** Service metadata is validated without importing DOM workflows into the API. */
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
    && (value.schema === null || typeof value.schema === 'string')
    && typeof value.digest === 'string' && /^[a-f0-9]{64}$/.test(value.digest)
    && Number.isSafeInteger(value.observed_at_ms) && value.observed_at_ms > 0
    && Array.isArray(value.remotes) && value.remotes.every(remote => typeof remote?.endpoint === 'string'
      && (remote.mode !== 'connect' || remote.endpoint.startsWith('https://')) && typeof remote.transport === 'string' && ['connect', 'configure'].includes(remote.mode)
      && Array.isArray(remote.headers) && remote.headers.every(header => typeof header === 'string'))
    && Array.isArray(value.packages) && value.packages.every(item => item && ['registry', 'identifier', 'version'].every(key => typeof item[key] === 'string'));
}
