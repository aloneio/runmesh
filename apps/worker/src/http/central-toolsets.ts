import type { ToolsetAdministration } from "../contracts/toolsets.js";
import type { WorkerEnv } from "../platform/env.js";
import { parseCapabilityGrant } from "../contracts/capabilities.js";
import { admitCentralAdmin, centralFailure, centralHeaders, cancelCentralBody } from "./central-boundary.js";
export async function handleCentralToolsets(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const id = url.pathname.slice('/admin/central/toolsets/'.length);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id) || url.search) { cancelCentralBody(request); return centralFailure('central_invalid_request', 400); }
  const admission = await admitCentralAdmin(request, env, 65_536); if (admission instanceof Response) return admission;
  if (Object.hasOwn(admission.body, 'toolset_id')) return centralFailure('central_invalid_request', 400);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const owner = env.CAPABILITIES!.get(env.CAPABILITIES!.idFromName('central')) as unknown as ToolsetAdministration;
    const result = await Promise.race([request.method === 'GET' ? owner.getToolset(admission.session_hash, id) : owner.mutateToolset(admission.session_hash, { ...admission.body, toolset_id: id }),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 6000); })]);
    if (!result) return centralFailure('central_result_unconfirmed', 503, 'unknown');
    let safe: Record<string, unknown>;
    if (result.state === 'found' || result.state === 'written') {
      if ('toolset' in result) {
        const value = result.toolset, grant = parseCapabilityGrant({ ...value, client_id: id });
        if (!grant || value.toolset_id !== id) return centralFailure('central_result_unconfirmed', 503, 'unknown');
        safe = { state: result.state, toolset: { schema_version: 1, toolset_id: id, revision: grant.revision, enabled: grant.enabled, rules: grant.rules } };
      } else {
        const grant = parseCapabilityGrant(result.grant);
        if (!grant || admission.body.action !== 'apply' || grant.client_id !== admission.body.client_id) return centralFailure('central_result_unconfirmed', 503, 'unknown');
        safe = { state: result.state, grant };
      }
    } else if (result.state === 'conflict' && Number.isSafeInteger(result.current_revision) && result.current_revision >= 0) {
      safe = { state: result.state, current_revision: result.current_revision };
    } else if (['invalid', 'denied', 'missing', 'capacity', 'unavailable'].includes(result.state)) safe = { state: result.state };
    else return centralFailure('central_result_unconfirmed', 503, 'unknown');
    return Response.json(safe, { status: ['found', 'written'].includes(result.state) ? 200 : result.state === 'invalid' ? 400 : result.state === 'denied' ? 403 : result.state === 'missing' ? 404 : result.state === 'conflict' ? 409 : result.state === 'capacity' ? 429 : 503, headers: centralHeaders });
  } catch { return centralFailure('central_result_unconfirmed', 503, 'unknown'); } finally { if (timer !== undefined) clearTimeout(timer); }
}
