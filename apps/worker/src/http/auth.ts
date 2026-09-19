import { ADMIN_CSRF_COOKIE } from "./constants.js";
import { ADMIN_SESSION_COOKIE } from "./constants.js";
import { ADMIN_SESSION_TTL_MS } from "../security.js";
import { adminError } from "./responses.js";
import { authEntryDocument } from "../admin/auth-views.js";
import { authThrottleCheck } from "../application/auth-source.js";
import { authThrottleRecord } from "../application/auth-source.js";
import { boundedJsonResponse } from "../platform/bounded-json.js";
import { clearCookie } from "./session.js";
import { csrfCookie } from "./session.js";
import { discardBody } from "./request.js";
import { formData } from "./request.js";
import { html } from "./html-response.js";
import { htmlHeaders } from "./html-response.js";
import { loadLoginSettings } from "../auth-settings.js";
import { LOGIN_CSRF_COOKIE } from "./constants.js";
import { methodNotAllowed } from "./responses.js";
import { notFound } from "./responses.js";
import { passwordVerifier } from "../security.js";
import { randomBase64Url } from "../security.js";
import { record } from "../values.js";
import { redirect } from "./html-response.js";
import { registryPost } from "../platform/control-plane.js";
import { registryRequest } from "../platform/control-plane.js";
import { sessionCookie } from "./session.js";
import { SETUP_CSRF_COOKIE } from "./constants.js";
import { SETUP_CSRF_TTL_MS } from "../security.js";
import { sha256Hex } from "../security.js";
import { throttleError } from "./responses.js";
import { validPassword } from "./input.js";
import { verifyPassword } from "../security.js";
import { verifyPreAuthCsrf } from "./session.js";
import type { WorkerEnv } from "../platform/env.js";

export async function handleLanding(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  // A Registry outage or malformed status cannot be interpreted as
  // "not initialized"; doing so would expose setup UI during an outage.
  const statusResponse = await boundedJsonResponse(signal => registryRequest(env, "/auth/status", "GET", "", signal));
  if (statusResponse?.status !== 200) {
    await discardBody(request);
    return registryStatusUnavailable();
  }
  const initialized = record(statusResponse.value);
  if (initialized === undefined || typeof initialized.initialized !== "boolean") {
    await discardBody(request);
    return registryStatusUnavailable();
  }
  if (initialized.initialized !== true) {
    if (url.pathname !== "/" && url.pathname !== "/setup") { if (request.method !== "GET") await discardBody(request); return notFound(); }
    if (request.method === "GET") return setupPage();
    if (request.method === "POST") return submitSetup(request, env);
    await discardBody(request);
    return methodNotAllowed("GET, POST");
  }
  if (url.pathname === "/setup") {
    if (request.method !== "GET") await discardBody(request);
    return new Response("already initialized", { status: 409, headers: htmlHeaders() });
  }
  if (request.method === "GET") return loginPage();
  if (request.method === "POST") return submitLogin(request, env);
  await discardBody(request);
  return methodNotAllowed("GET, POST");
}

async function submitSetup(request: Request, env: WorkerEnv): Promise<Response> {
  const form = await formData(request);
  if (form === undefined) return adminError(400, "Invalid setup request.");
  if (!await verifyPreAuthCsrf(request, form, SETUP_CSRF_COOKIE, env)) return adminError(403, "Setup request was rejected.");
  const throttle = await authThrottleCheck(env, "setup", request);
  if (throttle === undefined) return adminError(503, "Setup could not be completed. Try again.");
  if (!throttle.allowed) return throttleError(throttle.retry_after_ms);
  const password = form.get("password"); const confirmation = form.get("confirm_password");
  if (typeof password !== "string" || typeof confirmation !== "string" || !validPassword(password) || password !== confirmation) return adminError(400, "Passwords must match and be at least 12 characters.");
  const verifier = await passwordVerifier(password);
  const response = await registryPost(env, "/auth/setup", { password_verifier: verifier });
  if (response.status === 204) {
    await authThrottleRecord(env, "setup", true, request);
    return redirect("/", [clearCookie(SETUP_CSRF_COOKIE)]);
  }
  await authThrottleRecord(env, "setup", false, request);
  if (response.status === 409) return adminError(409, "This instance is already initialized.", [clearCookie(SETUP_CSRF_COOKIE)]);
  return adminError(503, "Setup could not be completed. Try again.");
}

