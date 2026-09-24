import { CONNECTOR_LIMITS, type CentralAdministration, type ProfileCommand } from "../contracts/connectors.js";
import { parseProfile, parseProfileCommand } from "../contracts/connector-values.js";
import { readCappedBytes } from "../body.js";
import { adminSession, verifyAdminPost } from "./session.js";
import type { WorkerEnv } from "../platform/env.js";

const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
const fail = (code: string, status: number, operation_state = "not_started") => Response.json({ error: { code, operation_state } }, { status, headers });

/** Optional browser-admin JSON entry. No bearer-token fallback, plaintext read or MCP tool. */
export async function handleCentralAdmin(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  if (env.CAPABILITIES === undefined) { void request.body?.cancel().catch(() => undefined); return fail("central_disabled", 404); }
  const match = /^\/admin\/central\/profiles\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/u.exec(url.pathname);
  if (match === null || url.search) { void request.body?.cancel().catch(() => undefined); return fail("central_not_found", 404); }
  if (request.method !== "GET" && request.method !== "POST") { void request.body?.cancel().catch(() => undefined); return fail("central_method_not_allowed", 405); }
  const admission = await adminSession(request, env);
  if (admission.state !== "allowed") {
    void request.body?.cancel().catch(() => undefined);
    return fail(admission.state === "denied" ? "central_admin_denied" : "central_authority_unavailable", admission.state === "denied" ? 403 : 503);
  }
  const profileId = match[1]!;
  let command: ProfileCommand | undefined;
  if (request.method === "POST") {
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      void request.body?.cancel().catch(() => undefined); return fail("central_invalid_request", 400);
    }
    const form = new FormData(); form.set("csrf_token", request.headers.get("x-csrf-token") ?? "");
    if (!await verifyAdminPost(request, form, admission.session, env)) {
      void request.body?.cancel().catch(() => undefined); return fail("central_admin_denied", 403);
    }
    const body = await readCappedBytes(request, CONNECTOR_LIMITS.request_bytes);
    if (body === undefined) return fail("central_request_too_large", 413);
    try {
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
      if (typeof value !== "object" || value === null || Array.isArray(value) || Object.hasOwn(value, "profile_id")) return fail("central_invalid_request", 400);
      command = parseProfileCommand({ ...value, profile_id: profileId });
      if (command === undefined) return fail("central_invalid_request", 400);
    } catch { return fail("central_invalid_request", 400); }
  }
  // Body/CSRF waits cannot preserve an obsolete administrative session.
  const final = await adminSession(request, env);
  if (final.state !== "allowed" || final.session.hash !== admission.session.hash)
    return fail(final.state === "unavailable" ? "central_authority_unavailable" : "central_admin_denied", final.state === "unavailable" ? 503 : 403);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const owner = env.CAPABILITIES.get(env.CAPABILITIES.idFromName("central")) as unknown as CentralAdministration;
    const result = await Promise.race([
      request.method === "GET" ? owner.getProfile(final.session.hash, profileId) : owner.mutateProfile(final.session.hash, command),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), CONNECTOR_LIMITS.operation_ms + 1_000); }),
    ]);
    if (typeof result !== "object" || result === null || Array.isArray(result)) return fail("central_result_unconfirmed", 503, "unknown");
    if (result.state === "found" || result.state === "written") {
      if ((result.state === "found") !== (request.method === "GET")) return fail("central_result_unconfirmed", 503, "unknown");
      const profile = parseProfile(result.profile);
      if (profile === undefined || profile.profile_id !== profileId) return fail("central_result_unconfirmed", 503, "unknown");
      if (result.state === "written") {
        if (command === undefined || profile.revision !== (command.action === "create" ? 1 : command.expected_revision + 1))
          return fail("central_result_unconfirmed", 503, "unknown");
        if (command.action === "create" && (profile.connector_id !== command.connector_id || profile.endpoint !== command.endpoint
          || profile.enabled || profile.credential?.secret_version !== 1)) return fail("central_result_unconfirmed", 503, "unknown");
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
