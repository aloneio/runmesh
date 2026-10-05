import type { WorkerEnv } from "../platform/env.js";
import { connectionClientMetadata, parseManagedConnectionResult, type ManagedConnections } from "../contracts/managed-connections.js";
import { publicMcpEndpoint } from "../contracts/remote-values.js";
import { admitCentralAdmin, cancelCentralBody, centralFailure, centralHeaders } from "./central-boundary.js";
import { oauthLanding } from "./oauth-landing.js";
import { requestLocale } from "../i18n/locale.js";
import { resolvePublicOrigin } from "../public-origin.js";

function connectionOrigin(request: Request, configured?: string): string {
  const origin = configured ?? resolvePublicOrigin(request);
  if (publicMcpEndpoint(origin) === undefined || new URL(origin).origin !== origin) throw new Error("invalid OAuth origin");
  return origin;
}

export async function handleConnections(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const action = url.pathname.slice("/admin/central/connections/".length);
  if (!env.CAPABILITIES) { cancelCentralBody(request); return centralFailure("central_disabled", 404); }
  if (action === "client-metadata" && request.method === "GET" && !url.search) {
    try {
      const origin = connectionOrigin(request, env.RUNMESH_PUBLIC_ORIGIN);
      return Response.json({ client_id: origin + "/admin/central/connections/client-metadata", ...connectionClientMetadata(origin) }, { headers: centralHeaders });
    } catch { return centralFailure("oauth_unavailable", 503); }
  }
  if (action === "callback" && request.method === "GET" && url.href.length <= 8192) return oauthLanding(requestLocale(request));
  if (!["begin", "complete", "revoke"].includes(action) || request.method !== "POST" || url.search) { cancelCentralBody(request); return centralFailure("central_not_found", 404); }
  const admission = await admitCentralAdmin(request, env, 16_384); if (admission instanceof Response) return admission;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const origin = action === "revoke" ? env.RUNMESH_PUBLIC_ORIGIN : connectionOrigin(request, env.RUNMESH_PUBLIC_ORIGIN);
    const owner = env.CAPABILITIES.get(env.CAPABILITIES.idFromName("central")) as unknown as ManagedConnections;
    const raw = await Promise.race([owner.connectionOAuth(admission.session_hash, action as "begin" | "complete" | "revoke", admission.body, origin),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 22_000); })]);
    const result = parseManagedConnectionResult(raw, origin ?? url.origin);
    if (!result) return centralFailure("oauth_unavailable", 503, "unknown");
    if (result.state === "failed") return centralFailure("oauth_" + result.code, result.code === "denied" ? 403 : result.code === "conflict" ? 409 : ["invalid_request", "invalid_callback"].includes(result.code) ? 400 : 503, result.operation_state);
    if ((action === "begin" && result.state !== "started") || (action === "complete" && result.state !== "linked") || (action === "revoke" && result.state !== "revoked")) return centralFailure("oauth_unavailable", 503, "unknown");
    if (action !== "complete" && result.profile_id !== admission.body.profile_id) return centralFailure("oauth_unavailable", 503, "unknown");
    return Response.json(result, { headers: centralHeaders });
  } catch { return centralFailure("oauth_unavailable", 503, "unknown"); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
