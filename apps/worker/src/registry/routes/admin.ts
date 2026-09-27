import type { RegistryRoute } from "./request.js";
import type { AuthThrottleKind } from "../records.js";
import { parseAdminSession } from "../route-inputs.js";
import { registryInputError } from "../route-projections.js";
import { stringField, integerField, validVerifier, authThrottleKind } from "../values.js";

export interface AdminRoutePorts {
  consumeInternalNonce(nonce: string, expiresAtMs: number, nowMs?: number): boolean;
  adminStatus(): { initialized: boolean };
  settings(): { password_verifier: string; session_version: number } | undefined;
  setupAdmin(passwordVerifier: string, nowMs: number): boolean;
  checkSourceAuthThrottle(kind: AuthThrottleKind, sourceHash: string, nowMs: number): { allowed: boolean; retry_after_ms: number };
  recordSourceAuthAttempt(kind: AuthThrottleKind, sourceHash: string, success: boolean, nowMs: number): void;
  createAdminSession(sessionHash: string, csrfHash: string, expiresAtMs: number, nowMs: number, expectedSessionVersion: number): boolean;
  verifyAdminSession(sessionHash: string, nowMs: number): { csrf_hash: string } | undefined;
  logoutAdminSession(sessionHash: string): void;
  changeAdminPassword(passwordVerifier: string, nowMs: number): boolean;
}

/** Parsing and responses only; authority and transactions stay with RegistryDO. */
export function createAdminRoutes(ports: AdminRoutePorts): RegistryRoute {
  return ({ method, segments, input, nowMs }) => {
    const action = segments[0]; const clientId = segments[1];
    if (method === "POST" && action === "internal-nonces" && clientId === undefined) {
      const nonce = stringField(input, "nonce", 64); const expiresAtMs = integerField(input, "expires_at_ms");
      return nonce === undefined || expiresAtMs === undefined || !ports.consumeInternalNonce(nonce, expiresAtMs, nowMs)
        ? new Response("not found", { status: 404 })
        : new Response(null, { status: 204 });
    }
    if (method === "GET" && action === "status" && clientId === undefined) return Response.json(ports.adminStatus());
    if (method === "GET" && action === "settings" && clientId === undefined) { const settings = ports.settings(); return settings === undefined ? new Response("not found", { status: 404 }) : Response.json({ password_verifier: settings.password_verifier, session_version: settings.session_version }); }
    if (method === "POST" && action === "setup" && clientId === undefined) { const verifier = stringField(input, "password_verifier", 4_096); return verifier === undefined ? Response.json({ error: "invalid verifier" }, { status: 400 }) : ports.setupAdmin(verifier, nowMs) ? new Response(null, { status: 204 }) : new Response("already initialized", { status: 409 }); }
    if (method === "POST" && action === "throttle" && clientId === "check") {
      const kind = authThrottleKind(input.kind);
      const sourceHash = stringField(input, "source_hash", 64);
      return kind === undefined || sourceHash === undefined || !validVerifier(sourceHash) ? Response.json({ error: "invalid throttle source" }, { status: 400 }) : Response.json(ports.checkSourceAuthThrottle(kind, sourceHash, nowMs));
    }
    if (method === "POST" && action === "throttle" && clientId === "record") {
      const kind = authThrottleKind(input.kind);
      const sourceHash = stringField(input, "source_hash", 64);
      if (kind === undefined || sourceHash === undefined || !validVerifier(sourceHash) || typeof input.success !== "boolean") return Response.json({ error: "invalid throttle record" }, { status: 400 });
      ports.recordSourceAuthAttempt(kind, sourceHash, input.success, nowMs);
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && action === "sessions" && clientId === undefined) {
      const parsed = parseAdminSession(input, nowMs);
      if (!parsed.ok) return registryInputError(parsed);
      const { sessionHash, csrfHash, expires, expectedVersion } = parsed.value;
      return ports.createAdminSession(sessionHash, csrfHash, expires, nowMs, expectedVersion)
        ? new Response(null, { status: 204 }) : new Response("authentication generation changed", { status: 409 });
    }
    if (method === "POST" && action === "sessions" && clientId === "verify") { const sessionHash = stringField(input, "session_hash", 64); if (sessionHash === undefined || !validVerifier(sessionHash)) return new Response("not found", { status: 404 }); const session = ports.verifyAdminSession(sessionHash, nowMs); return session === undefined ? new Response("not found", { status: 404 }) : Response.json(session); }
    if (method === "POST" && action === "sessions" && clientId === "logout") { const sessionHash = stringField(input, "session_hash", 64); if (sessionHash !== undefined && validVerifier(sessionHash)) ports.logoutAdminSession(sessionHash); return new Response(null, { status: 204 }); }
    if (method === "POST" && action === "password" && clientId === undefined) { const verifier = stringField(input, "password_verifier", 4_096); return verifier === undefined ? Response.json({ error: "invalid verifier" }, { status: 400 }) : ports.changeAdminPassword(verifier, nowMs) ? new Response(null, { status: 204 }) : new Response("not initialized", { status: 409 }); }
    return undefined;
  };
}
