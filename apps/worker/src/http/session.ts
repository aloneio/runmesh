import { ADMIN_CSRF_COOKIE } from "./constants.js";
import { ADMIN_SESSION_COOKIE } from "./constants.js";
import { ADMIN_SESSION_TTL_MS } from "../security.js";
import { bearerToken } from "../security.js";
import { configuredPublicOrigin } from "./origin.js";
import { constantTimeEqual } from "../security.js";
import { isConfiguredSecret } from "../security.js";
import { json } from "../platform/control-plane.js";
import { record } from "../values.js";
import { registryPost } from "../platform/control-plane.js";
import { sameOrigin } from "./origin.js";
import { sha256Hex } from "../security.js";
import type { WorkerEnv } from "../platform/env.js";

export async function adminSession(request: Request, env: WorkerEnv): Promise<{ hash: string; csrf_hash: string } | undefined> {
  const raw = cookieValue(request, ADMIN_SESSION_COOKIE);
  if (raw === undefined || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return undefined;
  const hash = await sha256Hex(raw);
  const response = await registryPost(env, "/auth/sessions/verify", { session_hash: hash });
  const csrfHash = record(response.ok ? await json(response) : undefined)?.csrf_hash;
  return typeof csrfHash === "string" && /^[0-9a-f]{64}$/.test(csrfHash) ? { hash, csrf_hash: csrfHash } : undefined;
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
