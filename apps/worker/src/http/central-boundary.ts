import { readCappedBytes } from "../body.js";
import type { WorkerEnv } from "../platform/env.js";
import { adminSession, verifyAdminPost } from "./session.js";

export const centralHeaders = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
export const centralFailure = (code: string, status: number, operation_state = "not_started"): Response =>
  Response.json({ error: { code, operation_state } }, { status, headers: centralHeaders });
export const cancelCentralBody = (request: Request): void => { void request.body?.cancel().catch(() => undefined); };

/** Shared browser boundary, not a second authorization policy. State owners
 * revalidate the same Registry session before committing their own mutations. */
export async function admitCentralAdmin(request: Request, env: WorkerEnv, maxBytes: number): Promise<Response | { session_hash: string; body: Record<string, unknown> }> {
  if (env.CAPABILITIES === undefined) { cancelCentralBody(request); return centralFailure("central_disabled", 404); }
  if (request.method !== "GET" && request.method !== "POST") { cancelCentralBody(request); return centralFailure("central_method_not_allowed", 405); }
  const admission = await adminSession(request, env);
  if (admission.state !== "allowed") {
    cancelCentralBody(request);
    return centralFailure(admission.state === "denied" ? "central_admin_denied" : "central_authority_unavailable", admission.state === "denied" ? 403 : 503);
  }
  let body: Record<string, unknown> = {};
  if (request.method === "POST") {
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      cancelCentralBody(request); return centralFailure("central_invalid_request", 400);
    }
    const form = new FormData(); form.set("csrf_token", request.headers.get("x-csrf-token") ?? "");
    if (!await verifyAdminPost(request, form, admission.session, env)) { cancelCentralBody(request); return centralFailure("central_admin_denied", 403); }
    const bytes = await readCappedBytes(request, maxBytes);
    if (bytes === undefined) return centralFailure("central_request_too_large", 413);
    try {
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (typeof value !== "object" || value === null || Array.isArray(value)) return centralFailure("central_invalid_request", 400);
      body = value as Record<string, unknown>;
    } catch { return centralFailure("central_invalid_request", 400); }
  }
  const final = await adminSession(request, env);
  if (final.state !== "allowed" || final.session.hash !== admission.session.hash)
    return centralFailure(final.state === "unavailable" ? "central_authority_unavailable" : "central_admin_denied", final.state === "unavailable" ? 503 : 403);
  return { session_hash: final.session.hash, body };
}
