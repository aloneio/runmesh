import { ADMIN_CSRF_COOKIE } from "./constants.js";
import { ADMIN_SESSION_COOKIE } from "./constants.js";
import { ADMIN_SESSION_TTL_MS } from "../security.js";
import { bearerToken } from "../security.js";
import { configuredPublicOrigin } from "./origin.js";
import { constantTimeEqual } from "../security.js";
import { isConfiguredSecret } from "../security.js";
import { boundedJsonResponse } from "../bounded-json.js";
import { projectAdminSessionReceipt } from "../contracts/admin-session.js";
import { registryRequest } from "../platform/control-plane.js";
import { sameOrigin } from "./origin.js";
import { sha256Hex } from "../security.js";
import type { WorkerEnv } from "../platform/env.js";

export type AdminSessionDecision = { readonly state: "allowed"; readonly session: { readonly hash: string; readonly csrf_hash: string } } | { readonly state: "denied" | "unavailable" };

export async function adminSession(request: Request, env: WorkerEnv): Promise<AdminSessionDecision> {
  const raw = cookieValue(request, ADMIN_SESSION_COOKIE);
  if (raw === undefined || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return { state: "denied" };
  const hash = await sha256Hex(raw);
  const response = await boundedJsonResponse(signal => registryRequest(env, "/auth/sessions/verify", "POST", JSON.stringify({ session_hash: hash }), signal));
  const decision = projectAdminSessionReceipt(response);
  return decision.state === "allowed" ? { state: "allowed", session: { hash, csrf_hash: decision.csrf_hash } } : decision;
}

export async function verifyAdminPost(request: Request, form: FormData, session: { csrf_hash: string }, env: WorkerEnv): Promise<boolean> {
  if (!sameOrigin(request, configuredPublicOrigin(env))) return false;
  const supplied = form.get("csrf_token"); const cookie = cookieValue(request, ADMIN_CSRF_COOKIE);
  return typeof supplied === "string" && typeof cookie === "string" && constantTimeEqual(supplied, cookie) && constantTimeEqual(await sha256Hex(supplied), session.csrf_hash);
}

export async function verifyPreAuthCsrf(request: Request, form: FormData, name: string, env: WorkerEnv): Promise<boolean> {
  if (!sameOrigin(request, configuredPublicOrigin(env))) return false;
  const supplied = form.get("csrf_token"); const cookie = cookieValue(request, name);
  return typeof supplied === "string" && typeof cookie === "string" && constantTimeEqual(supplied, cookie);
}

export function isRunnerAdminRequest(request: Request, env: WorkerEnv): boolean { const token = bearerToken(request); return token !== undefined && isConfiguredSecret(env.ADMIN_TOKEN) && constantTimeEqual(token, env.ADMIN_TOKEN); }

export function cookieValue(request: Request, name: string): string | undefined { const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); const match = new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`).exec(request.headers.get("cookie") ?? ""); return match?.[1]; }

export function sessionCookie(value: string): string { return `${ADMIN_SESSION_COOKIE}=${value}; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1_000)}`; }

export function csrfCookie(value: string): string { return `${ADMIN_CSRF_COOKIE}=${value}; Secure; Path=/; SameSite=Strict; Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1_000)}`; }

export function clearCookie(name: string): string { return `${name}=; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=0`; }
