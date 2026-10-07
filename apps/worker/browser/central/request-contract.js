export const serviceOperationScope = profileId => 'mcp:' + profileId;

/** A request's recovery scope is independent of DOM locks and workflow controllers. */
export function centralRequestScope(path, body) {
  const [kind, id] = path.split('?')[0].split('/');
  if (kind === 'profiles' && body?.action === 'connect') return 'mcp-create';
  if (['profiles', 'catalogs', 'discovery'].includes(kind) && id) return serviceOperationScope(decodeURIComponent(id));
  if (kind === 'connections' || kind === 'connection-check') return body?.profile_id ? serviceOperationScope(body.profile_id) : 'mcp-create';
  if (kind === 'registry-preview') return 'mcp-create';
  return kind === 'profiles' ? 'mcp-list' : 'skills';
}

function skillLifecycleRequest(path, body) {
  const match = /^skills\/([^/]+)\/(versions|compare|retention|cleanup-preview|cleanup)$/.exec(path);
  if (!match) return null;
  const [, encodedId, operation] = match;
  return { id: decodeURIComponent(encodedId), operation,
    readOnly: body === undefined || operation === 'compare' || operation === 'cleanup-preview',
    state: { versions: 'listed', compare: 'compared', retention: 'retained', 'cleanup-preview': 'previewed', cleanup: 'cleaned' }[operation] };
}

/** Keep write admission, timeout selection and success receipts on one request contract. */
export function centralRequestContract(path, body, missing = false) {
  const lifecycle = skillLifecycleRequest(path, body);
  const route = path.split('?')[0];
  const collection = body === undefined && ['profiles', 'skills'].includes(route) ? route : null;
  const sourceAction = path === 'skill-source/preview' ? 'preview' : path === 'skill-source/install' ? 'install' : null;
  const inspection = path === 'connection-check', registry = path === 'registry-preview';
  const mutation = body !== undefined && body.action !== 'preview' && !lifecycle?.readOnly
    && sourceAction !== 'preview' && !inspection && !registry;
  let states = ['written'];
  if (lifecycle) states = [lifecycle.state];
  else if (inspection) states = ['inspected', 'authorization_required'];
  else if (sourceAction === 'preview' || registry || body?.action === 'preview') states = ['previewed'];
  else if (body === undefined) states = [collection ? 'listed' : 'found'];
  else if (path === 'skill-installations') states = ['installed'];
  else if (path === 'connections/begin') states = ['started'];
  else if (path === 'connections/revoke') states = ['revoked'];
  const optionalCatalog = missing && body === undefined && path.startsWith('catalogs/');
  if (optionalCatalog) states.push('empty');
  if (body && path.startsWith('discovery/')) states.push('authorization_required');
  return { path, body, scope: centralRequestScope(path, body), mutation, states, collection, lifecycle, sourceAction, inspection, registry, optionalCatalog };
}
