import type { WorkerEnv } from "../platform/env.js";
import type { CentralManagement } from "../contracts/central-management.js";
import { CAPABILITY_LIMITS, isCapabilityIdentifier, parseCapabilityGrant } from "../contracts/capabilities.js";
import { parseProfile } from "../contracts/connector-values.js";
import { admitCentralAdmin, cancelCentralBody, centralFailure, centralHeaders } from "./central-boundary.js";

export async function handleCentralManagement(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const list = url.pathname === "/admin/central/profiles", id = url.pathname.slice("/admin/central/grants/".length);
  if (list ? request.method !== "GET" || [...url.searchParams.keys()].some(k => k !== "after") || url.searchParams.getAll("after").length > 1
    : !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id) || !!url.search) {
    cancelCentralBody(request); return centralFailure("central_invalid_request", 400);
  }
  const admission = await admitCentralAdmin(request, env, CAPABILITY_LIMITS.grant_bytes);
  if (admission instanceof Response) return admission;
  if (Object.hasOwn(admission.body, "client_id")) return centralFailure("central_invalid_request", 400);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const owner = env.CAPABILITIES!.get(env.CAPABILITIES!.idFromName("central")) as unknown as CentralManagement;
    const result = await Promise.race([list ? owner.listProfiles(admission.session_hash, url.searchParams.get("after") ?? undefined)
      : request.method === "GET" ? owner.getClientGrant(admission.session_hash, id) : owner.setClientGrant(admission.session_hash, { ...admission.body, client_id: id }),
    new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 6000); })]);
    if (!result || typeof result !== "object") return centralFailure("central_result_unconfirmed", 503, "unknown");
    if (result.state === "found" || result.state === "written") {
      const grant = parseCapabilityGrant(result.grant);
      if (!grant || grant.client_id !== id || list) return centralFailure("central_result_unconfirmed", 503, "unknown");
      return Response.json({ state: result.state, grant }, { headers: centralHeaders });
    }
    if (result.state === "listed") {
      if (!Array.isArray(result.profiles) || (result.next_after !== null && !isCapabilityIdentifier(result.next_after))) return centralFailure("central_result_unconfirmed", 503);
      const profiles = result.profiles.map(parseProfile);
      if (!list || profiles.length > 50 || profiles.some(p => p === undefined)) return centralFailure("central_result_unconfirmed", 503);
      return Response.json({ state: "listed", profiles, next_after: result.next_after }, { headers: centralHeaders });
    }
    const status = result.state === "conflict" ? 409 : result.state === "denied" ? 403 : result.state === "invalid" ? 400 : result.state === "missing" ? 404 : result.state === "capacity" ? 429 : 503;
    if (result.state === "conflict") {
      if (!Number.isSafeInteger(result.current_revision) || result.current_revision < 0) return centralFailure("central_result_unconfirmed", 503, "unknown");
      return Response.json({ state: result.state, current_revision: result.current_revision }, { status, headers: centralHeaders });
    }
    if (!["denied", "invalid", "missing", "capacity", "unavailable"].includes(result.state)) return centralFailure("central_result_unconfirmed", 503, "unknown");
    return Response.json({ state: result.state }, { status, headers: centralHeaders });
  } catch { return centralFailure("central_result_unconfirmed", 503, "unknown"); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
