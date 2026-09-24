import { CONNECTOR_LIMITS, type CentralAdministration, type ProfileCommand } from "../contracts/connectors.js";
import { parseProfile, parseProfileCommand } from "../contracts/connector-values.js";
import { admitCentralAdmin, centralFailure as fail, centralHeaders as headers } from "./central-boundary.js";
import { handleCentralCatalogAdmin } from "./central-catalog.js";
import { handleCentralDiscovery } from "./central-discovery.js";
import type { WorkerEnv } from "../platform/env.js";
import { handleCentralOAuth } from "./central-oauth.js";

/** Optional browser-admin JSON entry. No bearer-token fallback, plaintext read or MCP tool. */
export async function handleCentralAdmin(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  if (url.pathname.startsWith("/admin/central/oauth/")) return handleCentralOAuth(request, env, url);
  if (url.pathname.startsWith("/admin/central/discovery/")) return handleCentralDiscovery(request, env, url);
  if (url.pathname.startsWith("/admin/central/catalogs/")) return handleCentralCatalogAdmin(request, env, url);
  if (env.CAPABILITIES === undefined) { void request.body?.cancel().catch(() => undefined); return fail("central_disabled", 404); }
  const match = /^\/admin\/central\/profiles\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/u.exec(url.pathname);
  if (match === null || url.search) { void request.body?.cancel().catch(() => undefined); return fail("central_not_found", 404); }
  const admission = await admitCentralAdmin(request, env, CONNECTOR_LIMITS.request_bytes);
  if (admission instanceof Response) return admission;
  const profileId = match[1]!;
  let command: ProfileCommand | undefined;
  if (request.method === "POST") {
    if (Object.hasOwn(admission.body, "profile_id")) return fail("central_invalid_request", 400);
    command = parseProfileCommand({ ...admission.body, profile_id: profileId });
    if (command === undefined) return fail("central_invalid_request", 400);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const owner = env.CAPABILITIES.get(env.CAPABILITIES.idFromName("central")) as unknown as CentralAdministration;
    const result = await Promise.race([
      request.method === "GET" ? owner.getProfile(admission.session_hash, profileId) : owner.mutateProfile(admission.session_hash, command),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), CONNECTOR_LIMITS.operation_ms + 1_000); }),
    ]);
    if (typeof result !== "object" || result === null || Array.isArray(result)) return fail("central_result_unconfirmed", 503, "unknown");
    if (result.state === "found" || result.state === "written") {
      if ((result.state === "found") !== (request.method === "GET")) return fail("central_result_unconfirmed", 503, "unknown");
      const profile = parseProfile(result.profile);
      if (profile === undefined || profile.profile_id !== profileId) return fail("central_result_unconfirmed", 503, "unknown");
      if (result.state === "written") {
        if (command === undefined || profile.revision !== (command.action === "create" || command.action === "create_oauth" ? 1 : command.expected_revision + 1))
          return fail("central_result_unconfirmed", 503, "unknown");
        if (command.action === "create" && (profile.connector_id !== command.connector_id || profile.endpoint !== command.endpoint
          || profile.enabled || profile.credential?.secret_version !== 1)) return fail("central_result_unconfirmed", 503, "unknown");
        if (command.action === "create_oauth" && (profile.connector_id !== command.connector_id || profile.endpoint !== command.endpoint
          || profile.enabled || profile.credential !== null)) return fail("central_result_unconfirmed", 503, "unknown");
        if ((command.action === "enable" || command.action === "disable") && profile.enabled !== (command.action === "enable"))
          return fail("central_result_unconfirmed", 503, "unknown");
      }
      return Response.json({ state: result.state, profile }, { headers });
    }
    if (result.state === "conflict") {
      if (request.method !== "POST" || !Number.isSafeInteger(result.current_revision) || result.current_revision < 0)
        return fail("central_result_unconfirmed", 503, "unknown");
      return Response.json({ error: { code: "central_revision_conflict", operation_state: "not_started", current_revision: result.current_revision } }, { status: 409, headers });
    }
    const accepted = request.method === "GET" ? ["missing", "denied", "unavailable"]
      : ["invalid", "missing", "capacity", "denied", "unavailable", "unknown"];
    if (!accepted.includes(result.state)) return fail("central_result_unconfirmed", 503, "unknown");
    const status = result.state === "denied" ? 403 : result.state === "invalid" ? 400 : result.state === "missing" ? 404 : result.state === "capacity" ? 429 : 503;
    return fail(`central_${result.state}`, status, result.state === "unknown" ? "unknown" : "not_started");
  } catch { return fail("central_result_unconfirmed", 503, "unknown"); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
