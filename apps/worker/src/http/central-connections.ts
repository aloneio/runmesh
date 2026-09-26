import type { WorkerEnv } from "../platform/env.js";
import { connectionClientMetadata, type ManagedConnections } from "../contracts/managed-connections.js";
import { publicMcpEndpoint } from "../contracts/remote-values.js";
import { admitCentralAdmin, cancelCentralBody, centralFailure, centralHeaders } from "./central-boundary.js";
import { oauthLanding } from "./oauth-landing.js";

export async function handleConnections(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const action = url.pathname.slice("/admin/central/connections/".length), origin = env.RUNMESH_PUBLIC_ORIGIN;
  if (!env.CAPABILITIES) { cancelCentralBody(request); return centralFailure("central_disabled", 404); }
  if (action === "client-metadata" && request.method === "GET" && !url.search) {
    if (!origin || publicMcpEndpoint(origin) === undefined || new URL(origin).origin !== origin) return centralFailure("oauth_unavailable", 503);
    return Response.json({ client_id: origin + "/admin/central/connections/client-metadata", ...connectionClientMetadata(origin) }, { headers: centralHeaders });
  }
  if (action === "callback" && request.method === "GET" && url.href.length <= 8192) return oauthLanding(true);
  if (!["begin", "complete", "revoke"].includes(action) || request.method !== "POST" || url.search) { cancelCentralBody(request); return centralFailure("central_not_found", 404); }
  const admission = await admitCentralAdmin(request, env, 16_384); if (admission instanceof Response) return admission;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const owner = env.CAPABILITIES.get(env.CAPABILITIES.idFromName("central")) as unknown as ManagedConnections;
    const result = await Promise.race([owner.connectionOAuth(admission.session_hash, action as "begin" | "complete" | "revoke", admission.body, origin),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 22_000); })]);
    if (!result) return centralFailure("oauth_unavailable", 503, "unknown");
    if (result.state === "failed") return centralFailure("oauth_" + result.code, result.code === "denied" ? 403 : result.code === "conflict" ? 409 : ["invalid_request", "invalid_callback"].includes(result.code) ? 400 : 503, result.operation_state);
    if ((action === "begin" && result.state !== "started") || (action === "complete" && result.state !== "linked") || (action === "revoke" && result.state !== "revoked")) return centralFailure("oauth_unavailable", 503, "unknown");
    return Response.json(result, { headers: centralHeaders });
  } catch { return centralFailure("oauth_unavailable", 503, "unknown"); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