async function submitLogin(request: Request, env: WorkerEnv): Promise<Response> {
  const form = await formData(request);
  if (form === undefined) return adminError(400, "Invalid login request.");
  if (!await verifyPreAuthCsrf(request, form, LOGIN_CSRF_COOKIE, env)) return adminError(403, "Login request was rejected.");
  const password = form.get("password");
  if (typeof password !== "string") return adminError(403, "Invalid administrator password.", [clearCookie(LOGIN_CSRF_COOKIE)]);
  // Fetch a valid verifier before reserving any password attempt. No KDF has
  // run when Registry fails, so infrastructure failures must not source-lock.
  const settings = await loadLoginSettings((signal) => registryRequest(env, "/auth/settings", "GET", "", signal));
  if (settings === undefined) return adminError(503, "Authentication service unavailable. Try again.");
  const throttle = await authThrottleCheck(env, "login", request);
  if (throttle === undefined) return adminError(503, "Login could not be completed. Try again.");
  if (!throttle.allowed) return throttleError(throttle.retry_after_ms);
  const sessionVersion = settings.session_version;
  const valid = await verifyPassword(password, settings.password_verifier);
  await authThrottleRecord(env, "login", valid, request);
  if (!valid) return adminError(403, "Invalid administrator password.", [clearCookie(LOGIN_CSRF_COOKIE)]);
  const rawSession = randomBase64Url(); const rawCsrf = randomBase64Url();
  const sessionResponse = await registryPost(env, "/auth/sessions", {
    session_hash: await sha256Hex(rawSession), csrf_hash: await sha256Hex(rawCsrf), expires_at_ms: Date.now() + ADMIN_SESSION_TTL_MS, expected_session_version: sessionVersion,
  });
  if (sessionResponse.status === 409) return adminError(403, "Authentication changed. Sign in again.", [clearCookie(LOGIN_CSRF_COOKIE)]);
  // The Registry commits session creation with 204. An accepted or otherwise
  // unexpected receipt must not issue cookies for an unconfirmed session.
  if (sessionResponse.status !== 204) {
    void sessionResponse.body?.cancel().catch(() => undefined);
    return adminError(503, "Login could not be completed. Try again.");
  }
  return redirect("/admin", [sessionCookie(rawSession), csrfCookie(rawCsrf), clearCookie(LOGIN_CSRF_COOKIE)]);
}

export async function changePassword(env: WorkerEnv, form: FormData): Promise<Response> {
  const current = form.get("current_password"); const password = form.get("password"); const confirmation = form.get("confirm_password");
  if (typeof current !== "string" || typeof password !== "string" || typeof confirmation !== "string" || !validPassword(password) || password !== confirmation) return adminError(400, "Password change is invalid.");
  const settings = await loadLoginSettings(signal => registryRequest(env, "/auth/settings", "GET", "", signal));
  if (settings === undefined) return adminError(503, "Authentication service unavailable. Try again.");
  if (!await verifyPassword(current, settings.password_verifier)) return adminError(403, "Current administrator password is invalid.");
  const response = await registryPost(env, "/auth/password", { password_verifier: await passwordVerifier(password) });
  if (response.status !== 204) {
    void response.body?.cancel().catch(() => undefined);
    return adminError(503, "Password change could not be completed.");
  }
  return redirect("/", [clearCookie(ADMIN_SESSION_COOKIE), clearCookie(ADMIN_CSRF_COOKIE)]);
}

function registryStatusUnavailable(): Response {
  return new Response("control plane status unavailable", { status: 503, headers: { "cache-control": "no-store" } });
}

function setupPage(): Response {
  const csrf = randomBase64Url();
  return html(authEntryDocument("setup", csrf), [`${SETUP_CSRF_COOKIE}=${csrf}; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=${Math.floor(SETUP_CSRF_TTL_MS / 1_000)}`]);
}

function loginPage(): Response {
  const csrf = randomBase64Url();
  return html(authEntryDocument("login", csrf), [`${LOGIN_CSRF_COOKIE}=${csrf}; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=${Math.floor(SETUP_CSRF_TTL_MS / 1_000)}`]);
}
