import type { WorkerEnv } from "../platform/env.js";
import { REMOTE_CODES, REMOTE_LIMITS, type CentralRemote } from "../contracts/remote.js";
import { catalogKeys, catalogRevision } from "../contracts/catalog-json.js";
import { parseCatalogHead } from "../contracts/catalog-values.js";
import { parseOAuthSelection } from "../contracts/oauth-values.js";
import { admitCentralAdmin, cancelCentralBody, centralHeaders, centralFailure } from "./central-boundary.js";

export async function handleCentralDiscovery(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const match = /^\/admin\/central\/discovery\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/u.exec(url.pathname);
  if (match === null || url.search || env.CAPABILITIES === undefined) {
    cancelCentralBody(request); return centralFailure("central_disabled", 404);
  }
  if (request.method !== "POST") { cancelCentralBody(request); return centralFailure("central_method_not_allowed", 405); }
  const admission = await admitCentralAdmin(request, env, 1024);
  if (admission instanceof Response) return admission;
  if (!catalogKeys(admission.body, ["expected_revision", "principal"]) || !catalogRevision(admission.body.expected_revision, true)) return centralFailure("central_invalid_request", 400);
  const profileId = match[1]!, revision = admission.body.expected_revision;
  const selected = admission.body.principal === undefined ? undefined : parseOAuthSelection({ profile_id: profileId, principal: admission.body.principal, expected_revision: revision });
  if (admission.body.principal !== undefined && selected === undefined) return centralFailure("central_invalid_request", 400);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const owner = env.CAPABILITIES.get(env.CAPABILITIES.idFromName("central")) as unknown as CentralRemote;
    const result = await Promise.race([owner.discoverRemote(admission.session_hash, profileId, revision, selected?.principal),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), REMOTE_LIMITS.operation_ms + 2000); })]);
    if (result?.state === "written") {
      const head = parseCatalogHead(result.head);
      if (head?.profile_id === profileId && head.revision === revision + 1) return Response.json({ state: "written", head }, { headers: centralHeaders });
    } else if (result?.state === "conflict" && catalogRevision(result.current_revision, true)) {
      return Response.json({ error: { code: "central_revision_conflict", operation_state: "not_started", current_revision: result.current_revision } }, { status: 409, headers: centralHeaders });
    } else if (result?.state === "failed" && REMOTE_CODES.includes(result.code) && ["not_started", "unknown"].includes(result.operation_state)) {
      return centralFailure(`remote_${result.code}`, result.code === "permission_denied" ? 403 : result.code === "busy" ? 429 : 503, result.operation_state);
    } else if (result && ["invalid", "missing", "denied", "unavailable", "capacity", "stale_profile", "unknown"].includes(result.state)) {
      return centralFailure(`central_${result.state}`, result.state === "denied" ? 403 : result.state === "invalid" ? 400 : 503, result.state === "unknown" ? "unknown" : "not_started");
    }
    return centralFailure("central_result_unconfirmed", 503, "unknown");
  } catch { return centralFailure("central_result_unconfirmed", 503, "unknown"); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
