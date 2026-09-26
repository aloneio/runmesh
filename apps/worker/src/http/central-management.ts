import type { WorkerEnv } from "../platform/env.js";
import type { CentralManagement } from "../contracts/central-management.js";
import { isCapabilityIdentifier } from "../contracts/capabilities.js";
import { CONNECTOR_LIMITS } from "../contracts/connectors.js";
import { parseProfile } from "../contracts/connector-values.js";
import { admitCentralAdmin, cancelCentralBody, centralFailure, centralHeaders } from "./central-boundary.js";

export async function handleCentralManagement(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  if (url.pathname !== "/admin/central/profiles" || request.method !== "GET" || [...url.searchParams.keys()].some(k => k !== "after") || url.searchParams.getAll("after").length > 1) {
    cancelCentralBody(request); return centralFailure("central_invalid_request", 400);
  }
  const admission = await admitCentralAdmin(request, env, CONNECTOR_LIMITS.request_bytes);
  if (admission instanceof Response) return admission;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const owner = env.CAPABILITIES!.get(env.CAPABILITIES!.idFromName("central")) as unknown as CentralManagement;
    const result = await Promise.race([owner.listProfiles(admission.session_hash, url.searchParams.get("after") ?? undefined),
    new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 6000); })]);
    if (!result || typeof result !== "object") return centralFailure("central_result_unconfirmed", 503, "unknown");
    if (result.state === "listed") {
      if (!Array.isArray(result.profiles) || (result.next_after !== null && !isCapabilityIdentifier(result.next_after))) return centralFailure("central_result_unconfirmed", 503);
      const profiles = result.profiles.map(parseProfile);
      if (profiles.length > 50 || profiles.some(p => p === undefined)) return centralFailure("central_result_unconfirmed", 503);
      return Response.json({ state: "listed", profiles, next_after: result.next_after }, { headers: centralHeaders });
    }
    const status = result.state === "denied" ? 403 : result.state === "invalid" ? 400 : result.state === "missing" ? 404 : 503;
    if (!["denied", "invalid", "missing", "unavailable"].includes(result.state)) return centralFailure("central_result_unconfirmed", 503, "unknown");
    return Response.json({ state: result.state }, { status, headers: centralHeaders });
  } catch { return centralFailure("central_result_unconfirmed", 503, "unknown"); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
