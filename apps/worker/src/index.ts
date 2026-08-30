import { createMcpHandler } from "agents/mcp/server";
import { PROTOCOL_CURRENT_VERSION, PROTOCOL_MIN_VERSION } from "@aloneio/runmesh-protocol";
import { createCodingMcpServer, type McpAuth } from "./mcp/server.js";
import { RegistryDO, type McpClientRecord, type RunnerPublicInfo, type RunnerRecord, type VerifiedMcpClient } from "./registry.js";
import { RunnerDO, type WorkerEnv } from "./runner-do.js";
import type { CodingScope } from "./registry.js";
import {
  ADMIN_SESSION_TTL_MS,
  SETUP_CSRF_TTL_MS,
  bearerToken,
  constantTimeEqual,
  generateRunnerToken,
  internalHeaders,
  isSafeIdentifier,
  passwordVerifier,
  randomBase64Url,
  runnerTokenVerifier,
  sha256Hex,
  verifyInternalRequest,
  verifySetupToken,
  verifyPassword,
} from "./security.js";
import { readCappedFormData, readCappedText as readBodyText } from "./body.js";
import { fixedReleaseDescriptor, renderPosixInstaller, renderPowerShellInstaller, signedReleaseIsAvailable, type FixedReleaseDescriptor } from "./installer.js";

export { RegistryDO, RunnerDO };

const MAX_ADMIN_BODY_BYTES = 16_384;
const ADMIN_SESSION_COOKIE = "__Host-runmesh_admin_session";
const ADMIN_CSRF_COOKIE = "__Host-runmesh_admin_csrf";
const SETUP_CSRF_COOKIE = "__Host-runmesh_setup_csrf";
const LOGIN_CSRF_COOKIE = "__Host-runmesh_login_csrf";
const MCP_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

export interface RunnerReleaseDescriptor extends FixedReleaseDescriptor {
  readonly protocol: { readonly min_version: number; readonly max_version: number };
}

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
} satisfies ExportedHandler<WorkerEnv>;

async function handleRequest(request: Request, env: WorkerEnv, _ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") return Response.json({ ok: true, service: "runmesh-agent-control-plane" });
  if (url.pathname === "/assets/logo.png" || url.pathname === "/assets/favicon.png") return asset(request, env);
  if (url.pathname === "/runner/install.sh") return runnerInstallScript(request, url, env);
  if (url.pathname === "/runner/install.ps1") return runnerInstallPowerShell(request, url, env);
  if (url.pathname === "/runner/releases/latest" || url.pathname === "/runner/releases/stable") return runnerRelease(request, env);
  if (isMcpPath(url.pathname)) return handleMcpSecret(request, env, url);
  if (url.pathname === "/mcp") return notFound();
  if (url.pathname.startsWith("/internal/runners/")) return forwardRunnerRpc(request, env, url);
  if (url.pathname === "/runner/enroll") return handleRunnerEnrollment(request, env);
  if (url.pathname.startsWith("/admin/runners")) {
    return isRunnerAdminRequest(request, env) ? handleRunnerAdmin(request, env, url) : handleBrowserAdmin(request, env, url);
  }
  if (url.pathname === "/" || url.pathname === "/setup" || url.pathname === "/login") return handleLanding(request, env, url);
  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return handleBrowserAdmin(request, env, url);
  if (url.pathname === "/runner/connect") {
    if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket upgrade required", { status: 426 });
    const runnerId = url.searchParams.get("runner_id");
    if (runnerId === null || !isSafeIdentifier(runnerId)) return new Response("invalid runner_id", { status: 400 });
    const target = new URL(request.url); target.pathname = `/runner/${encodeURIComponent(runnerId)}`; target.search = "";
    return env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request(target, request));
  }
  return notFound();
}

async function asset(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") { await discardBody(request); return methodNotAllowed("GET, HEAD"); }
  if (env.ASSETS === undefined) return notFound();
  // Keep the public `/assets/*` URL stable while resolving files from the
  // configured asset directory (whose binding root is `/`).
  const assetUrl = new URL(request.url);
  assetUrl.pathname = assetUrl.pathname.replace(/^\/assets(?=\/|$)/, "") || "/";
  return env.ASSETS.fetch(new Request(assetUrl, request));
}

export interface RunnerReleaseEnvironment {
  /**
   * Explicit deployment acknowledgement set only after the immutable fixed
   * GitHub prerelease has been published and independently verified. Other
   * values fail closed; URLs, packages and version strings are never accepted.
   */
  readonly RUNMESH_SIGNED_RELEASE_AVAILABLE?: string;
}

export function runnerReleaseDescriptor(env: RunnerReleaseEnvironment): RunnerReleaseDescriptor {
  return { ...fixedReleaseDescriptor(signedReleaseIsAvailable(env.RUNMESH_SIGNED_RELEASE_AVAILABLE)), protocol: { min_version: PROTOCOL_MIN_VERSION, max_version: PROTOCOL_CURRENT_VERSION } };
}
function runnerRelease(request: Request, env: WorkerEnv): Response {
  if (request.method !== "GET" && request.method !== "HEAD") { void discardBody(request); return methodNotAllowed("GET, HEAD"); }
  const descriptor = runnerReleaseDescriptor(env);
  return new Response(JSON.stringify({ ...descriptor, schema_version: 1, published_at: null }), { headers: publicInstallerHeaders("application/json; charset=utf-8") });
}
function runnerInstallScript(request: Request, url: URL, env: WorkerEnv): Response {
  if (request.method !== "GET" && request.method !== "HEAD") { void discardBody(request); return methodNotAllowed("GET, HEAD"); }
  const descriptor = runnerReleaseDescriptor(env);
  const content = descriptor.distributable
    ? renderPosixInstaller(url.origin)
    : `#!/usr/bin/env sh
set -eu
printf '%s\\n' 'error: The fixed signed Runmesh v0.1.0-dev.2 release is not enabled on this deployment.' 'Use the manual verified portable-artifact route until the exact immutable release is available.' >&2
exit 1
`;
  return new Response(content, { headers: publicInstallerHeaders("text/x-shellscript; charset=utf-8") });
}
function runnerInstallPowerShell(request: Request, url: URL, env: WorkerEnv): Response {
  if (request.method !== "GET" && request.method !== "HEAD") { void discardBody(request); return methodNotAllowed("GET, HEAD"); }
  const descriptor = runnerReleaseDescriptor(env);
  const content = descriptor.distributable
    ? renderPowerShellInstaller(url.origin)
    : `$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Write-Error 'The fixed signed Runmesh v0.1.0-dev.2 release is not enabled on this deployment. Use the manual verified portable-artifact route until the exact immutable release is available.'
exit 1
`;
  return new Response(content, { headers: publicInstallerHeaders("text/plain; charset=utf-8") });
}
function publicInstallerHeaders(contentType: string): Headers {
  return new Headers({ "content-type": contentType, "cache-control": "public, max-age=300", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "permissions-policy": "geolocation=(), microphone=(), camera=()" });
}
async function handleRunnerEnrollment(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method !== "POST") { await discardBody(request); return methodNotAllowed("POST"); }
  const input = await readEnrollmentBody(request);
  const code = typeof input?.enrollment_code === "string" && /^[A-Za-z0-9_-]{43}$/.test(input.enrollment_code) ? input.enrollment_code : undefined;
  const publicInfo = runnerPublicInfo(input?.runner_public_info);
  if (code === undefined || publicInfo === undefined || env.RUNNER_TOKEN_PEPPER === undefined) return enrollmentError();
  const token = generateRunnerToken();
  const response = await registryPost(env, "/enrollments/redeem", {
    verifier: await sha256Hex(code), token_verifier: await runnerTokenVerifier(token, env.RUNNER_TOKEN_PEPPER), runner_public_info: publicInfo,
  });
  const body = response.ok ? record(await json(response)) : undefined;
  const runnerId = body?.runner_id;
  if (typeof runnerId !== "string") return enrollmentError();
  const url = new URL(request.url); url.pathname = "/runner/connect"; url.search = "";
  return Response.json({ runner_id: runnerId, server_url: url.toString(), token }, { headers: credentialHeaders("application/json; charset=utf-8") });
}
function runnerPublicInfo(value: unknown): RunnerPublicInfo | undefined {
  const item = record(value);
  if (item === undefined || !safeDisplayText(item.platform, 128) || !safeDisplayText(item.architecture, 128) || !safeDisplayText(item.hostname, 256) || !safeDisplayText(item.runner_version, 256) || typeof item.protocol_version !== "number") return undefined;
  const info: RunnerPublicInfo = { platform: item.platform, architecture: item.architecture, hostname: item.hostname, runner_version: item.runner_version, protocol_version: item.protocol_version };
  return Number.isSafeInteger(info.protocol_version) && info.protocol_version > 0 && info.protocol_version <= 1_000 ? info : undefined;
}
function safeDisplayText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f<>]/.test(value);
}
async function readEnrollmentBody(request: Request): Promise<Record<string, unknown> | undefined> {
  const body = await readBodyText(request, 4_096);
  try { return record(body === undefined ? undefined : JSON.parse(body) as unknown); } catch { return undefined; }
}
function enrollmentError(): Response { return new Response("invalid enrollment", { status: 401, headers: credentialHeaders("text/plain; charset=utf-8") }); }

/** The URL segment is the only MCP credential. Authorization headers are ignored. */
async function handleMcpSecret(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean);
  const secret = parts[0];
  if (secret === undefined || !MCP_SECRET_RE.test(secret)) return notFound();
  const verified = await verifyMcpClient(env, await sha256Hex(secret));
  if (verified === undefined) return notFound();
  // createMcpHandler requires an exact /mcp route. Do not consume request.body
  // before cloning it: the SDK must receive the original JSON-RPC stream.
  const rewritten = new URL(request.url);
  rewritten.pathname = "/mcp";
  rewritten.search = "";
  const auth: McpAuth = {
    // AuthInfo needs an opaque token but no component needs the raw URL secret.
    token: verified.client_id,
    clientId: verified.client_id,
    scopes: [...verified.scopes],
    extra: { client_label: verified.label, secret_version: verified.secret_version },
  };
  const handler = createMcpHandler(
    () => createCodingMcpServer(env, auth),
    {
      route: "/mcp",
      // Safe identity only. The raw secret is intentionally absent.
      authContext: { props: { client_id: verified.client_id, client_label: verified.label, scopes: [...verified.scopes], secret_version: verified.secret_version } },
      legacy: "stateless",
    },
  );
  return handler.fetch(new Request(rewritten, request), { authInfo: auth });
}

function isMcpPath(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length === 2 && parts[1] === "mcp";
}

async function handleLanding(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const initialized = await registryGet(env, "/auth/status").then((response) => response.ok ? response.json() as Promise<{ initialized?: unknown }> : undefined);
  if (initialized?.initialized !== true) {
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
  if (!await verifyPreAuthCsrf(request, form, SETUP_CSRF_COOKIE)) return adminError(403, "Setup request was rejected.");
  const throttle = await authThrottleCheck(env, "setup");
  if (throttle === undefined) return adminError(503, "Setup could not be completed. Try again.");
  if (!throttle.allowed) return throttleError(throttle.retry_after_ms);
  const setupToken = form.get("setup_token");
  if (!await verifySetupToken(setupToken, env.SETUP_TOKEN, env.SETUP_TOKEN_HASH)) {
    await authThrottleRecord(env, "setup", false);
    return adminError(403, "Setup request was rejected.");
  }
  const password = form.get("password"); const confirmation = form.get("confirm_password");
  if (typeof password !== "string" || typeof confirmation !== "string" || !validPassword(password) || password !== confirmation) return adminError(400, "Passwords must match and be at least 12 characters.");
  const verifier = await passwordVerifier(password);
  const response = await registryPost(env, "/auth/setup", { password_verifier: verifier });
  if (response.status === 204) {
    await authThrottleRecord(env, "setup", true);
    return redirect("/", [clearCookie(SETUP_CSRF_COOKIE)]);
  }
  await authThrottleRecord(env, "setup", false);
  if (response.status === 409) return adminError(409, "This instance is already initialized.", [clearCookie(SETUP_CSRF_COOKIE)]);
  return adminError(503, "Setup could not be completed. Try again.");
}

async function submitLogin(request: Request, env: WorkerEnv): Promise<Response> {
  const form = await formData(request);
  if (form === undefined) return adminError(400, "Invalid login request.");
  if (!await verifyPreAuthCsrf(request, form, LOGIN_CSRF_COOKIE)) return adminError(403, "Login request was rejected.");
  const throttle = await authThrottleCheck(env, "login");
  if (throttle === undefined) return adminError(503, "Login could not be completed. Try again.");
  if (!throttle.allowed) return throttleError(throttle.retry_after_ms);
  const password = form.get("password");
  if (typeof password !== "string") return adminError(403, "Invalid administrator password.", [clearCookie(LOGIN_CSRF_COOKIE)]);
  const settings = await registryGet(env, "/auth/settings");
  const body = settings.ok ? await json(settings) : undefined;
  const verifier = record(body)?.password_verifier;
  const valid = typeof verifier === "string" && await verifyPassword(password, verifier);
  await authThrottleRecord(env, "login", valid);
  if (!valid) return adminError(403, "Invalid administrator password.", [clearCookie(LOGIN_CSRF_COOKIE)]);
  const rawSession = randomBase64Url(); const rawCsrf = randomBase64Url();
  const sessionResponse = await registryPost(env, "/auth/sessions", {
    session_hash: await sha256Hex(rawSession), csrf_hash: await sha256Hex(rawCsrf), expires_at_ms: Date.now() + ADMIN_SESSION_TTL_MS,
  });
  if (!sessionResponse.ok) return adminError(503, "Login could not be completed. Try again.");
  return redirect("/admin", [sessionCookie(rawSession), csrfCookie(rawCsrf), clearCookie(LOGIN_CSRF_COOKIE)]);
}

async function handleBrowserAdmin(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const session = await adminSession(request, env);
  if (session === undefined) { if (request.method !== "GET") await discardBody(request); return redirect("/", [clearCookie(ADMIN_SESSION_COOKIE), clearCookie(ADMIN_CSRF_COOKIE)]); }
  if (request.method === "GET" && ["/admin", "/admin/runners", "/admin/clients", "/admin/settings"].includes(url.pathname)) {
    const csrf = cookieValue(request, ADMIN_CSRF_COOKIE);
    if (csrf === undefined || !constantTimeEqual(await sha256Hex(csrf), session.csrf_hash)) return redirect("/", [clearCookie(ADMIN_SESSION_COOKIE), clearCookie(ADMIN_CSRF_COOKIE)]);
    const data = await loadDashboardData(env);
    return html(adminPage(url.pathname, data, csrf));
  }
  const runnerDetail = /^\/admin\/runners\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/.exec(url.pathname);
  const clientDetail = /^\/admin\/clients\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})(?:\/scopes\/detail)?$/.exec(url.pathname);
  if (request.method === "GET" && clientDetail !== null) {
    const csrf = cookieValue(request, ADMIN_CSRF_COOKIE);
    if (csrf === undefined || !constantTimeEqual(await sha256Hex(csrf), session.csrf_hash)) return redirect("/", [clearCookie(ADMIN_SESSION_COOKIE), clearCookie(ADMIN_CSRF_COOKIE)]);
    const clientResponse = await registryGet(env, `/auth/clients`);
    const clients = clientResponse.ok ? arrayField(record(await json(clientResponse))?.clients) : [];
    const client = clients.map(record).find((item) => item?.client_id === clientDetail[1]);
    const runnersResponse = await registryGet(env, "/runners");
    const runners = runnersResponse.ok ? arrayField(record(await json(runnersResponse))?.runners).filter(record) as RunnerRecord[] : [];
    const overridesResponse = await registryGet(env, `/auth/clients/${encodeURIComponent(clientDetail[1] as string)}/runner-overrides`);
    const overrides = overridesResponse.ok ? arrayField(record(await json(overridesResponse))?.overrides).filter(record) : [];
    return client === undefined ? adminError(404, "MCP client was not found.") : html(adminDocument(`${typeof client.label === "string" ? client.label : clientDetail[1]} · MCP Client`, await clientDetailPage(env, client, runners, overrides as Record<string, unknown>[], csrf), "clients"));
  }

  if (request.method === "GET" && runnerDetail !== null) {
    const csrf = cookieValue(request, ADMIN_CSRF_COOKIE);
    if (csrf === undefined || !constantTimeEqual(await sha256Hex(csrf), session.csrf_hash)) return redirect("/", [clearCookie(ADMIN_SESSION_COOKIE), clearCookie(ADMIN_CSRF_COOKIE)]);
    const runnerId = runnerDetail[1] as string;
    const [runnerResponse, workspaceResponse, jobsResponse, environment, releaseResponse] = await Promise.all([
      registryGet(env, `/runners/${encodeURIComponent(runnerId)}`),
      registryGet(env, `/auth/runners/${encodeURIComponent(runnerId)}/managed-workspaces`),
      registryGet(env, `/runners/${encodeURIComponent(runnerId)}/jobs?status=running&limit=20`),
      runnerEnvironment(env, runnerId),
      Promise.resolve(runnerReleaseDescriptor(env)),
    ]);
    const runner = runnerResponse.ok ? record(await json(runnerResponse)) : undefined;
    const workspaces = workspaceResponse.ok ? arrayField(record(await json(workspaceResponse))?.workspaces) : [];
    const jobs = jobsResponse.ok ? arrayField(record(await json(jobsResponse))?.jobs) : [];
    return runner === undefined ? adminError(404, "Runner was not found.") : html(adminDocument(`${typeof runner.display_name === "string" ? runner.display_name : runnerId} · Runner`, runnerDetailPage(runner, workspaces, jobs, environment, csrf, releaseResponse), "runners"));
  }
  if (request.method !== "POST") { await discardBody(request); return methodNotAllowed("GET, POST"); }
  const form = await formData(request);
  if (form === undefined || !await verifyAdminPost(request, form, session)) return adminError(403, "Administrative request was rejected.");
  if (url.pathname === "/admin/logout") {
    await registryPost(env, "/auth/sessions/logout", { session_hash: session.hash });
    return redirect("/", [clearCookie(ADMIN_SESSION_COOKIE), clearCookie(ADMIN_CSRF_COOKIE)]);
  }
  if (url.pathname === "/admin/password") return changePassword(env, form);
  if (url.pathname === "/admin/clients") return createClient(env, form, request.url);
  if (url.pathname === "/admin/runners") return createBrowserRunner(env, form, request.url);
  const runnerMatch = /^\/admin\/runners\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/(rename|rotate|revoke|delete|enrollment|permissions|version-policy|emergency-lock|workspace-create|workspace-update|workspace-delete)$/.exec(url.pathname);
  if (runnerMatch !== null) return handleBrowserRunnerAction(env, form, request.url, runnerMatch[1] as string, runnerMatch[2] as "rename" | "rotate" | "revoke" | "delete" | "enrollment" | "permissions" | "version-policy" | "emergency-lock" | "workspace-create" | "workspace-update" | "workspace-delete");
  const clientMatch = /^\/admin\/clients\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/(rename|rotate|revoke|reset-runner|override|reset-override|scopes)$/.exec(url.pathname);
  if (clientMatch === null) return notFound();
  const clientId = clientMatch[1] as string; const action = clientMatch[2] as "rename" | "rotate" | "revoke" | "reset-runner" | "override" | "reset-override" | "scopes";
  if (action === "scopes") {
    const scopes = selectedScopes(form);
    if (scopes === undefined) return adminError(400, "Client scopes are invalid.");
    const response = await registryPost(env, `/auth/clients/${encodeURIComponent(clientId)}/scopes`, { scopes });
    return response.ok ? redirect(`/admin/clients/${encodeURIComponent(clientId)}`) : adminError(response.status === 404 ? 404 : 400, "Client scopes could not be updated.");
  }
  if (action === "reset-runner") {
    const response = await registryPost(env, `/auth/clients/${encodeURIComponent(clientId)}/active-runner/reset`, {});
    return response.ok ? redirect("/admin/clients") : adminError(response.status === 404 ? 404 : 400, "Runner selection could not be reset.");
  }
  if (action === "override" || action === "reset-override") {
    const runnerId = form.get("runner_id");
    if (typeof runnerId !== "string" || !isSafeIdentifier(runnerId)) return adminError(400, "Runner identifier is invalid.");
    const path = `/auth/clients/${encodeURIComponent(clientId)}/runner-overrides/${encodeURIComponent(runnerId)}`;
    if (action === "reset-override") {
      const response = await registryRequest(env, path, "DELETE", "");
      return response.ok ? redirect(`/admin/clients/${encodeURIComponent(clientId)}`) : adminError(response.status === 404 ? 404 : 400, "Runner restriction could not be reset.");
    }
    const permissions = permissionsFromForm(form);
    if (permissions === undefined) return adminError(400, "Runner restriction is invalid.");
    const response = await registryPost(env, path, { permissions });
    return response.ok ? redirect(`/admin/clients/${encodeURIComponent(clientId)}`) : adminError(response.status === 404 ? 404 : 400, "Runner restriction could not be saved.");
  }
  if (action === "rename") {
    const label = form.get("label");
    if (typeof label !== "string" || !validLabel(label)) return adminError(400, "Client name is invalid.");
    const response = await registryPost(env, `/auth/clients/${encodeURIComponent(clientId)}/rename`, { label });
    return response.ok ? redirect("/admin") : adminError(response.status === 404 ? 404 : 400, "Client update failed.");
  }
  if (action === "revoke") {
    const response = await registryPost(env, `/auth/clients/${encodeURIComponent(clientId)}/revoke`, {});
    return response.ok ? redirect("/admin") : adminError(response.status === 404 ? 404 : 400, "Client revoke failed.");
  }
  const secret = randomBase64Url();
  const response = await registryPost(env, `/auth/clients/${encodeURIComponent(clientId)}/rotate`, { secret_verifier: await sha256Hex(secret), secret_prefix: secret.slice(0, 8) });
  if (!response.ok) return adminError(response.status === 404 ? 404 : 400, "Client rotation failed.");
  return html(secretCreatedPage("MCP client rotated", secretUrl(request.url, secret)));
}

async function changePassword(env: WorkerEnv, form: FormData): Promise<Response> {
  const current = form.get("current_password"); const password = form.get("password"); const confirmation = form.get("confirm_password");
  if (typeof current !== "string" || typeof password !== "string" || typeof confirmation !== "string" || !validPassword(password) || password !== confirmation) return adminError(400, "Password change is invalid.");
  const settings = await registryGet(env, "/auth/settings"); const verifier = record(settings.ok ? await json(settings) : undefined)?.password_verifier;
  if (typeof verifier !== "string" || !await verifyPassword(current, verifier)) return adminError(403, "Current administrator password is invalid.");
  const response = await registryPost(env, "/auth/password", { password_verifier: await passwordVerifier(password) });
  if (!response.ok) return adminError(503, "Password change could not be completed.");
  return redirect("/", [clearCookie(ADMIN_SESSION_COOKIE), clearCookie(ADMIN_CSRF_COOKIE)]);
}

async function createBrowserRunner(env: WorkerEnv, form: FormData, baseUrl: string): Promise<Response> {
  const submittedId = form.get("runner_id"); const displayName = form.get("display_name");
  const runnerId = typeof submittedId === "string" && submittedId.trim().length > 0 ? submittedId : `runner-${crypto.randomUUID().replaceAll("-", "")}`;
  if (!isSafeIdentifier(runnerId) || typeof displayName !== "string" || !validLabel(displayName)) return adminError(400, "Runner identifier or display name is invalid.");
  const response = await runnerRegistryRequest(env, runnerId, "/add", "POST", JSON.stringify({ display_name: displayName }));
  if (!response.ok) return adminError(response.status === 409 ? 409 : 400, "Runner could not be added.");
  return runnerEnrollmentPage(env, baseUrl, runnerId, await createEnrollmentCode(env, runnerId), String(form.get("csrf_token") ?? ""));
}
async function handleBrowserRunnerAction(env: WorkerEnv, form: FormData, baseUrl: string, runnerId: string, action: "rename" | "rotate" | "revoke" | "delete" | "enrollment" | "permissions" | "version-policy" | "emergency-lock" | "workspace-create" | "workspace-update" | "workspace-delete"): Promise<Response> {
  if (action === "version-policy") {
    const updateChannel = form.get("update_channel"); const desired = form.get("desired_runner_version");
    if ((updateChannel !== "stable" && updateChannel !== "pinned") || (typeof desired !== "string" && desired !== null)) return adminError(400, "Runner update policy is invalid.");
    const latest = runnerReleaseDescriptor(env).distributable ? runnerReleaseDescriptor(env).package_version : null;
    const payload = { update_channel: updateChannel, ...(updateChannel === "pinned" && typeof desired === "string" && desired.length > 0 ? { desired_runner_version: desired } : {}), ...(updateChannel === "stable" && latest !== null ? { latest_runner_version: latest } : {}) };
    if (updateChannel === "pinned" && !(typeof desired === "string" && validRunnerVersion(desired))) return adminError(400, "Pinned Runner version must be an exact version.");
    const response = await registryPost(env, `/auth/runners/${encodeURIComponent(runnerId)}/version-policy`, payload);
    return response.ok ? redirect(`/admin/runners/${encodeURIComponent(runnerId)}`) : adminError(response.status === 404 ? 404 : 400, "Runner update policy could not be updated.");
  }
  if (action === "permissions") {
    const permissions = permissionsFromForm(form);
    if (permissions === undefined) return adminError(400, "Runner permissions are invalid.");
    const response = await mutateRunnerPolicy(env, runnerId, { path: `/auth/runners/${encodeURIComponent(runnerId)}/permissions`, method: "POST", payload: { permissions } });
    return response.ok ? redirect(`/admin/runners/${encodeURIComponent(runnerId)}`) : adminError(response.status === 404 ? 404 : 400, "Runner permission profile could not be updated.");
  }
  if (action === "emergency-lock") {
    if (form.get("confirmation") !== runnerId) return adminError(400, "Type the Runner ID to confirm emergency lock.");
    const response = await mutateRunnerPolicy(env, runnerId, { path: `/auth/runners/${encodeURIComponent(runnerId)}/emergency-lock`, method: "POST", payload: { confirmation: runnerId } });
    return response.ok ? redirect(`/admin/runners/${encodeURIComponent(runnerId)}`) : adminError(response.status === 404 ? 404 : 400, "Emergency lock could not be applied.");
  }
  if (action.startsWith("workspace-")) return handleBrowserWorkspaceAction(env, form, runnerId, action as "workspace-create" | "workspace-update" | "workspace-delete");
  if (action === "rename") {
    const displayName = form.get("display_name");
    if (typeof displayName !== "string" || !validLabel(displayName)) return adminError(400, "Runner display name is invalid.");
    const response = await runnerRegistryRequest(env, runnerId, "/rename", "POST", JSON.stringify({ display_name: displayName }));
    return response.ok ? redirect("/admin") : adminError(response.status === 404 ? 404 : 400, "Runner rename failed.");
  }
  if (action === "delete") {
    const confirmation = form.get("confirmation");
    if (confirmation !== runnerId) return adminError(400, "Type the Runner ID to confirm deletion.");
    const mutationId = `runner-delete-${crypto.randomUUID()}`;
    const fenced = await fenceRunnerTransport(env, runnerId, mutationId);
    if (!fenced.ok) return adminError(503, "Runner deletion could not fence the Runner.");
    let response: Response;
    try { response = await runnerRegistryRequest(env, runnerId, "", "DELETE", JSON.stringify({ confirmation, mutation_id: mutationId })); } catch { return adminError(503, "Runner deletion outcome is uncertain; Runner remains safely fenced."); }
    if (!response.ok) {
      if (![400, 404, 409].includes(response.status)) return adminError(503, "Runner deletion outcome is uncertain; Runner remains safely fenced.");
      try {
        const state = await runnerMutationState(env, runnerId, mutationId);
        if (state?.runner_exists === false && state.mutation_committed === true) {
          await deleteRunnerTransport(env, runnerId, mutationId);
          return redirect("/admin");
        }
        const cancelled = await cancelRunnerPolicyMutation(env, runnerId, mutationId);
        if (!cancelled.ok) return adminError(503, "Runner deletion failed; Runner remains safely fenced.");
      } catch { return adminError(503, "Runner deletion state is uncertain; Runner remains safely fenced."); }
      return adminError(response.status === 404 ? 404 : 400, "Runner delete failed.");
    }
    await deleteRunnerTransport(env, runnerId, mutationId);
    return redirect("/admin");
  }
  if (action === "revoke") {
    const confirmation = form.get("confirmation");
    if (confirmation !== runnerId) return adminError(400, "Type the Runner ID to confirm revocation.");
    const mutationId = `credential-revoked-${crypto.randomUUID()}`;
    const fenced = await fenceRunnerTransport(env, runnerId, mutationId);
    if (!fenced.ok) return adminError(503, "Runner revocation could not fence the Runner.");
    let registryResponse: Response;
    try { registryResponse = await runnerRegistryRequest(env, runnerId, "/revoke", "POST", JSON.stringify({ confirmation, mutation_id: mutationId })); } catch { return adminError(503, "Runner revocation outcome is uncertain; Runner remains safely fenced."); }
    if (!registryResponse.ok) {
      if (![400, 404, 409].includes(registryResponse.status)) return adminError(503, "Runner revocation outcome is uncertain; Runner remains safely fenced.");
      try {
        const cancelled = await cancelRunnerPolicyMutation(env, runnerId, mutationId);
        if (!cancelled.ok) return adminError(503, "Runner revocation failed; Runner remains safely fenced.");
      } catch { return adminError(503, "Runner revocation state is uncertain; Runner remains safely fenced."); }
      return adminError(registryResponse.status === 404 ? 404 : 400, "Runner revoke failed.");
    }
    try { await revokeRunnerTransport(env, runnerId, mutationId); } catch { /* registry revocation is authoritative */ }
    return redirect("/admin");
  }
  if (action === "rotate") {
    const mutationId = `credential-rotated-${crypto.randomUUID()}`;
    const runnerResponse = await runnerRegistryRequest(env, runnerId, "", "GET", "");
    const runner = runnerResponse.ok ? record(await json(runnerResponse)) : undefined;
    const canFence = runnerResponse.ok && Number(runner?.connection_epoch ?? 0) > 0 && Number(runner?.credential_version ?? 0) > 0 && typeof runner?.session_id === "string" && runner.session_id.length > 0 && runner?.state === "online";
    if (canFence) {
      const fenced = await fenceRunnerTransport(env, runnerId, mutationId);
      if (!fenced.ok) return adminError(503, "Runner credential rotation could not fence the Runner.");
    }
    let response: Response;
    try { response = await runnerRegistryRequest(env, runnerId, "/rotate", "POST", JSON.stringify({ mutation_id: mutationId })); } catch { return adminError(503, "Runner credential rotation outcome is uncertain; Runner remains safely fenced."); }
    if (!response.ok) {
      if (![400, 404, 409].includes(response.status)) return adminError(503, "Runner credential rotation outcome is uncertain; Runner remains safely fenced.");
      if (canFence) {
        try {
          const cancelled = await cancelRunnerPolicyMutation(env, runnerId, mutationId);
          if (!cancelled.ok) return adminError(503, "Runner credential rotation failed; Runner remains safely fenced.");
        } catch { return adminError(503, "Runner credential rotation state is uncertain; Runner remains safely fenced."); }
      }
      return adminError(response.status === 404 ? 404 : 400, "Runner credential rotation failed.");
    }
    if (canFence) { try { await revokeRunnerTransport(env, runnerId, mutationId); } catch { /* credential generation invalidates old transport */ } }
    return runnerEnrollmentPage(env, baseUrl, runnerId, await createEnrollmentCode(env, runnerId), String(form.get("csrf_token") ?? ""), true);
  }
  return runnerEnrollmentPage(env, baseUrl, runnerId, await createEnrollmentCode(env, runnerId), String(form.get("csrf_token") ?? ""), true);
}
async function consumeInternalNonce(env: WorkerEnv, nonce: string, expiresAtMs: number): Promise<boolean> {
  const body = JSON.stringify({ nonce, expires_at_ms: expiresAtMs });
  const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET ?? "", "POST", "/auth/internal-nonces", body);
  const response = await env.REGISTRY.get(env.REGISTRY.idFromName("registry")).fetch(
    new Request("https://registry.internal/auth/internal-nonces", { method: "POST", headers, body }),
  );
  return response.status === 204;
}

async function registryRequest(env: WorkerEnv, path: string, method: string, body: string): Promise<Response> {
  const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET ?? "", method, path, body);
  return env.REGISTRY.get(env.REGISTRY.idFromName("registry")).fetch(new Request(`https://registry.internal${path}`, { method, body, headers }));
}

async function handleBrowserWorkspaceAction(env: WorkerEnv, form: FormData, runnerId: string, action: "workspace-create" | "workspace-update" | "workspace-delete"): Promise<Response> {
  const returnToDetail = `/admin/runners/${encodeURIComponent(runnerId)}`;
  const workspaceId = form.get("workspace_id");
  if (typeof workspaceId !== "string" || !isSafeIdentifier(workspaceId)) return adminError(400, "Workspace identifier is invalid.");
  if (action === "workspace-delete") {
    if (form.get("confirmation") !== workspaceId) return adminError(400, "Type the Workspace ID to confirm deletion.");
    const response = await mutateRunnerPolicy(env, runnerId, { path: `/auth/runners/${encodeURIComponent(runnerId)}/managed-workspaces/${encodeURIComponent(workspaceId)}`, method: "DELETE", payload: { confirmation: workspaceId } });
    if (!response.ok) return adminError(response.status === 404 ? 404 : 400, "Workspace could not be deleted.");
    return redirect(returnToDetail);
  }
  const displayName = form.get("display_name"); const rootPath = form.get("root_path");
  if (typeof displayName !== "string" || !validLabel(displayName) || typeof rootPath !== "string" || !isAbsolutePath(rootPath)) return adminError(400, "Workspace name or absolute root path is invalid.");
  if (isFullHostPath(rootPath) && !form.getAll("confirm_full_host").includes("true")) return adminError(400, "Full Host Workspace requires explicit confirmation.");
  const configured = configuredWorkspacePreset(form.get("profile"));
  const permissions = configured ?? permissionsFromForm(form);
  if (permissions === undefined) return adminError(400, "Workspace permission profile is invalid.");
  const enabled = form.get("enabled") === "true";
  const payload = { workspace_id: workspaceId, display_name: displayName, root_path: rootPath, enabled, permissions };
  const response = await mutateRunnerPolicy(env, runnerId, { path: action === "workspace-create" ? `/auth/runners/${encodeURIComponent(runnerId)}/managed-workspaces` : `/auth/runners/${encodeURIComponent(runnerId)}/managed-workspaces/${encodeURIComponent(workspaceId)}`, method: action === "workspace-create" ? "POST" : "PUT", payload });
  if (!response.ok) return adminError(response.status === 404 ? 404 : 400, "Workspace could not be saved.");
  return redirect(returnToDetail);
}
function configuredWorkspacePreset(value: FormDataEntryValue | null): { read: boolean; edit: boolean; shell: boolean; job_control: boolean } | undefined {
  if (value === "read_only") return { read: true, edit: false, shell: false, job_control: false };
  if (value === "coding") return { read: true, edit: true, shell: true, job_control: true };
  if (value === "custom" || value === null) return undefined;
  return undefined;
}
function permissionsFromForm(form: FormData): { read: boolean; edit: boolean; shell: boolean; job_control: boolean } | undefined {
  const value = (name: string): boolean | undefined => { const entry = form.get(name); return entry === "true" ? true : entry === "false" ? false : undefined; };
  const read = value("read"); const edit = value("edit"); const shell = value("shell"); const jobControl = value("job_control");
  return read === undefined || edit === undefined || shell === undefined || jobControl === undefined ? undefined : { read, edit, shell, job_control: jobControl };
}
function isFullHostPath(value: string): boolean { return value === "/" || /^[A-Za-z]:[\\/]?$/.test(value); }
function isAbsolutePath(value: string): boolean { return value.length > 0 && value.length <= 4_096 && !value.includes("\0") && (/^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)); }

async function createEnrollmentCode(env: WorkerEnv, runnerId: string): Promise<string | undefined> {
  const code = randomBase64Url();
  const response = await runnerRegistryRequest(env, runnerId, "/enrollments", "POST", JSON.stringify({ enrollment_id: randomBase64Url(), verifier: await sha256Hex(code) }));
  return response.ok ? code : undefined;
}

async function createClient(env: WorkerEnv, form: FormData, baseUrl: string): Promise<Response> {
  const label = form.get("label"); const scopes = selectedScopes(form);
  if (typeof label !== "string" || !validLabel(label) || scopes === undefined) return adminError(400, "Client name or scopes are invalid.");
  const secret = randomBase64Url();
  const clientId = `client-${crypto.randomUUID().replaceAll("-", "")}`;
  const response = await registryPost(env, "/auth/clients", {
    client_id: clientId, label, scopes, secret_verifier: await sha256Hex(secret), secret_prefix: secret.slice(0, 8),
  });
  if (!response.ok) return adminError(response.status === 409 ? 409 : 503, "Client could not be created.");
  return html(secretCreatedPage("MCP client created", secretUrl(baseUrl, secret)));
}

async function adminSession(request: Request, env: WorkerEnv): Promise<{ hash: string; csrf_hash: string } | undefined> {
  const raw = cookieValue(request, ADMIN_SESSION_COOKIE);
  if (raw === undefined || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return undefined;
  const hash = await sha256Hex(raw);
  const response = await registryPost(env, "/auth/sessions/verify", { session_hash: hash });
  const csrfHash = record(response.ok ? await json(response) : undefined)?.csrf_hash;
  return typeof csrfHash === "string" && /^[0-9a-f]{64}$/.test(csrfHash) ? { hash, csrf_hash: csrfHash } : undefined;
}
async function verifyAdminPost(request: Request, form: FormData, session: { csrf_hash: string }): Promise<boolean> {
  if (!sameOrigin(request)) return false;
  const supplied = form.get("csrf_token"); const cookie = cookieValue(request, ADMIN_CSRF_COOKIE);
  return typeof supplied === "string" && typeof cookie === "string" && constantTimeEqual(supplied, cookie) && constantTimeEqual(await sha256Hex(supplied), session.csrf_hash);
}
async function verifyPreAuthCsrf(request: Request, form: FormData, name: string): Promise<boolean> {
  if (!sameOrigin(request)) return false;
  const supplied = form.get("csrf_token"); const cookie = cookieValue(request, name);
  return typeof supplied === "string" && typeof cookie === "string" && constantTimeEqual(supplied, cookie);
}
function sameOrigin(request: Request): boolean {
  const origin = new URL(request.url).origin;
  const candidate = request.headers.get("origin") ?? request.headers.get("referer");
  if (candidate === null || candidate === "null") return true; // privacy browsers may submit Origin: null; the synchronizer token still remains mandatory.
  try { return new URL(candidate).origin === origin; } catch { return false; }
}

const ZH_UI_TEXT: Record<string, string> = {
  "Welcome to Runmesh": "欢迎使用 Runmesh",
  "Agent Control Plane": "智能体控制平面",
  "Enter the Runmesh control plane": "进入 Runmesh 控制平面",
  "Sign in to Runmesh": "登录 Runmesh",
  "Set up Runmesh": "初始化 Runmesh",
  "Control Plane": "控制平面",
  "Mesh Nodes": "网格节点",
  "Mesh Network Active": "网格网络已激活",
  "Distributed runtime orchestration": "分布式运行时编排",
  "Runner Nodes": "Runner 节点",
  "Show password": "显示密码",
  "Hide password": "隐藏密码",
  "Signing in...": "正在登录...",
  "Initializing...": "正在初始化...",
  "Create administrator password": "创建管理员密码",
  "Create your administrator master password to begin managing distributed runtimes and MCP clients.": "创建管理员主密码，以开始管理分布式运行时和 MCP 客户端。",
  "Runner & MCP Control Plane": "Runner 与 MCP 控制平面",
  "Unified orchestration for distributed secure tool sandboxes, persistent agent runtimes, and MCP client bridges.": "统一编排分布式安全工具沙箱、持久化智能体运行时和 MCP 客户端桥接。",
  "Setup token": "初始化令牌",
  "Password": "密码",
  "Confirm password": "确认密码",
  "Initialize": "初始化",
  "Admin password": "管理员密码",
  "Login": "登录",
  "login": "登录",
  "setup": "初始化",
  "Main navigation": "主导航",
  "Dashboard": "仪表盘",
  "Runners": "Runner",
  "MCP Clients": "MCP 客户端",
  "Clients": "MCP 客户端",
  "Settings": "设置",
  "Control plane": "控制平面",
  "A concise view of connected runtimes, clients, and recent work.": "集中查看已连接的运行时、客户端和最近任务。",
  "Refresh": "刷新",
  "Active MCP clients": "活跃 MCP 客户端",
  "Online / total runners": "在线 / 总 Runner",
  "Running jobs": "运行中任务",
  "Recent jobs": "最近任务",
  "Recent runners": "最近 Runner",
  "Recent MCP clients": "最近 MCP 客户端",
  "View all": "查看全部",
  "Runner activity": "Runner 活动",
  "Infrastructure": "基础设施",
  "Manage safe runner metadata and one-time enrollment.": "管理安全的 Runner 元数据和一次性注册。",
  "Add Runner": "添加 Runner",
  "Enrollment codes expire after 30 minutes.": "注册码将在 30 分钟后过期。",
  "Display name": "显示名称",
  "Safe runner ID": "安全 Runner ID",
  "optional": "可选",
  "Create enrollment": "创建注册",
  "Registered runners": "已注册 Runner",
  "Status": "状态",
  "Platform / architecture": "平台 / 架构",
  "Workspaces": "工作区",
  "Active jobs": "活跃任务",
  "Last seen": "最后在线",
  "Actions": "操作",
  "View": "查看",
  "Rename": "重命名",
  "Rotate Credential": "轮换凭据",
  "Type Runner ID to confirm": "输入 Runner ID 以确认",
  "Type the Runner ID to confirm emergency lock": "输入 Runner ID 以确认紧急锁定",
  "Revoke": "撤销",
  "Delete": "删除",
  "Install / Reinstall": "安装 / 重装",
  "Integrations": "集成",
  "Manage labels, scopes, runner routing, and one-time client secrets.": "管理标签、权限范围、Runner 路由和一次性客户端密钥。",
  "Add MCP Client": "添加 MCP 客户端",
  "Label": "标签",
  "Scopes": "权限范围",
  "Create one-time secret": "创建一次性密钥",
  "MCP clients": "MCP 客户端",
  "Active runner": "活跃 Runner",
  "Last used": "最后使用",
  "Reset Runner Selection": "重置 Runner 选择",
  "Rotate": "轮换",
  "MCP Client": "MCP 客户端",
  "MCP Client detail": "MCP 客户端详情",
  "Runner-specific access can only further restrict the client's global scopes; it can never grant additional access.": "针对 Runner 的访问限制只能收紧客户端全局权限，不能额外授予权限。",
  "Back to clients": "返回客户端",
  "Global permissions": "全局权限",
  "Base scopes": "基础权限范围",
  "Save scopes": "保存权限范围",
  "Client access on each Runner": "每个 Runner 上的客户端访问",
  "Use Global means no additional restriction. Effective access is still limited by Runner and Workspace policy.": "使用全局表示不增加额外限制；有效权限仍受 Runner 与工作区策略约束。",
  "Use global": "使用全局",
  "Additional restriction": "附加限制",
  "Save restriction": "保存限制",
  "Reset": "重置",
  "Workspace administration": "工作区管理",
  "Keep operator notes here; credentials and secrets are never displayed.": "在此保留操作入口；凭据和密钥绝不会显示。",
  "Change password": "修改密码",
  "Current password": "当前密码",
  "New password": "新密码",
  "Confirm new password": "确认新密码",
  "Operator notes": "操作说明",
  "Deployment notes belong in your deployment system. This dashboard intentionally stores no notes or secrets.": "部署说明应保存在部署系统中；此控制台不会存储说明或密钥。",
  "Log out": "退出登录",
  "No runners yet.": "还没有 Runner。",
  "No MCP clients yet.": "还没有 MCP 客户端。",
  "No recent jobs.": "还没有最近任务。",
  "No managed workspaces configured.": "尚未配置托管工作区。",
  "Not selected": "未选择",
  "Active": "活跃",
  "Revoked": "已撤销",
  "Job": "任务",
  "Workspace": "工作区",
  "Updated": "更新时间",
  "Runner details": "Runner 详情",
  "Control-plane workspace roots appear only in this authenticated administrator view.": "工作区根路径只会出现在此经过认证的管理员视图中。",
  "Back to runners": "返回 Runner",
  "Runner ID": "Runner ID",
  "Policy status": "策略状态",
  "Safe metadata": "安全元数据",
  "Platform": "平台",
  "Architecture": "架构",
  "Hostname": "主机名",
  "Runner version": "Runner 版本",
  "Stable/latest version": "稳定 / 最新版本",
  "Protocol compatibility": "协议兼容性",
  "Version policy": "版本策略",
  "Runmesh Runner one-click installation": "Runmesh Runner 一键安装",
  "Install Runmesh Runner": "安装 Runmesh Runner",
  "This command downloads the pinned Runmesh Runner release, verifies its checksum when configured, enrolls this host, and installs the service. The one-time code expires in 30 minutes and will not be shown again.": "此命令会下载固定版本的 Runmesh Runner、在已配置时校验 checksum、注册当前主机并安装服务。一次性代码将在 30 分钟后过期，且不会再次显示。",
  "Run only on the intended host. The command contains a single-use enrollment code; never share or log it. Node.js 20+ and an elevated administrator/root shell are required.": "请只在目标主机上运行。命令包含单次使用的注册代码，请勿分享或记录。需要 Node.js 20+ 以及管理员/root 权限 Shell。",
  "Copy install command": "复制安装命令",
  "Channel": "频道",
  "Stable": "稳定版",
  "Pinned": "固定版本",
  "Desired version": "期望版本",
  "Current": "当前",
  "Latest": "最新",
  "Save version policy": "保存版本策略",
  "Environment tools": "环境工具",
  "Environment details unavailable while offline.": "离线时无法获取环境详情。",
  "Runner permission profile": "Runner 权限配置",
  "Changes remain pending until the connected Runner validates and applies the revision.": "变更会保持待处理，直到已连接的 Runner 校验并应用该版本。",
  "Emergency control": "紧急控制",
  "Save profile": "保存配置",
  "Emergency Lock does not automatically stop existing Jobs.": "紧急锁定不会自动停止已有任务。",
  "Emergency lock all permissions": "紧急锁定所有权限",
  "Managed workspaces": "托管工作区",
  "Each save increments the desired policy revision.": "每次保存都会递增期望策略版本。",
  "Add workspace": "添加工作区",
  "Workspace ID": "工作区 ID",
  "Absolute root path": "绝对根路径",
  "Usage profile": "使用配置",
  "Custom": "自定义",
  "Read Only": "只读",
  "Coding": "编码",
  "Full-host confirmation": "整机访问确认",
  "I understand this exposes the full host filesystem.": "我理解这会暴露完整宿主机文件系统。",
  "Type Workspace ID to confirm": "输入工作区 ID 以确认",
  "Enabled": "启用",
  "Disabled": "禁用",
  "Allow": "允许",
  "Deny": "拒绝",
  "Save workspace": "保存工作区",
  "Create workspace": "创建工作区",
  "Delete workspace": "删除工作区",
  "Manual portable-artifact enrollment": "手动便携制品注册",
  "Enroll Runner manually": "手动注册 Runner",
  "Enroll Runner": "注册 Runner",
  "Target Runner ID": "目标 Runner ID",
  "One-time enrollment code": "一次性注册代码",
  "Hosted installers are disabled in this development preview. Download and verify the portable Runner artifact first. This one-time code expires in 30 minutes and will not be shown again.": "此开发预览版已禁用托管安装器。请先下载并校验便携 Runner 制品。此一次性代码将在 30 分钟后过期，且不会再次显示。",
  "The fixed signed hosted release is not enabled on this deployment. Download and verify the portable Runner artifact first, then paste this code only into the local prompt requested by --code-stdin. This one-time code expires in 30 minutes and will not be shown again.": "当前部署未启用固定签名托管版本。请先下载并校验便携 Runner 制品，然后仅将此代码粘贴到 --code-stdin 所要求的本地提示中。此一次性代码将在 30 分钟后过期，且不会再次显示。",
  "The installer verifies the fixed signed Runner artifact before it asks locally for this one-time code. It never places the code in this command, a URL, or process arguments. This one-time code expires in 30 minutes and will not be shown again.": "安装器会先校验固定签名的 Runner 制品，再在本地请求此一次性代码。代码不会放入此命令、URL 或进程参数中。此一次性代码将在 30 分钟后过期，且不会再次显示。",
  "Paste it only into the local prompt after verification; it is deliberately excluded from copied commands.": "请仅在完成校验后将其粘贴到本地提示中；代码不会包含在复制的命令里。",
  "Operating system": "操作系统",
  "Copy enrollment command": "复制注册命令",
  "Do not share this code. It is single-use enrollment material, not an administrator password, MCP secret, or long-term credential.": "不要分享此代码。它是一次性注册材料，不是管理员密码、MCP 密钥或长期凭据。",
  "Regenerate enrollment": "重新生成注册",
  "Done": "完成",
  "MCP client created": "MCP 客户端已创建",
  "MCP client rotated": "MCP 客户端已轮换",
  "enrollment": "注册",
  "Signed fixed-preview enrollment": "签名固定预览版注册",
  "Copy installer command": "复制安装器命令",
  "Copy this URL now. It will not be shown again.": "请立即复制此 URL。它不会再次显示。",
  "Back to admin": "返回管理后台",
  "Return": "返回",
  "Invalid administrator password.": "管理员密码无效。",
  "Please try again shortly.": "请稍后重试。",
  "Invalid setup request.": "初始化请求无效。",
  "Setup request was rejected.": "初始化请求已被拒绝。",
  "Setup could not be completed. Try again.": "初始化无法完成，请重试。",
  "Passwords must match and be at least 12 characters.": "两次密码必须一致且至少 12 个字符。",
  "This instance is already initialized.": "此实例已初始化。",
  "Invalid login request.": "登录请求无效。",
  "Login request was rejected.": "登录请求已被拒绝。",
  "Login could not be completed. Try again.": "登录无法完成，请重试。",
  "Administrative request was rejected.": "管理请求已被拒绝。",
  "MCP client was not found.": "未找到 MCP 客户端。",
  "Runner was not found.": "未找到 Runner。",
  "Client scopes are invalid.": "客户端权限范围无效。",
  "Client scopes could not be updated.": "客户端权限范围无法更新。",
  "Runner selection could not be reset.": "Runner 选择无法重置。",
  "Runner identifier is invalid.": "Runner 标识无效。",
  "Runner restriction could not be reset.": "Runner 限制无法重置。",
  "Runner restriction is invalid.": "Runner 限制无效。",
  "Runner restriction could not be saved.": "Runner 限制无法保存。",
  "Client name is invalid.": "客户端名称无效。",
  "Client update failed.": "客户端更新失败。",
  "Client revoke failed.": "客户端撤销失败。",
  "Client rotation failed.": "客户端轮换失败。",
  "Password change is invalid.": "密码修改请求无效。",
  "Current administrator password is invalid.": "当前管理员密码无效。",
  "Password change could not be completed.": "密码修改无法完成。",
  "Runner identifier or display name is invalid.": "Runner 标识或显示名称无效。",
  "Runner could not be added.": "无法添加 Runner。",
  "Runner update policy is invalid.": "Runner 更新策略无效。",
  "Pinned Runner version must be an exact version.": "固定 Runner 版本必须是精确版本号。",
  "Runner update policy could not be updated.": "Runner 更新策略无法更新。",
  "Runner permissions are invalid.": "Runner 权限无效。",
  "Runner permission profile could not be updated.": "Runner 权限配置无法更新。",
  "Type the Runner ID to confirm emergency lock.": "输入 Runner ID 以确认紧急锁定。",
  "Emergency lock could not be applied.": "紧急锁定无法应用。",
  "Runner display name is invalid.": "Runner 显示名称无效。",
  "Runner rename failed.": "Runner 重命名失败。",
  "Type the Runner ID to confirm deletion.": "输入 Runner ID 以确认删除。",
  "Runner deletion could not fence the Runner.": "Runner 删除无法先隔离该 Runner。",
  "Runner deletion outcome is uncertain; Runner remains safely fenced.": "Runner 删除结果不确定；Runner 保持安全隔离。",
  "Runner deletion failed; Runner remains safely fenced.": "Runner 删除失败；Runner 保持安全隔离。",
  "Runner deletion state is uncertain; Runner remains safely fenced.": "Runner 删除状态不确定；Runner 保持安全隔离。",
  "Runner delete failed.": "Runner 删除失败。",
  "Type the Runner ID to confirm revocation.": "输入 Runner ID 以确认撤销。",
  "Runner revocation could not fence the Runner.": "Runner 撤销无法先隔离该 Runner。",
  "Runner revocation outcome is uncertain; Runner remains safely fenced.": "Runner 撤销结果不确定；Runner 保持安全隔离。",
  "Runner revocation failed; Runner remains safely fenced.": "Runner 撤销失败；Runner 保持安全隔离。",
  "Runner revocation state is uncertain; Runner remains safely fenced.": "Runner 撤销状态不确定；Runner 保持安全隔离。",
  "Runner revoke failed.": "Runner 撤销失败。",
  "Runner credential rotation could not fence the Runner.": "Runner 凭据轮换无法先隔离该 Runner。",
  "Runner credential rotation outcome is uncertain; Runner remains safely fenced.": "Runner 凭据轮换结果不确定；Runner 保持安全隔离。",
  "Runner credential rotation failed; Runner remains safely fenced.": "Runner 凭据轮换失败；Runner 保持安全隔离。",
  "Runner credential rotation state is uncertain; Runner remains safely fenced.": "Runner 凭据轮换状态不确定；Runner 保持安全隔离。",
  "Runner credential rotation failed.": "Runner 凭据轮换失败。",
  "Workspace identifier is invalid.": "工作区标识无效。",
  "Type the Workspace ID to confirm deletion.": "输入工作区 ID 以确认删除。",
  "Workspace could not be deleted.": "工作区无法删除。",
  "Workspace name or absolute root path is invalid.": "工作区名称或绝对根路径无效。",
  "Full Host Workspace requires explicit confirmation.": "整机工作区需要明确确认。",
  "Workspace permission profile is invalid.": "工作区权限配置无效。",
  "Workspace could not be saved.": "工作区无法保存。",
  "Client name or scopes are invalid.": "客户端名称或权限范围无效。",
  "Client could not be created.": "客户端无法创建。",
  "Enrollment code could not be generated.": "注册码无法生成。",
  "Never": "从未",
  "Unknown": "未知",
  "Not configured": "未配置",
  "Not enrolled": "未注册",
  "Available": "可用",
  "Unavailable": "不可用",
  "online": "在线",
  "offline": "离线",
  "stale": "过期",
  "pending": "待处理",
  "invalid": "无效",
  "queued": "排队中",
  "running": "运行中",
  "cancelling": "取消中",
  "succeeded": "成功",
  "completed": "已完成",
  "failed": "失败",
  "unknown": "未知",
  "read": "读取",
  "edit": "编辑",
  "shell": "Shell",
  "job control": "任务控制",
  "Summary": "摘要",
  "Runner summary": "Runner 摘要",
  "configured": "已配置",
  "connected": "已连接",
  "In progress": "进行中",
  "Idle": "空闲",
  "Recorded": "已记录",
  "Socket connected": "Socket 已连接",
  "Disconnected": "已断开",
  "Unique runtime": "唯一运行时",
  "Revision applied / desired": "已应用 / 期望版本",
  "Heartbeat": "心跳",
  "Policy is recorded for operators; package download, update, and rollback remain deferred.": "策略会记录供操作员查看；软件包下载、更新和回滚暂缓处理。",
  "Hosted distribution is not configured. Portable artifact/manual version management only.": "托管分发尚未配置；当前仅支持便携制品和手动版本管理。",
  "Effective Global Scopes": "生效的全局权限范围",
  "Each base scope has a distinct ceiling:": "每个基础权限范围都有独立上限：",
  "Each base scope has a distinct ceiling: coding:read permits inspection, coding:write permits approved edits, and coding:exec permits Host shell and Job control. Runner and Workspace policy can only reduce these permissions.": "每个基础权限范围都有独立上限：coding:read 允许查看，coding:write 允许已批准的编辑，coding:exec 允许使用主机 Shell 和任务控制。Runner 与工作区策略只能收紧这些权限。",
  " permits inspection, ": " 允许查看，",
  " permits approved edits, and ": " 允许已批准的编辑，并且 ",
  " permits Host shell and Job control. Runner and Workspace policy can only reduce these permissions.": " 允许使用主机 Shell 和任务控制。Runner 与工作区策略只能收紧这些权限。",
  "Client Routing & Status": "客户端路由与状态",
  "Client ID": "客户端 ID",
  "Active Runner": "活跃 Runner",
  "Last Used": "最后使用",
  "Workspace Permissions": "工作区权限",
  "Unknown–Unknown · unknown": "未知–未知 · 未知",
  "Copy MCP URL": "复制 MCP URL",
  "No runners registered.": "尚未注册 Runner。",
  "Inspect workspaces and read files.": "检查工作区并读取文件。",
  "Apply approved edits.": "应用已批准的编辑。",
  "Use Host shell and control Jobs.": "使用主机 Shell 并控制任务。",
  "Runmesh · Agent Control Plane": "Runmesh · 智能体控制平面",
};

function brandLogo(className: string, alt = "Runmesh · Agent Control Plane"): string {
  return `<img class="${className}" src="/assets/logo.png" alt="${escapeHtml(alt)}" width="1672" height="941" decoding="async">`;
}

function meshMarkSvg(className = "mesh-mark"): string {
  // Keep the decorative mesh mark for illustrations, but use the shipped
  // product wordmark anywhere users identify the application. The previous
  // redesign rendered a synthetic SVG in these slots and never used logo.png.
  if (className === "header-mesh-mark") return brandLogo("header-mesh-mark");
  if (className === "login-brand-logo") return brandLogo("login-brand-logo");
  if (className === "secret-mesh-mark") return brandLogo("secret-mesh-mark");
  if (className === "error-mesh-mark") return brandLogo("error-mesh-mark");
  return `<svg class="${className}" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <circle cx="24" cy="24" r="19" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2 4" stroke-opacity="0.35"/>
    <circle cx="24" cy="24" r="10" stroke="currentColor" stroke-width="1.5" stroke-opacity="0.5"/>
    <circle cx="24" cy="5" r="2.5" fill="currentColor"/>
    <circle cx="43" cy="24" r="2.5" fill="currentColor"/>
    <circle cx="24" cy="43" r="2.5" fill="currentColor"/>
    <circle cx="5" cy="24" r="2.5" fill="currentColor"/>
    <circle cx="37.4" cy="10.6" r="2" fill="currentColor" fill-opacity="0.75"/>
    <circle cx="37.4" cy="37.4" r="2" fill="currentColor" fill-opacity="0.75"/>
    <circle cx="10.6" cy="37.4" r="2" fill="currentColor" fill-opacity="0.75"/>
    <circle cx="10.6" cy="10.6" r="2" fill="currentColor" fill-opacity="0.75"/>
    <circle cx="24" cy="24" r="3.5" fill="currentColor"/>
    <path d="M24 5L24 43M5 24L43 24M10.6 10.6L37.4 37.4M10.6 37.4L37.4 10.6" stroke="currentColor" stroke-width="1" stroke-opacity="0.2"/>
  </svg>`;
}

function meshVisualGraphic(): string {
  return `<div class="mesh-network-visual" aria-hidden="true">
    <div class="mesh-canvas-wrap">
      <svg class="mesh-grid-svg" viewBox="0 0 440 440" fill="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <radialGradient id="meshCenterGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="rgba(255,255,255,0.12)"/>
            <stop offset="100%" stop-color="rgba(255,255,255,0)"/>
          </radialGradient>
        </defs>
        <circle cx="220" cy="220" r="190" fill="url(#meshCenterGlow)"/>
        <circle cx="220" cy="220" r="180" stroke="rgba(255,255,255,0.06)" stroke-width="1" stroke-dasharray="3 6"/>
        <circle cx="220" cy="220" r="130" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
        <circle cx="220" cy="220" r="70" stroke="rgba(255,255,255,0.12)" stroke-width="1.2"/>
        <!-- Interconnecting mesh lines -->
        <path d="M220 90 L330 155 L330 285 L220 350 L110 285 L110 155 Z" stroke="rgba(255,255,255,0.15)" stroke-width="1.2"/>
        <path d="M220 220 L220 90 M220 220 L330 155 M220 220 L330 285 M220 220 L220 350 M220 220 L110 285 M220 220 L110 155" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>
        <path d="M220 40 L220 90 M400 220 L330 155 M375 310 L330 285 M220 400 L220 350 M65 310 L110 285 M40 220 L110 155" stroke="rgba(255,255,255,0.06)" stroke-width="1" stroke-dasharray="2 3"/>

        <!-- Outer satellite nodes -->
        <circle cx="220" cy="40" r="3" fill="#888C93"/>
        <circle cx="400" cy="220" r="3" fill="#888C93"/>
        <circle cx="375" cy="310" r="3" fill="#888C93"/>
        <circle cx="220" cy="400" r="3" fill="#888C93"/>
        <circle cx="65" cy="310" r="3" fill="#888C93"/>
        <circle cx="40" cy="220" r="3" fill="#888C93"/>

        <!-- Primary Ring Nodes -->
        <g class="mesh-node node-1"><circle cx="220" cy="90" r="5" fill="#22c55e"/><circle cx="220" cy="90" r="10" stroke="#22c55e" stroke-opacity="0.3" stroke-width="1.5"/></g>
        <g class="mesh-node node-2"><circle cx="330" cy="155" r="4.5" fill="#22c55e"/><circle cx="330" cy="155" r="9" stroke="#22c55e" stroke-opacity="0.3" stroke-width="1.5"/></g>
        <g class="mesh-node node-3"><circle cx="330" cy="285" r="4" fill="#a1a1aa"/><circle cx="330" cy="285" r="8" stroke="#a1a1aa" stroke-opacity="0.2" stroke-width="1.5"/></g>
        <g class="mesh-node node-4"><circle cx="220" cy="350" r="4.5" fill="#22c55e"/><circle cx="220" cy="350" r="9" stroke="#22c55e" stroke-opacity="0.3" stroke-width="1.5"/></g>
        <g class="mesh-node node-5"><circle cx="110" cy="285" r="4.5" fill="#22c55e"/><circle cx="110" cy="285" r="9" stroke="#22c55e" stroke-opacity="0.3" stroke-width="1.5"/></g>
        <g class="mesh-node node-6"><circle cx="110" cy="155" r="4" fill="#a1a1aa"/><circle cx="110" cy="155" r="8" stroke="#a1a1aa" stroke-opacity="0.2" stroke-width="1.5"/></g>

        <!-- Central Control DO Node -->
        <circle cx="220" cy="220" r="8" fill="#F5F5F5"/>
        <circle cx="220" cy="220" r="16" stroke="rgba(255,255,255,0.4)" stroke-width="1.5"/>
        <circle cx="220" cy="220" r="24" stroke="rgba(255,255,255,0.15)" stroke-width="1" stroke-dasharray="3 3"/>
      </svg>
    </div>
    <div class="mesh-visual-caption">
      <div class="mesh-caption-badge"><span class="status-dot online"></span> <span>Mesh Network Active</span></div>
      <p class="mesh-caption-sub">Distributed runtime orchestration</p>
    </div>
  </div>`;
}

function languageSwitch(): string { return `<div class="language-switch" data-no-i18n aria-label="Language"><a href="?lang=en" data-lang-toggle="en" hreflang="en">EN</a><a href="?lang=zh-CN" data-lang-toggle="zh-CN" hreflang="zh-CN">中文</a></div>`; }

function passwordToggle(): string {
  return `<button type="button" class="pwd-toggle-btn" aria-label="Show password">
    <svg class="eye-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
  </button>`;
}

function setupPage(): Response {
  const csrf = randomBase64Url();
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/assets/favicon.png" type="image/png"><title>Runmesh · Agent Control Plane setup</title>${adminStyles()}</head><body class="auth-body">${languageSwitch()}<div class="login-layout"><aside class="login-brand-pane"><div class="login-brand-header"><div class="login-brand-title-wrap">${meshMarkSvg("login-brand-logo")}<span class="brand-name">Runmesh</span><span class="brand-tag">CONTROL PLANE</span></div><h2 class="login-brand-headline">Set up Runmesh</h2><p class="login-brand-desc">Create your administrator master password to begin managing distributed runtimes and MCP clients.</p></div>${meshVisualGraphic()}</aside><main class="login-form-pane"><div class="login-form-container"><div class="auth-header-mobile"><div class="login-brand-title-wrap">${meshMarkSvg("login-brand-logo")}<span class="brand-name">Runmesh</span></div></div><div class="login-title-group"><p class="brand-kicker">Runmesh</p><h1>Welcome to Runmesh</h1><p class="subtitle">Agent Control Plane</p><p class="lede">Create administrator password</p></div><form method="post" action="/setup" class="login-form stack"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><div class="input-group"><label for="setup_token">Setup token</label><div class="password-input-wrap"><input id="setup_token" type="password" name="setup_token" autocomplete="one-time-code" required>${passwordToggle()}</div></div><div class="input-group"><label for="password">Password</label><div class="password-input-wrap"><input id="password" type="password" name="password" autocomplete="new-password" required minlength="12">${passwordToggle()}</div></div><div class="input-group"><label for="confirm_password">Confirm password</label><div class="password-input-wrap"><input id="confirm_password" type="password" name="confirm_password" autocomplete="new-password" required minlength="12">${passwordToggle()}</div></div><button class="login-submit-btn">Initialize</button></form></div></main></div>${adminScript()}</body></html>`, [`${SETUP_CSRF_COOKIE}=${csrf}; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=${Math.floor(SETUP_CSRF_TTL_MS / 1_000)}`]);
}

function loginPage(): Response {
  const csrf = randomBase64Url();
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/assets/favicon.png" type="image/png"><title>Runmesh · Agent Control Plane login</title>${adminStyles()}</head><body class="auth-body">${languageSwitch()}<div class="login-layout"><aside class="login-brand-pane"><div class="login-brand-header"><div class="login-brand-title-wrap">${meshMarkSvg("login-brand-logo")}<span class="brand-name">Runmesh</span><span class="brand-tag">CONTROL PLANE</span></div><h2 class="login-brand-headline">Runner &amp; MCP Control Plane</h2><p class="login-brand-desc">Unified orchestration for distributed secure tool sandboxes, persistent agent runtimes, and MCP client bridges.</p></div>${meshVisualGraphic()}</aside><main class="login-form-pane"><div class="login-form-container"><div class="auth-header-mobile"><div class="login-brand-title-wrap">${meshMarkSvg("login-brand-logo")}<span class="brand-name">Runmesh</span></div></div><div class="login-title-group"><p class="brand-kicker">Runmesh</p><h1>Runmesh</h1><p class="subtitle">Agent Control Plane</p><p class="login-invite">Enter the Runmesh control plane</p></div><form method="post" action="/login" class="login-form stack"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><div class="input-group"><label for="admin_password">Admin password</label><div class="password-input-wrap"><input id="admin_password" type="password" name="password" autocomplete="current-password" required>${passwordToggle()}</div></div><button class="login-submit-btn">Login</button></form></div></main></div>${adminScript()}</body></html>`, [`${LOGIN_CSRF_COOKIE}=${csrf}; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=${Math.floor(SETUP_CSRF_TTL_MS / 1_000)}`]);
}
type AdminData = { readonly clients: readonly McpClientRecord[]; readonly runners: readonly RunnerRecord[]; readonly jobs: readonly Record<string, unknown>[]; readonly snapshot: Record<string, unknown> };
async function loadDashboardData(env: WorkerEnv): Promise<AdminData> {
  const [clientsResponse, runnersResponse, snapshotResponse] = await Promise.all([registryGet(env, "/auth/clients"), registryGet(env, "/dashboard"), registryGet(env, "/runners")]);
  const clients = clientsResponse.ok ? ((record(await json(clientsResponse))?.clients ?? []) as McpClientRecord[]) : [];
  const snapshotBody = snapshotResponse.ok ? record(await json(snapshotResponse)) : undefined;
  const runners = snapshotBody !== undefined && Array.isArray(snapshotBody.runners) ? snapshotBody.runners as RunnerRecord[] : runnersResponse.ok ? ((record(await json(runnersResponse))?.runners ?? []) as RunnerRecord[]) : [];
  const jobs = snapshotBody !== undefined && Array.isArray(snapshotBody.jobs) ? snapshotBody.jobs.filter(record) as Record<string, unknown>[] : [];
  return { clients, runners, jobs, snapshot: snapshotBody ?? {} };
}
async function policyReadiness(env: WorkerEnv, runnerId: string): Promise<{ ok: true; value: { applied_revision: number; active_checksum: string } } | { ok: false }> {
  let response: Response;
  try { response = await registryGet(env, `/runners/${encodeURIComponent(runnerId)}/policy-readiness`); } catch { return { ok: false }; }
  if (!response.ok) return { ok: false };
  const value = record(await json(response));
  const revision = value?.applied_revision;
  const checksum = value?.active_checksum;
  const validRevision = (candidate: unknown): candidate is number => typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0;
  const validChecksum = (candidate: unknown): candidate is string => typeof candidate === "string" && /^[a-f0-9]{64}$/.test(candidate);
  return value?.ok === true && value.policy_status === "applied"
    && validRevision(value.desired_revision) && validRevision(revision) && validRevision(value.runner_reported_policy_revision)
    && validChecksum(value.desired_checksum) && validChecksum(checksum) && validChecksum(value.runner_reported_policy_checksum)
    && value.desired_revision === revision && value.runner_reported_policy_revision === revision
    && value.desired_checksum === checksum && value.runner_reported_policy_checksum === checksum
    ? { ok: true, value: { applied_revision: revision, active_checksum: checksum } } : { ok: false };
}
async function runnerEnvironment(env: WorkerEnv, runnerId: string): Promise<Record<string, unknown> | undefined> {
  const readiness = await policyReadiness(env, runnerId);
  if (!readiness.ok) return undefined;
  let response: Response;
  try { response = await runnerRpc(env, runnerId, "env.info", {}, readiness.value.applied_revision, readiness.value.active_checksum); } catch { return undefined; }
  const body = response.ok ? record(await json(response)) : undefined;
  return record(body?.result);
}
async function runnerRpc(env: WorkerEnv, runnerId: string, method: string, params: Record<string, unknown>, policyRevision?: number, policyChecksum?: string): Promise<Response> {
  const body = JSON.stringify({ method, params, ...(policyRevision === undefined || policyChecksum === undefined ? {} : { policy_revision: policyRevision, expected_policy_revision: policyRevision, expected_policy_checksum: policyChecksum }) });
  const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET ?? "", "POST", "/rpc", body);
  return env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/rpc", { method: "POST", headers, body }));
}
async function clientDetailPage(_env: WorkerEnv, client: Record<string, unknown>, runners: readonly RunnerRecord[], overrides: readonly Record<string, unknown>[], csrf: string): Promise<string> {
  const clientId = typeof client.client_id === "string" ? client.client_id : "unknown";
  const label = typeof client.label === "string" ? client.label : clientId;
  const isRevoked = client.revoked_at_ms !== null;
  const overrideRows = runners.map((runner) => {
    const override = overrides.find((item) => item.runner_id === runner.runner_id);
    const permissions = record(override?.permissions);
    const isCustom = override !== undefined;
    return `<tr class="data-row">
      <td>
        <div class="table-primary-cell">
          <span class="strong">${escapeHtml(runner.display_name)}</span>
          <span class="sub-id mono">${escapeHtml(runner.runner_id)}</span>
        </div>
      </td>
      <td>
        <span class="mode-pill ${isCustom ? "custom" : "global"}">${isCustom ? "Additional restriction" : "Use global"}</span>
      </td>
      <td colspan="4">
        <form method="post" action="/admin/clients/${encodeURIComponent(clientId)}/${override === undefined ? "override" : "override"}" class="override-form-row">
          <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
          <input type="hidden" name="runner_id" value="${escapeHtml(runner.runner_id)}">
          <div class="perm-selects-wrap">
            ${permissionSelect("read", permissions?.read === true)}
            ${permissionSelect("edit", permissions?.edit === true)}
            ${permissionSelect("shell", permissions?.shell === true)}
            ${permissionSelect("job_control", permissions?.job_control === true)}
          </div>
          <div class="override-actions">
            <button class="small secondary">Save restriction</button>
            ${override === undefined ? "" : `<button class="small danger" formaction="/admin/clients/${encodeURIComponent(clientId)}/reset-override">Reset</button>`}
          </div>
        </form>
      </td>
    </tr>`;
  }).join("");
  const scopeValues = Array.isArray(client.scopes) ? client.scopes.filter((scope): scope is string => typeof scope === "string") : [];
  const scopeEditor = `<form method="post" action="/admin/clients/${encodeURIComponent(clientId)}/scopes" class="scope-editor-form">
    <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
    <fieldset class="scope-fieldset">
      <legend>Base scopes</legend>
      <div class="scope-selector-row">
        ${scopeCheckboxes(scopeValues)}
      </div>
    </fieldset>
    <div class="form-submit-wrap">
      <button class="button secondary">Save scopes</button>
    </div>
  </form>`;
  return `<section class="detail-header">
    <div class="detail-title-group">
      <div class="detail-title-row">
        <p class="eyebrow">MCP Client detail</p>
        <h1 class="detail-title">${escapeHtml(label)}</h1>
        ${statusBadge(isRevoked ? "offline" : "online")}
      </div>
      <p class="detail-id mono">${escapeHtml(clientId)}</p>
      <p class="lede">Runner-specific access can only further restrict the client's global scopes; it can never grant additional access.</p>
    </div>
    <div class="detail-header-actions">
      <a class="button secondary" href="/admin/clients">Back to clients</a>
    </div>
  </section>
  <div class="grid-two">
    <section class="panel">
      <div class="section-title">
        <h2>Global permissions</h2>
      </div>
      <div class="active-scopes-box">
        <span class="form-stat-label">Effective Global Scopes</span>
        <p class="muted scope-line">${escapeHtml(scopeValues.join(", "))}</p>
      </div>
      <p class="muted scope-help">Each base scope has a distinct ceiling: <span class="mono">coding:read</span> permits inspection, <span class="mono">coding:write</span> permits approved edits, and <span class="mono">coding:exec</span> permits Host shell and Job control. Runner and Workspace policy can only reduce these permissions.</p>
      ${scopeEditor}
    </section>
    <section class="panel">
      <div class="section-title">
        <h2>Client Routing &amp; Status</h2>
      </div>
      <dl class="details">
        <dt>Client ID</dt>
        <dd class="mono">${escapeHtml(clientId)}</dd>
        <dt>Active Runner</dt>
        <dd><span class="routing-badge">${escapeHtml(activeRunnerLabel(client as unknown as McpClientRecord, runners))}</span></dd>
        <dt>Last Used</dt>
        <dd class="time-cell">${escapeHtml(time(typeof client.last_used_at_ms === "number" ? client.last_used_at_ms : null))}</dd>
        <dt>Status</dt>
        <dd>${isRevoked ? "Revoked" : "Active"}</dd>
      </dl>
    </section>
  </div>
  <section class="panel">
    <div class="section-title">
      <h2>Client access on each Runner</h2>
      <span class="muted font-12">Use Global means no additional restriction. Effective access is still limited by Runner and Workspace policy.</span>
    </div>
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>Runner</th>
            <th>Mode</th>
            <th colspan="4">Additional restriction</th>
          </tr>
        </thead>
        <tbody>${overrideRows || `<tr><td colspan="6" class="empty"><div class="empty-state-box"><p>No runners registered.</p></div></td></tr>`}</tbody>
      </table>
    </div>
  </section>`;
}
function adminDocument(title: string, body: string, active: "dashboard" | "runners" | "clients" | "settings"): string {
  const nav = `<nav class="control-nav" aria-label="Main navigation"><a class="${active === "dashboard" ? "active" : ""}"${active === "dashboard" ? ' aria-current="page"' : ""} href="/admin">Dashboard</a><a class="${active === "runners" ? "active" : ""}"${active === "runners" ? ' aria-current="page"' : ""} href="/admin/runners">Runners</a><a class="${active === "clients" ? "active" : ""}"${active === "clients" ? ' aria-current="page"' : ""} href="/admin/clients">MCP Clients</a><a class="${active === "settings" ? "active" : ""}"${active === "settings" ? ' aria-current="page"' : ""} href="/admin/settings">Settings</a></nav>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><script>try{var t=localStorage.getItem('runmesh-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(_){}</script><link rel="icon" href="/assets/favicon.png" type="image/png"><link rel="preload" href="/assets/logo.png" as="image" type="image/png"><title>${escapeHtml(title)} · Runmesh · Agent Control Plane</title>${adminStyles()}</head><body class="ops-body"><a class="skip-link" href="#main-content">Skip to main content</a><header class="app-header"><div class="header-inner"><div class="header-left"><a class="brand" href="/admin">${meshMarkSvg("header-mesh-mark")}<span class="brand-copy"><span>Runmesh</span><small>Agent Control Plane</small></span></a>${nav}</div><div class="header-actions">${languageSwitch()}${themeControl()}<a class="button secondary" href="/admin/runners#add-runner">Add Runner</a><a class="button" href="/admin/clients#add-client">Add MCP Client</a></div></div></header><div class="shell"><main class="workspace" id="main-content" tabindex="-1">${body}</main></div>${adminScript()}</body></html>`;
}
function themeControl(): string { return `<button type="button" class="theme-control" data-theme-toggle aria-label="Theme: system" aria-live="polite">Theme: system</button>`; }
function adminPage(pathname: string, data: AdminData, csrf: string): string {
  const active = pathname === "/admin" ? "dashboard" : pathname.slice("/admin/".length) as "runners" | "clients" | "settings";
  const body = active === "runners" ? runnersPage(data, csrf) : active === "clients" ? clientsPage(data, csrf) : active === "settings" ? settingsPage(csrf) : overviewPage(data, csrf);
  return adminDocument(active[0]?.toUpperCase() + active.slice(1), body, active);
}
function overviewPage(data: AdminData, csrf: string): string {
  const online = data.runners.filter((runner) => runner.state === "online").length;
  const activeJobs = data.jobs.filter((job) => ["queued", "running", "cancelling"].includes(String(job.status))).length;
  return `<section class="page-heading"><div><p class="eyebrow">Control plane</p><h1>Dashboard</h1><p class="lede">A concise view of connected runtimes, clients, and recent work.</p></div><a class="button secondary" href="/admin">Refresh</a></section><section class="metrics" aria-label="Summary"><div class="metric"><span class="metric-label">Active MCP clients</span><strong class="metric-value">${data.clients.filter((client) => client.revoked_at_ms === null).length}</strong><span class="metric-meta">${data.clients.length} configured</span></div><div class="metric"><span class="metric-label">Online / total runners</span><strong class="metric-value">${online} / ${data.runners.length}</strong><span class="metric-meta"><span class="status-dot ${online > 0 ? "online" : "offline"}"></span> ${online} connected</span></div><div class="metric"><span class="metric-label">Running jobs</span><strong class="metric-value">${activeJobs}</strong><span class="metric-meta">${activeJobs > 0 ? "In progress" : "Idle"}</span></div><div class="metric"><span class="metric-label">Recent jobs</span><strong class="metric-value">${data.jobs.length}</strong><span class="metric-meta">Recorded</span></div></section><div class="grid-two"><section class="panel"><div class="section-title"><h2>Recent runners</h2><a href="/admin/runners">View all</a></div>${runnerList(data.runners.slice(0, 5))}</section><section class="panel"><div class="section-title"><h2>Recent MCP clients</h2><a href="/admin/clients">View all</a></div>${clientList(data.clients.slice(0, 5))}</section></div><section class="panel"><div class="section-title"><h2>Recent jobs</h2><a href="/admin/runners">Runner activity</a></div>${jobTable(data.jobs.slice(0, 10))}</section><form class="hidden" method="post" action="/admin/logout"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"></form>`;
}
function runnersPage(data: AdminData, csrf: string): string {
  const table = data.runners.map((runner) => `<tr class="data-row"><td><div class="table-primary-cell"><a class="strong" href="/admin/runners/${encodeURIComponent(runner.runner_id)}">${escapeHtml(runner.display_name)}</a><span class="sub-id mono">${escapeHtml(runner.runner_id)}</span></div></td><td>${statusBadge(runner.state)}</td><td><span class="platform-tag">${escapeHtml(safePlatform(runner))}</span></td><td class="num-cell">${runnerWorkspaceCount(runner)}</td><td class="num-cell">${runnerActiveJobs(runner)}</td><td class="time-cell">${escapeHtml(time(runner.last_heartbeat_ms))}</td><td class="actions"><div class="action-btn-group"><a class="button small secondary" href="/admin/runners/${encodeURIComponent(runner.runner_id)}">View</a><form method="post" action="/admin/runners/${encodeURIComponent(runner.runner_id)}/rename" class="inline-action-form"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input name="display_name" value="${escapeHtml(runner.display_name)}" aria-label="Rename ${escapeHtml(runner.display_name)}" maxlength="256"><button class="small secondary">Rename</button></form><form method="post" action="/admin/runners/${encodeURIComponent(runner.runner_id)}/rotate" class="inline-action-form"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="small secondary">Rotate Credential</button></form><form method="post" action="/admin/runners/${encodeURIComponent(runner.runner_id)}/revoke" class="inline-action-form danger-action"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>Type Runner ID to confirm<input name="confirmation" pattern="[A-Za-z0-9][A-Za-z0-9._:-]*" required></label><button class="small danger">Revoke</button></form><form method="post" action="/admin/runners/${encodeURIComponent(runner.runner_id)}/delete" class="inline-action-form danger-action"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>Type Runner ID to confirm<input name="confirmation" pattern="[A-Za-z0-9][A-Za-z0-9._:-]*" required></label><button class="small danger">Delete</button></form><form method="post" action="/admin/runners/${encodeURIComponent(runner.runner_id)}/enrollment" class="inline-action-form"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="small secondary">Install / Reinstall</button></form></div></td></tr>`).join("") || `<tr><td colspan="7" class="empty"><div class="empty-state-box"><p>No runners yet.</p></div></td></tr>`;
  return `<section class="page-heading"><div><p class="eyebrow">Infrastructure</p><h1>Runners</h1><p class="lede">Manage safe runner metadata and one-time enrollment.</p></div></section><section class="panel add-panel" id="add-runner"><div class="section-title"><h2>Add Runner</h2><span class="muted font-12">Enrollment codes expire after 30 minutes.</span></div><form method="post" action="/admin/runners" class="form-grid add-form-grid"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>Display name<input name="display_name" maxlength="256" required autocomplete="off" placeholder="e.g. Production Runner 01"></label><label>Safe runner ID <span class="muted font-11">optional</span><input name="runner_id" maxlength="128" pattern="[A-Za-z0-9][A-Za-z0-9._:-]*" placeholder="generated-id"></label><div class="form-submit-wrap"><button class="button">Create enrollment</button></div></form></section><section class="panel"><div class="table-wrap"><table class="data-table"><caption class="sr-only">Registered runners</caption><thead><tr><th>Display name</th><th>Status</th><th>Platform / architecture</th><th>Workspaces</th><th>Active jobs</th><th>Last seen</th><th>Actions</th></tr></thead><tbody>${table}</tbody></table></div></section>`;
}
function activeRunnerLabel(client: McpClientRecord, runners: readonly RunnerRecord[]): string { const runner = client.active_runner_id === null ? undefined : runners.find((item) => item.runner_id === client.active_runner_id); return runner === undefined ? "Not selected" : runner.display_name; }
function clientsPage(data: AdminData, csrf: string): string {
  const rows = data.clients.map((client) => `<tr class="data-row"><td><div class="table-primary-cell"><a class="strong" href="/admin/clients/${encodeURIComponent(client.client_id)}">${escapeHtml(client.label)}</a><span class="sub-id mono">${escapeHtml(client.client_id)}</span></div></td><td><div class="scope-tags">${client.scopes.map((s) => `<span class="scope-pill">${escapeHtml(s)}</span>`).join("")}</div></td><td><span class="routing-badge">${escapeHtml(activeRunnerLabel(client, data.runners))}</span></td><td class="time-cell">${escapeHtml(time(client.last_used_at_ms))}</td><td>${client.revoked_at_ms === null ? statusBadge("online") : statusBadge("offline")}</td><td class="actions"><div class="action-btn-group"><form method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/rename" class="inline-action-form"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input name="label" value="${escapeHtml(client.label)}" aria-label="Rename ${escapeHtml(client.label)}" maxlength="256"><button class="small secondary">Rename</button></form>${client.revoked_at_ms === null ? `<form method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/rotate" class="inline-action-form"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="small secondary">Rotate</button></form>` : ""}<form method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/reset-runner" class="inline-action-form"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="small secondary">Reset Runner Selection</button></form>${client.revoked_at_ms === null ? `<form method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/revoke" class="inline-action-form danger-action"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="small danger">Revoke</button></form>` : ""}</div></td></tr>`).join("") || `<tr><td colspan="6" class="empty"><div class="empty-state-box"><p>No MCP clients yet.</p></div></td></tr>`;
  return `<section class="page-heading"><div><p class="eyebrow">Integrations</p><h1>MCP Clients</h1><p class="lede">Manage labels, scopes, runner routing, and one-time client secrets.</p></div></section><section class="panel add-panel" id="add-client"><div class="section-title"><h2>Add MCP Client</h2></div><form method="post" action="/admin/clients" class="form-grid add-client-grid"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>Label<input name="label" maxlength="256" required placeholder="e.g. Cursor / Claude Desktop"></label><fieldset><legend>Scopes</legend><div class="scope-selector-row">${scopeCheckboxes()}</div></fieldset><div class="form-submit-wrap"><button class="button">Create one-time secret</button></div></form></section><section class="panel"><div class="table-wrap"><table class="data-table"><caption class="sr-only">MCP clients</caption><thead><tr><th>Label</th><th>Scopes</th><th>Active runner</th><th>Last used</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}
function settingsPage(csrf: string): string { return `<section class="page-heading"><div><p class="eyebrow">Workspace administration</p><h1>Settings</h1><p class="lede">Keep operator notes here; credentials and secrets are never displayed.</p></div></section><div class="grid-two"><section class="panel"><div class="section-title"><h2>Change password</h2></div><form method="post" action="/admin/password" class="stack settings-form"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>Current password<input type="password" name="current_password" required autocomplete="current-password"></label><label>New password<input type="password" name="password" minlength="12" required autocomplete="new-password"></label><label>Confirm new password<input type="password" name="confirm_password" minlength="12" required autocomplete="new-password"></label><button class="button">Change password</button></form></section><section class="panel danger-panel"><div class="section-title"><h2 class="danger-title">Operator notes</h2></div><p class="muted settings-note">Deployment notes belong in your deployment system. This dashboard intentionally stores no notes or secrets.</p><div class="logout-box"><form method="post" action="/admin/logout" class="stack"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="button secondary">Log out</button></form></div></section></div>`; }
function runnerList(runners: readonly RunnerRecord[]): string { return runners.length === 0 ? `<p class="empty">No runners yet.</p>` : `<ul class="item-list">${runners.map((runner) => `<li><a href="/admin/runners/${encodeURIComponent(runner.runner_id)}" class="card-row"><div class="card-row-main"><span class="strong">${escapeHtml(runner.display_name)}</span><span class="card-row-sub">${statusBadge(runner.state)}<span class="meta-separator">·</span><span class="platform-meta">${escapeHtml(safePlatform(runner))}</span></span></div><div class="card-row-aside"><span class="row-arrow">→</span></div></a></li>`).join("")}</ul>`; }
function clientList(clients: readonly McpClientRecord[]): string { return clients.length === 0 ? `<p class="empty">No MCP clients yet.</p>` : `<ul class="item-list">${clients.map((client) => `<li><a href="/admin/clients/${encodeURIComponent(client.client_id)}" class="card-row"><div class="card-row-main"><span class="strong">${escapeHtml(client.label)}</span><span class="card-row-sub"><span class="client-runner-meta">${client.active_runner_id === null ? "Not selected" : escapeHtml(client.active_runner_id)}</span><span class="meta-separator">·</span>${client.revoked_at_ms === null ? statusBadge("online") : statusBadge("offline")}</span></div><div class="card-row-aside"><span class="row-arrow">→</span></div></a><form class="hidden" method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/rename"><input name="label" value="${escapeHtml(client.label)}"></form></li>`).join("")}</ul>`; }
function jobTable(jobs: readonly Record<string, unknown>[]): string { return jobs.length === 0 ? `<p class="empty">No recent jobs.</p>` : `<div class="table-wrap"><table class="data-table"><thead><tr><th>Job</th><th>Workspace</th><th>Status</th><th>Updated</th></tr></thead><tbody>${jobs.map((job) => { const status = String(job.status ?? "unknown"); const safeStatus = statusClass(status); return `<tr class="data-row"><td class="mono job-id-cell">${escapeHtml(String(job.job_id ?? "unknown"))}</td><td><span class="workspace-pill">${escapeHtml(String(job.workspace_id ?? "unknown"))}</span></td><td><span class="badge job-status ${safeStatus}"><span class="status-dot ${safeStatus}"></span> ${escapeHtml(status)}</span></td><td class="time-cell">${escapeHtml(time(typeof job.updated_at_ms === "number" ? job.updated_at_ms : null))}</td></tr>`; }).join("")}</tbody></table></div>`; }
function statusBadge(state: string): string { const safe = ["online", "offline", "stale", "pending", "invalid"].includes(state) ? state : "offline"; return `<span class="badge ${safe}"><span class="status-dot ${safe}"></span>${safe}</span>`; }
function statusClass(status: string): string { return ["queued", "running", "cancelling", "cancelled", "succeeded", "completed", "failed", "unknown", "interrupted", "pending", "invalid", "offline", "online"].includes(status) ? status : "unknown"; }
function safePlatform(runner: RunnerRecord): string { return runner.public_info === null ? "Not enrolled" : `${runner.public_info.platform} / ${runner.public_info.architecture}`; }
function runnerWorkspaceCount(runner: RunnerRecord): string { const value = (runner as RunnerRecord & { workspace_count?: unknown }).workspace_count; return typeof value === "number" ? String(value) : "—"; }
function runnerActiveJobs(runner: RunnerRecord): string { const value = (runner as RunnerRecord & { active_job_count?: unknown }).active_job_count; return typeof value === "number" ? String(value) : "—"; }
function scopeCheckboxes(selected: readonly string[] = ["coding:read", "coding:write", "coding:exec"]): string {
  const descriptions: Record<CodingScope, string> = {
    "coding:read": "Inspect workspaces and read files.",
    "coding:write": "Apply approved edits.",
    "coding:exec": "Use Host shell and control Jobs.",
  };
  return (["coding:read", "coding:write", "coding:exec"] as const).map((scope) => `<label class="check"><input type="checkbox" name="scopes" value="${scope}"${selected.includes(scope) ? " checked" : ""}> <span><strong>${scope}</strong><small>${descriptions[scope]}</small></span></label>`).join("");
}
function runnerDetailPage(runner: Record<string, unknown>, workspaces: readonly unknown[], jobs: readonly unknown[], environment: Record<string, unknown> | undefined, csrf: string, release: RunnerReleaseDescriptor & { readonly distributable: boolean }): string {
  const runnerId = typeof runner.runner_id === "string" ? runner.runner_id : "unknown";
  const displayName = typeof runner.display_name === "string" ? runner.display_name : runnerId;
  const state = typeof runner.state === "string" ? runner.state : "offline";
  const publicInfo = record(runner.public_info);
  const tools = record(environment?.tools);
  const toolRows = tools === undefined ? `<p class="muted empty-desc">Environment details unavailable while offline.</p>` : `<div class="tool-grid">${Object.entries(tools).map(([name, value]) => { const item = record(value); const isAvail = item?.available === true; return `<div class="tool-item"><div class="tool-name-row"><strong class="tool-name">${escapeHtml(name)}</strong>${isAvail ? `<span class="badge online"><span class="status-dot online"></span>Available</span>` : `<span class="badge offline"><span class="status-dot offline"></span>Unavailable</span>`}</div>${isAvail && typeof item?.version === "string" ? `<span class="tool-version mono">${escapeHtml(item.version)}</span>` : ""}</div>`; }).join("")}</div>`;
  const policyStatus = runner.policy_status === "applied" || runner.policy_status === "invalid" ? runner.policy_status : "pending";
  const workspaceRows = workspaces.map((workspace) => managedWorkspaceForm(runnerId, record(workspace), csrf)).join("") || `<li class="muted empty-item">No managed workspaces configured.</li>`;
  const updateChannel = runner.update_channel === "pinned" ? "pinned" : "stable";
  const currentVersion = typeof runner.current_runner_version === "string" ? runner.current_runner_version : typeof publicInfo?.runner_version === "string" ? publicInfo.runner_version : "Unknown";
  const latestVersion = typeof runner.latest_runner_version === "string" ? runner.latest_runner_version : release.distributable ? release.latest_version : "Not configured";
  const distributionNotice = release.distributable ? "" : `<p class="muted font-12">Hosted distribution is not configured. Portable artifact/manual version management only.</p>`;
  const desiredVersion = typeof runner.desired_runner_version === "string" ? runner.desired_runner_version : "";
  const protocolCompatibility = runner.protocol_compatibility === "compatible" || runner.protocol_compatibility === "incompatible" ? runner.protocol_compatibility : "unknown";
  const protocolRange = `${String(runner.protocol_min_version ?? "Unknown")}–${String(runner.protocol_max_version ?? "Unknown")}`;
  const permissions = record(runner.runner_permissions);
  const desiredRevision = typeof runner.desired_policy_revision === "number" ? String(runner.desired_policy_revision) : "0";
  const appliedRevision = typeof runner.applied_policy_revision === "number" ? String(runner.applied_policy_revision) : "—";
  return `<section class="detail-header">
    <div class="detail-title-group">
      <div class="detail-title-row">
        <p class="eyebrow">Runner details</p>
        <h1 class="detail-title">${escapeHtml(displayName)}</h1>
        ${statusBadge(state)}
      </div>
      <p class="detail-id mono">${escapeHtml(runnerId)}</p>
      <p class="lede">Control-plane workspace roots appear only in this authenticated administrator view.</p>
    </div>
    <div class="detail-header-actions">
      <a class="button secondary" href="/admin/runners">Back to runners</a>
    </div>
  </section>
  <div class="metrics" aria-label="Runner summary">
    <div class="metric">
      <span class="metric-label">Status</span>
      <strong class="metric-value">${statusBadge(state)}</strong>
      <span class="metric-meta">${state === "online" ? "Socket connected" : "Disconnected"}</span>
    </div>
    <div class="metric">
      <span class="metric-label">Runner ID</span>
      <strong class="metric-value mono mono-truncate" title="${escapeHtml(runnerId)}">${escapeHtml(runnerId)}</strong>
      <span class="metric-meta">Unique runtime</span>
    </div>
    <div class="metric">
      <span class="metric-label">Policy status</span>
      <strong class="metric-value">${escapeHtml(policyStatus)} · ${escapeHtml(appliedRevision === "—" && policyStatus === "applied" ? desiredRevision : appliedRevision)} / ${escapeHtml(desiredRevision)}</strong>
      <span class="metric-meta">Revision applied / desired</span>
    </div>
    <div class="metric">
      <span class="metric-label">Last seen</span>
      <strong class="metric-value font-16">${escapeHtml(time(typeof runner.last_heartbeat_ms === "number" ? runner.last_heartbeat_ms : null))}</strong>
      <span class="metric-meta">Heartbeat</span>
    </div>
  </div>
  <div class="grid-two">
    <section class="panel">
      <div class="section-title">
        <h2>Safe metadata</h2>
      </div>
      <dl class="details">
        <dt>Platform</dt>
        <dd>${escapeHtml(typeof publicInfo?.platform === "string" ? publicInfo.platform : "Unknown")}</dd>
        <dt>Architecture</dt>
        <dd>${escapeHtml(typeof publicInfo?.architecture === "string" ? publicInfo.architecture : "Unknown")}</dd>
        <dt>Hostname</dt>
        <dd class="mono">${escapeHtml(typeof publicInfo?.hostname === "string" ? publicInfo.hostname : "Unknown")}</dd>
        <dt>Runner version</dt>
        <dd class="mono">${escapeHtml(currentVersion)}</dd>
        <dt>Stable/latest version</dt>
        <dd class="mono">${escapeHtml(latestVersion)}</dd>
        <dt>Protocol compatibility</dt>
        <dd>${escapeHtml(protocolRange)} · ${escapeHtml(protocolCompatibility)}</dd>
      </dl>
    </section>
    <section class="panel">
      <div class="section-title">
        <h2>Version policy</h2>
      </div>
      <p class="muted font-12">Policy is recorded for operators; package download, update, and rollback remain deferred.</p>
      ${distributionNotice}
      <form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/version-policy" class="form-grid version-policy-form">
        <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
        <label>Channel
          <select name="update_channel">
            <option value="stable"${updateChannel === "stable" ? " selected" : ""}>Stable</option>
            <option value="pinned"${updateChannel === "pinned" ? " selected" : ""}>Pinned</option>
          </select>
        </label>
        <label>Desired version
          <input name="desired_runner_version" value="${escapeHtml(desiredVersion)}" placeholder="1.2.3" pattern="[0-9]+\\.[0-9]+\\.[0-9]+">
        </label>
        <div class="version-stat">
          <span class="form-stat-label">Current</span>
          <strong class="mono">${escapeHtml(currentVersion)}</strong>
        </div>
        <div class="version-stat">
          <span class="form-stat-label">Latest</span>
          <strong class="mono">${escapeHtml(latestVersion)}</strong>
        </div>
        <div class="form-submit-wrap full-width-submit">
          <button class="button">Save version policy</button>
        </div>
      </form>
      <p class="muted policy-status-foot font-12">Status: <span class="mono">${escapeHtml(String(runner.update_status ?? "unknown"))}</span></p>
    </section>
    <section class="panel">
      <div class="section-title">
        <h2>Environment tools</h2>
      </div>
      ${toolRows}
    </section>
    <section class="panel">
      <div class="section-title">
        <h2>Active jobs</h2>
      </div>
      ${jobTable(jobs.filter(record) as Record<string, unknown>[])}
    </section>
  </div>
  <div class="grid-two">
    <section class="panel">
      <div class="section-title">
        <h2>Runner permission profile</h2>
      </div>
      <p class="muted font-12">Changes remain pending until the connected Runner validates and applies the revision.</p>
      ${permissionForm(runnerId, permissions, csrf)}
      <div class="danger-zone">
        <div class="danger-header">
          <h3>Emergency control</h3>
        </div>
        <p class="muted font-12">Emergency Lock does not automatically stop existing Jobs.</p>
        <form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/emergency-lock" class="stack emergency-lock-form">
          <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
          <label>Type the Runner ID to confirm emergency lock
            <input name="confirmation" pattern="[A-Za-z0-9][A-Za-z0-9._:-]*" required placeholder="${escapeHtml(runnerId)}">
          </label>
          <button class="button danger">Emergency lock all permissions</button>
        </form>
      </div>
    </section>
    <section class="panel">
      <div class="section-title">
        <h2>Managed workspaces</h2>
        <span class="muted font-12">Each save increments the desired policy revision.</span>
      </div>
      <ul class="plain-list workspace-list">
        ${workspaceRows}
      </ul>
      <div class="add-workspace-box">
        <div class="box-title-row">
          <h3>Add workspace</h3>
        </div>
        ${managedWorkspaceForm(runnerId, undefined, csrf)}
      </div>
    </section>
  </div>`;
}
function permissionForm(runnerId: string, permissions: Record<string, unknown> | undefined, csrf: string): string {
  const current = (name: string): boolean => permissions?.[name] === true;
  return `<form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/permissions" class="form-grid permission-profile-grid">
    <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
    <div class="perm-selects-row">
      ${permissionSelect("read", current("read"))}
      ${permissionSelect("edit", current("edit"))}
      ${permissionSelect("shell", current("shell"))}
      ${permissionSelect("job_control", current("job_control"))}
    </div>
    <div class="form-submit-wrap full-width-submit">
      <button class="button">Save profile</button>
    </div>
  </form>`;
}
function permissionSelect(name: string, selected: boolean): string { return `<label class="perm-select-label"><span>${escapeHtml(name.replaceAll("_", " "))}</span><select name="${escapeHtml(name)}"><option value="true"${selected ? " selected" : ""}>Allow</option><option value="false"${selected ? "" : " selected"}>Deny</option></select></label>`; }
function managedWorkspaceForm(runnerId: string, workspace: Record<string, unknown> | undefined, csrf: string): string {
  const existing = typeof workspace?.workspace_id === "string";
  const workspaceId = existing ? workspace?.workspace_id as string : "";
  const displayName = typeof workspace?.display_name === "string" ? workspace.display_name : "";
  const rootPath = typeof workspace?.root_path === "string" ? workspace.root_path : "";
  const permissions = record(workspace?.permissions);
  const current = (name: string): boolean => permissions?.[name] === true;
  const profile = workspaceProfile(permissions);
  const fullHostConfirmed = isFullHostPath(rootPath);
  const enabled = workspace?.enabled !== false;
  const status = typeof workspace?.validation_status === "string" ? workspace.validation_status : "pending";
  return `<li class="workspace-card">
    <form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/${existing ? "workspace-update" : "workspace-create"}" class="workspace-form">
      <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
      <div class="form-grid workspace-main-grid">
        <label>Workspace ID
          <input name="workspace_id" value="${escapeHtml(workspaceId)}" ${existing ? "readonly" : "required"} maxlength="128" placeholder="e.g. project-src">
        </label>
        <label>Display name
          <input name="display_name" value="${escapeHtml(displayName)}" required maxlength="256" placeholder="e.g. Main Repository">
        </label>
        <label class="grid-span-2">Absolute root path
          <input name="root_path" value="${escapeHtml(rootPath)}" required maxlength="4096" placeholder="/absolute/path/to/directory">
        </label>
        <label>Usage profile
          <select name="profile">
            <option value="custom"${profile === "custom" ? " selected" : ""}>Custom</option>
            <option value="read_only"${profile === "read_only" ? " selected" : ""}>Read Only</option>
            <option value="coding"${profile === "coding" ? " selected" : ""}>Coding</option>
          </select>
        </label>
        <label>Enabled
          <select name="enabled">
            <option value="true"${enabled ? " selected" : ""}>Enabled</option>
            <option value="false"${enabled ? "" : " selected"}>Disabled</option>
          </select>
        </label>
        <label class="full-host-label">Full-host confirmation
          <input type="hidden" name="confirm_full_host" value="false">
          <span class="check-line">
            <input type="checkbox" name="confirm_full_host" value="true"${fullHostConfirmed ? " checked" : ""}>
            <span>I understand this exposes the full host filesystem.</span>
          </span>
        </label>
      </div>
      <div class="workspace-perms-section">
        <span class="form-stat-label">Workspace Permissions</span>
        <div class="perm-selects-row">
          ${permissionSelect("read", current("read"))}
          ${permissionSelect("edit", current("edit"))}
          ${permissionSelect("shell", current("shell"))}
          ${permissionSelect("job_control", current("job_control"))}
        </div>
      </div>
      <div class="workspace-btn-bar">
        <button class="button">${existing ? "Save workspace" : "Create workspace"}</button>
      </div>
    </form>
    ${existing ? `<div class="workspace-footer">
      <span class="validation-tag status-pill ${statusClass(status)}">Validation: ${escapeHtml(status)}</span>
      <form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/workspace-delete" class="inline-delete-form">
        <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
        <input type="hidden" name="workspace_id" value="${escapeHtml(workspaceId)}">
        <label>Type Workspace ID to confirm
          <input name="confirmation" pattern="[A-Za-z0-9][A-Za-z0-9._:-]*" required placeholder="${escapeHtml(workspaceId)}">
        </label>
        <button class="small danger">Delete workspace</button>
      </form>
    </div>` : ""}
  </li>`;
}
function workspaceProfile(permissions: Record<string, unknown> | undefined): "custom" | "read_only" | "coding" {
  if (permissions?.read === true && permissions.edit !== true && permissions.shell !== true && permissions.job_control !== true) return "read_only";
  if (permissions?.read === true && permissions.edit === true && permissions.shell === true && permissions.job_control === true) return "coding";
  return "custom";
}
function adminStyles(): string { return `<style>
:root{
  color-scheme:light dark;
  --canvas:#f1f3f5;
  --canvas-subtle:#e9ecef;
  --panel:#ffffff;
  --panel-card:#f8f9fa;
  --panel-elevated:#ffffff;
  --panel-subtle:#f1f3f5;
  --surface-hover:#e9ecef;
  --header-bg:rgba(255,255,255,0.88);
  --header-hover:rgba(255,255,255,0.7);
  --grid-line:rgba(0,0,0,0.02);
  --focus-ring:rgba(33,37,41,0.15);
  --line:#dee2e6;
  --line-light:#e9ecef;
  --line-subtle:#ced4da;
  --ink:#212529;
  --ink-heading:#111827;
  --muted:#6c757d;
  --muted-dark:#495057;
  --brand:#212529;
  --brand-hover:#343a40;
  --brand-dim:#495057;
  --brand-ink:#ffffff;
  --accent-gray:#e9ecef;
  --accent-gray-hover:#dee2e6;
  --danger:#dc2626;
  --danger-hover:#b91c1c;
  --danger-ink:#991b1b;
  --danger-bg:#fef2f2;
  --danger-panel:#fffafa;
  --danger-line:#fecaca;
  --warn:#b45309;
  --warn-bg:#fffbeb;
  --warn-line:#fde68a;
  --ok:#15803d;
  --ok-bg:#f0fdf4;
  --ok-line:#bbf7d0;
  --shadow-sm:0 1px 2px rgba(0,0,0,0.05);
  --shadow-md:0 4px 6px -1px rgba(0,0,0,0.07),0 2px 4px -2px rgba(0,0,0,0.05);
  --shadow-lg:0 10px 15px -3px rgba(0,0,0,0.08),0 4px 6px -4px rgba(0,0,0,0.04);
  --glow-subtle:0 0 0 1px rgba(0,0,0,0.05);
  --radius-sm:6px;
  --radius-md:8px;
  --radius-lg:12px;
  --radius-xl:14px;
  --font-sans:"IBM Plex Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --font-mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;

  /* Auth / Login Page Layout (Full-Screen Dark Mesh Control Plane Entry) */
  --auth-bg:#090a0f;
  --auth-pane-bg:#12141a;
  --auth-border:rgba(255,255,255,0.08);
  --auth-text:#f3f4f6;
  --auth-muted:#9ca3af;
  --auth-input-bg:rgba(255,255,255,0.04);
  --auth-input-border:rgba(255,255,255,0.12);
  --auth-input-focus:rgba(255,255,255,0.25);
  --auth-btn-bg:#f3f4f6;
  --auth-btn-ink:#090a0f;
  --auth-btn-hover:#ffffff;
}
:root[data-theme="light"]{color-scheme:light}
:root[data-theme="dark"]{
  color-scheme:dark;
  --canvas:#0b1220;
  --canvas-subtle:#0d1728;
  --panel:#111a2b;
  --panel-card:#0d1728;
  --panel-elevated:#17233a;
  --panel-subtle:#17233a;
  --surface-hover:#1b2a43;
  --header-bg:rgba(11,18,32,0.9);
  --header-hover:rgba(30,41,59,0.9);
  --grid-line:rgba(226,237,249,0.045);
  --focus-ring:rgba(147,197,253,0.4);
  --line:#2b3b55;
  --line-light:#24344d;
  --line-subtle:#49617f;
  --ink:#e6edf7;
  --ink-heading:#f8fafc;
  --muted:#a9b7ca;
  --muted-dark:#c5d1e2;
  --brand:#60a5fa;
  --brand-hover:#93c5fd;
  --brand-dim:#bfdbfe;
  --brand-ink:#07111f;
  --accent-gray:#1a2a42;
  --accent-gray-hover:#243b5c;
  --danger:#fb7185;
  --danger-hover:#fda4af;
  --danger-ink:#fecdd3;
  --danger-bg:#3e1821;
  --danger-panel:#28151c;
  --danger-line:#7f2637;
  --warn:#fbbf24;
  --warn-bg:#3b2d0d;
  --warn-line:#805e16;
  --ok:#4ade80;
  --ok-bg:#123322;
  --ok-line:#23693d;
  --shadow-sm:0 1px 2px rgba(0,0,0,0.35);
  --shadow-md:0 8px 20px rgba(0,0,0,0.28);
  --shadow-lg:0 18px 36px rgba(0,0,0,0.35);
  --glow-subtle:0 0 0 1px rgba(226,237,249,0.06);
}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){
  color-scheme:dark;
  --canvas:#0b1220;--canvas-subtle:#0d1728;--panel:#111a2b;--panel-card:#0d1728;--panel-elevated:#17233a;--panel-subtle:#17233a;--surface-hover:#1b2a43;--header-bg:rgba(11,18,32,0.9);--header-hover:rgba(30,41,59,0.9);--grid-line:rgba(226,237,249,0.045);--focus-ring:rgba(147,197,253,0.4);--line:#2b3b55;--line-light:#24344d;--line-subtle:#49617f;--ink:#e6edf7;--ink-heading:#f8fafc;--muted:#a9b7ca;--muted-dark:#c5d1e2;--brand:#60a5fa;--brand-hover:#93c5fd;--brand-dim:#bfdbfe;--brand-ink:#07111f;--accent-gray:#1a2a42;--accent-gray-hover:#243b5c;--danger:#fb7185;--danger-hover:#fda4af;--danger-ink:#fecdd3;--danger-bg:#3e1821;--danger-panel:#28151c;--danger-line:#7f2637;--warn:#fbbf24;--warn-bg:#3b2d0d;--warn-line:#805e16;--ok:#4ade80;--ok-bg:#123322;--ok-line:#23693d;--shadow-sm:0 1px 2px rgba(0,0,0,0.35);--shadow-md:0 8px 20px rgba(0,0,0,0.28);--shadow-lg:0 18px 36px rgba(0,0,0,0.35);--glow-subtle:0 0 0 1px rgba(226,237,249,0.06);
}}
*{box-sizing:border-box}
html,body{min-height:100%}
body{
  margin:0;
  background-color:var(--canvas);
  background-image:
    radial-gradient(1000px 500px at 50% -5%, var(--surface-hover) 0%, transparent 60%),
    linear-gradient(180deg, var(--panel-card) 0%, var(--canvas) 100%);
  background-attachment:fixed;
  color:var(--ink);
  font:14px/1.55 var(--font-sans);
  letter-spacing:-0.006em;
  -webkit-font-smoothing:antialiased;
  -moz-osx-font-smoothing:grayscale;
}
body::before{
  content:"";
  position:fixed;
  inset:0;
  pointer-events:none;
  background-image:
    linear-gradient(var(--grid-line) 1px, transparent 1px),
    linear-gradient(90deg, var(--grid-line) 1px, transparent 1px);
  background-size:32px 32px;
  mask-image:linear-gradient(180deg, #000 0%, rgba(0,0,0,0.4) 40%, transparent 80%);
  z-index:0;
}
.ops-body{position:relative;min-height:100vh}
.shell{
  max-width:1440px;
  margin:auto;
  padding:24px 32px 64px;
  position:relative;
  z-index:1;
}
.workspace{padding-top:4px}

/* Header & Control Navigation */
.app-header{
  position:sticky;
  top:0;
  z-index:100;
  background:var(--header-bg);
  backdrop-filter:blur(12px);
  -webkit-backdrop-filter:blur(12px);
  border-bottom:1px solid var(--line);
  box-shadow:var(--shadow-sm);
}
.header-inner{
  max-width:1440px;
  margin:auto;
  padding:0 32px;
  height:56px;
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:24px;
}
.header-left{
  display:flex;
  align-items:center;
  gap:28px;
  min-width:0;
}
.brand{
  color:var(--ink-heading);
  font-size:15px;
  font-weight:700;
  letter-spacing:0.01em;
  text-decoration:none;
  display:inline-flex;
  align-items:center;
  gap:10px;
  flex-shrink:0;
}
.brand-copy{display:none}
.brand-copy span{font-size:15px;font-weight:750;letter-spacing:-0.01em;color:var(--ink-heading)}
.brand-copy small{
  margin:2px 0 0;
  font-size:10px;
  font-weight:600;
  letter-spacing:0.08em;
  text-transform:uppercase;
  color:var(--muted);
}
.header-mesh-mark{
  display:block;
  width:170px;
  height:50px;
  object-fit:cover;
  object-position:center 50%;
  padding:2px 6px;
  border-radius:6px;
  background:#fff;
  box-shadow:var(--shadow-sm);
  flex-shrink:0;
}
.control-nav{
  display:flex;
  gap:4px;
  margin:0;
  padding:3px;
  background:var(--panel-subtle);
  border:1px solid var(--line-light);
  border-radius:var(--radius-md);
  width:fit-content;
}
.control-nav a{
  padding:5px 12px;
  color:var(--muted-dark);
  text-decoration:none;
  border-radius:var(--radius-sm);
  font-weight:600;
  font-size:12.5px;
  letter-spacing:0.01em;
  transition:all 0.12s ease;
  white-space:nowrap;
}
.control-nav a:hover{color:var(--ink-heading);background:var(--header-hover)}
.control-nav a.active{
  color:var(--brand-ink);
  background:var(--brand);
  box-shadow:var(--shadow-sm);
}
.header-actions{
  display:flex;
  align-items:center;
  gap:10px;
  flex-shrink:0;
}

/* Language Switcher */
.language-switch{
  display:inline-flex;
  align-items:center;
  gap:2px;
  padding:2px;
  border:1px solid var(--line);
  border-radius:999px;
  background:var(--panel-elevated);
  box-shadow:var(--shadow-sm);
}
.language-switch a{
  min-width:32px;
  padding:3px 8px;
  border-radius:999px;
  color:var(--muted);
  font-size:11px;
  font-weight:650;
  letter-spacing:0.02em;
  text-align:center;
  text-decoration:none;
  transition:all 0.12s ease;
}
.language-switch a:hover{color:var(--ink-heading);background:var(--accent-gray)}
.language-switch a[aria-current=true]{
  color:var(--brand-ink);
  background:var(--brand);
}
.auth-body>.language-switch{
  position:fixed;
  top:20px;
  right:20px;
  z-index:20;
  background:rgba(18,20,26,0.8);
  border-color:rgba(255,255,255,0.12);
  backdrop-filter:blur(8px);
}
.auth-body>.language-switch a{color:var(--auth-muted)}
.auth-body>.language-switch a:hover{color:#fff;background:rgba(255,255,255,0.08)}
.auth-body>.language-switch a[aria-current=true]{color:#000;background:#fff}

/* Typography & Headings */
h1,h2,h3{
  line-height:1.2;
  margin:0 0 8px;
  color:var(--ink-heading);
  letter-spacing:-0.02em;
}
h1{font-size:22px;font-weight:700}
h2{font-size:15px;font-weight:680;letter-spacing:-0.01em}
h3{font-size:12.5px;color:var(--muted-dark);text-transform:uppercase;letter-spacing:0.06em;font-weight:680}
.page-heading{
  display:flex;
  justify-content:space-between;
  align-items:flex-start;
  gap:24px;
  margin-bottom:20px;
}
.eyebrow,.brand-kicker{
  color:var(--muted);
  font-size:11px;
  font-weight:680;
  letter-spacing:0.08em;
  text-transform:uppercase;
  margin:0 0 4px;
}
.lede,.muted,.subtitle{color:var(--muted)}
.lede,.subtitle{margin:0 0 10px;max-width:64ch;font-size:13.5px;line-height:1.5}
.font-11{font-size:11px!important}
.font-12{font-size:12px!important}
.font-16{font-size:16px!important}

/* Detail Header */
.detail-header{
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:20px;
  margin-bottom:20px;
  padding:16px 20px;
  background:var(--panel);
  border:1px solid var(--line);
  border-radius:var(--radius-lg);
  box-shadow:var(--shadow-sm);
}
.detail-title-group{
  display:flex;
  flex-direction:column;
  gap:3px;
}
.detail-title-row{
  display:flex;
  align-items:center;
  gap:10px;
  flex-wrap:wrap;
}
.detail-title{
  font-size:20px;
  font-weight:700;
  margin:0;
  color:var(--ink-heading);
}
.detail-id{
  font-size:12.5px;
  color:var(--muted);
  margin:0;
}
.detail-header-actions{
  display:flex;
  align-items:center;
  gap:10px;
}

/* Metrics Dashboard Grid */
.metrics{
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:12px;
  margin-bottom:20px;
}
.metric,.panel,.auth-card,.enrollment-dialog{
  background:var(--panel);
  border:1px solid var(--line);
  border-radius:var(--radius-lg);
  box-shadow:var(--shadow-sm);
  position:relative;
}
.metric{
  padding:14px 16px 13px;
  overflow:hidden;
  background:var(--panel);
  border-color:var(--line);
  transition:border-color 0.15s ease,box-shadow 0.15s ease;
  display:flex;
  flex-direction:column;
  justify-content:space-between;
}
.metric:hover{
  border-color:var(--line-subtle);
  box-shadow:var(--shadow-md);
}
.metric-label,.metric span:first-child{
  display:block;
  color:var(--muted);
  font-size:11px;
  font-weight:650;
  letter-spacing:0.04em;
  text-transform:uppercase;
  margin-bottom:6px;
}
.metric-value,.metric strong{
  font-size:22px;
  font-weight:700;
  letter-spacing:-0.02em;
  color:var(--ink-heading);
  display:block;
}
.metric-meta{
  display:inline-flex;
  align-items:center;
  gap:5px;
  margin-top:6px;
  font-size:11.5px;
  color:var(--muted);
}
.mono-truncate{
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
  font-size:17px!important;
}

/* Panels & Layout Grids */
.grid-two{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-bottom:20px}
.panel{
  padding:18px 20px;
  margin-bottom:20px;
  background:var(--panel);
}
.danger-panel{
  border-color:var(--danger-line);
  background:var(--danger-panel);
}
.section-title{
  display:flex;
  justify-content:space-between;
  gap:14px;
  align-items:center;
  margin-bottom:14px;
  padding-bottom:4px;
}
.section-title h2{margin:0}
.section-title a{
  color:var(--muted-dark);
  font-weight:600;
  font-size:12.5px;
  text-decoration:none;
  transition:color 0.12s ease;
}
.section-title a:hover{color:var(--ink-heading);text-decoration:underline}

/* Add Panels */
.add-panel{
  background:var(--panel-card);
  border:1px solid var(--line);
}
.form-grid.add-form-grid,.form-grid.add-client-grid{
  display:flex;
  align-items:flex-end;
  gap:12px;
  flex-wrap:wrap;
}
.form-grid.add-form-grid > label,.form-grid.add-client-grid > label:not(.check){flex:1 1 200px}
.add-client-grid fieldset{flex:2 1 300px}
.form-submit-wrap{
  display:flex;
  align-items:flex-end;
  margin-bottom:1px;
}
.full-width-submit{
  width:100%;
  margin-top:8px;
}
.form-grid .full-width-submit{grid-column:1 / -1}
.full-width-submit button{width:100%}

/* Tables & Data Rows */
.table-wrap{
  overflow-x:auto;
  border:1px solid var(--line);
  border-radius:var(--radius-md);
  background:var(--panel);
}
.table-wrap::after{
  content:"Scroll horizontally to see more";
  display:none;
  padding:6px 10px;
  color:var(--muted);
  font-size:11px;
  border-top:1px solid var(--line-light);
  background:var(--panel-card);
}
html[lang="zh-CN"] .table-wrap::after{content:"左右滑动查看更多"}
table,.data-table{border-collapse:collapse;width:100%;min-width:760px;font-size:13px}
th,td{text-align:left;padding:10px 14px;border-bottom:1px solid var(--line-light);vertical-align:middle}
th{
  color:var(--muted-dark);
  font-size:11px;
  font-weight:680;
  text-transform:uppercase;
  letter-spacing:0.05em;
  background:var(--panel-card);
  border-bottom:1px solid var(--line);
}
tbody tr{transition:background-color 0.12s ease}
tbody tr:hover{background:var(--surface-hover)}
tr:last-child td{border-bottom:0}
.table-primary-cell{
  display:flex;
  flex-direction:column;
  gap:2px;
}
.strong{font-weight:680;color:var(--ink-heading);text-decoration:none}
a.strong:hover{color:var(--brand);text-decoration:underline}
.sub-id,small{display:block;color:var(--muted);font-size:11.5px;font-family:var(--font-mono)}
.num-cell{font-variant-numeric:tabular-nums;font-weight:600}
.time-cell{font-family:var(--font-mono);font-size:11.5px;color:var(--muted)}
.platform-tag{
  display:inline-block;
  padding:2px 7px;
  background:var(--panel-card);
  border:1px solid var(--line);
  border-radius:var(--radius-sm);
  font-size:11px;
  font-family:var(--font-mono);
  color:var(--muted-dark);
}
.routing-badge{
  display:inline-block;
  padding:2px 8px;
  background:var(--accent-gray);
  border:1px solid var(--line-subtle);
  border-radius:var(--radius-sm);
  font-size:11.5px;
  font-weight:600;
  color:var(--ink-heading);
}

/* Action Groups & Forms */
.action-btn-group{
  display:inline-flex;
  align-items:center;
  gap:6px;
  flex-wrap:wrap;
}
.inline-action-form{
  display:inline-flex;
  align-items:center;
  gap:6px;
  margin:0;
}
.inline-action-form input{
  padding:3px 8px;
  font-size:12px;
  height:26px;
  max-width:140px;
}
.danger-action label{
  font-size:11px;
  color:var(--muted-dark);
  font-weight:500;
  display:inline-flex;
  flex-direction:row;
  align-items:center;
  gap:4px;
}
.danger-action input{
  max-width:110px;
  border-color:var(--danger-line);
}

/* Client Detail Overrides & Scopes */
.mode-pill{
  display:inline-block;
  padding:2px 7px;
  border-radius:999px;
  font-size:11px;
  font-weight:650;
}
.mode-pill.global{background:var(--panel-card);border:1px solid var(--line);color:var(--muted-dark)}
.mode-pill.custom{background:var(--warn-bg);border:1px solid var(--warn-line);color:var(--warn)}
.override-form-row{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:12px;
  width:100%;
}
.perm-selects-wrap{
  display:flex;
  align-items:center;
  gap:8px;
  flex-wrap:wrap;
}
.perm-select-label{
  display:inline-flex;
  flex-direction:row;
  align-items:center;
  gap:5px;
  font-size:11.5px;
  font-weight:600;
  color:var(--muted-dark);
}
.perm-select-label select{
  padding:2px 6px;
  font-size:11.5px;
  height:24px;
  border-radius:var(--radius-sm);
}
.override-actions{
  display:flex;
  align-items:center;
  gap:6px;
  flex-shrink:0;
}
.active-scopes-box{
  padding:10px 12px;
  background:var(--panel-card);
  border:1px solid var(--line);
  border-radius:var(--radius-md);
  margin-bottom:14px;
}
.active-scopes-box .scope-line{margin:4px 0 0}
.scope-help{font-size:12.5px;line-height:1.6;margin:0 0 14px;max-width:72ch}
.scope-tags{
  display:flex;
  gap:4px;
  flex-wrap:wrap;
}
.scope-pill{
  display:inline-block;
  padding:1px 6px;
  background:var(--panel-subtle);
  border:1px solid var(--line-light);
  border-radius:var(--radius-sm);
  font-size:11px;
  font-family:var(--font-mono);
  color:var(--ink);
}
.scope-selector-row{
  display:flex;
  gap:12px;
  align-items:center;
  flex-wrap:wrap;
}
.scope-editor-form{
  display:grid;
  grid-template-columns:minmax(0,1fr) auto;
  align-items:end;
  gap:12px;
}
.scope-fieldset{
  flex:1;
  min-width:0;
  background:var(--panel-card);
}

/* Card Lists */
.card-row{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:12px;
  text-decoration:none;
  padding:8px 10px;
  border-radius:var(--radius-md);
  margin:0 -10px;
  transition:background-color 0.12s ease;
}
.card-row:hover{background:var(--accent-gray)}
.card-row-main{
  display:flex;
  flex-direction:column;
  gap:3px;
  min-width:0;
}
.card-row-sub{
  display:inline-flex;
  align-items:center;
  gap:6px;
  font-size:12px;
  color:var(--muted);
}
.meta-separator{color:var(--line-subtle)}
.platform-meta,.client-runner-meta{font-size:11.5px}
.card-row-aside{
  display:flex;
  align-items:center;
  color:var(--muted);
}
.row-arrow{
  font-size:14px;
  transition:transform 0.12s ease;
}
.card-row:hover .row-arrow{
  transform:translateX(3px);
  color:var(--brand);
}

/* Buttons */
.button,button{
  appearance:none;
  border:1px solid var(--brand);
  background:var(--brand);
  border-radius:var(--radius-md);
  color:var(--brand-ink);
  cursor:pointer;
  font:inherit;
  font-size:13px;
  font-weight:650;
  letter-spacing:0.01em;
  padding:6px 14px;
  text-decoration:none;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  gap:6px;
  transition:all 0.14s ease;
  min-height:34px;
  white-space:nowrap;
}
.button:hover,button:hover{
  background:var(--brand-hover);
  border-color:var(--brand-hover);
}
.button.secondary,button.secondary{
  background:var(--panel-elevated);
  color:var(--ink);
  border-color:var(--line-subtle);
}
.button.secondary:hover,button.secondary:hover{
  background:var(--accent-gray);
  border-color:var(--muted-dark);
  color:var(--ink-heading);
}
.button.small,button.small{
  font-size:12px;
  font-weight:600;
  padding:3px 8px;
  min-height:26px;
  border-radius:var(--radius-sm);
}
.button.copied,button.copied{
  background:var(--ok);
  border-color:var(--ok);
  color:var(--brand-ink);
}
.danger{
  color:var(--brand-ink)!important;
  border-color:var(--danger)!important;
  background:var(--danger)!important;
}
.danger:hover{
  background:var(--danger-hover)!important;
  border-color:var(--danger-hover)!important;
  box-shadow:0 0 0 2px var(--danger-line)!important;
}

/* Badges, Status Dots & Status Pills */
.badge,.job-status{
  border-radius:999px;
  display:inline-flex;
  align-items:center;
  gap:5px;
  font-size:11px;
  font-weight:650;
  padding:2px 8px;
  text-transform:capitalize;
  letter-spacing:0.02em;
  border:1px solid transparent;
  line-height:1.2;
}
.status-dot{
  width:6px;
  height:6px;
  border-radius:50%;
  display:inline-block;
  flex-shrink:0;
}
.status-dot.online,.job-status.running .status-dot,.job-status.succeeded .status-dot,.job-status.completed .status-dot{background:#16a34a}
.status-dot.offline,.status-dot.unknown,.job-status.unknown .status-dot{background:#9ca3af}
.status-dot.stale,.status-dot.pending,.job-status.queued .status-dot,.job-status.cancelling .status-dot{background:#d97706}
.status-dot.invalid,.job-status.failed .status-dot,.job-status.cancelled .status-dot,.job-status.interrupted .status-dot{background:#dc2626}
.badge.online,.job-status.running{
  background:var(--ok-bg);
  color:var(--ok);
  border-color:var(--ok-line);
}
.badge.offline{
  background:var(--accent-gray);
  color:var(--muted-dark);
  border-color:var(--line);
}
.badge.stale,.badge.pending,.job-status.queued,.job-status.cancelling{
  background:var(--warn-bg);
  color:var(--warn);
  border-color:var(--warn-line);
}
.badge.invalid,.job-status.failed,.job-status.cancelled,.job-status.interrupted{
  background:var(--danger-bg);
  color:var(--danger);
  border-color:var(--danger-line);
}
.job-status.succeeded,.job-status.completed{
  background:var(--ok-bg);
  color:var(--ok);
  border-color:var(--ok-line);
}
.job-status.unknown{
  background:var(--accent-gray);
  color:var(--muted-dark);
  border-color:var(--line);
}
.status-pill{
  display:inline-block;
  padding:2px 8px;
  border-radius:var(--radius-sm);
  font-size:11.5px;
  font-weight:600;
  border:1px solid var(--line);
  background:var(--panel-card);
}
.status-pill.applied{border-color:var(--ok-line);background:var(--ok-bg);color:var(--ok)}
.status-pill.invalid{border-color:var(--danger-line);background:var(--danger-bg);color:var(--danger)}
.status-pill.pending{border-color:var(--warn-line);background:var(--warn-bg);color:var(--warn)}
.workspace-pill{
  display:inline-block;
  padding:2px 7px;
  border-radius:var(--radius-sm);
  font-family:var(--font-mono);
  font-size:11.5px;
  background:var(--panel-card);
  border:1px solid var(--line);
  color:var(--ink);
}

/* Forms & Inputs */
.form-grid{
  display:grid;
  grid-template-columns:repeat(4,minmax(0,1fr));
  align-items:end;
  gap:12px;
}
label{
  display:flex;
  flex-direction:column;
  gap:4px;
  font-weight:600;
  font-size:12.5px;
  color:var(--ink-heading);
}
input,select,textarea{
  border:1px solid var(--line-subtle);
  border-radius:var(--radius-md);
  padding:7px 10px;
  font:inherit;
  font-size:13px;
  color:var(--ink-heading);
  min-width:0;
  background:var(--panel-elevated);
  transition:border-color 0.14s ease,box-shadow 0.14s ease;
}
input:hover,select:hover{border-color:var(--muted-dark)}
input:focus,select:focus{
  outline:none;
  border-color:var(--ink-heading);
  box-shadow:0 0 0 2px var(--focus-ring);
}
fieldset{
  border:1px solid var(--line);
  border-radius:var(--radius-md);
  padding:8px 12px;
  margin:0;
  background:var(--panel-card);
}
legend{
  padding:0 5px;
  color:var(--muted-dark);
  font-size:11px;
  font-weight:680;
  letter-spacing:0.05em;
  text-transform:uppercase;
}
.check{
  display:inline-flex;
  flex-direction:row;
  align-items:center;
  font-weight:500;
  font-size:13px;
  margin:4px 12px 4px 0;
  cursor:pointer;
}
.check span{display:flex;flex-direction:column;gap:1px}
.check small{font-family:var(--font-sans);font-size:11px;line-height:1.35;color:var(--muted)}
.check input{min-width:auto;accent-color:var(--brand);cursor:pointer}
.stack{display:flex;flex-direction:column;gap:12px;max-width:500px}

/* Runner Permission Profile & Workspaces */
.permission-profile-grid{
  display:flex;
  flex-direction:column;
  gap:12px;
}
.perm-selects-row{
  display:grid;
  grid-template-columns:repeat(4,minmax(0,1fr));
  gap:10px;
  width:100%;
}
.workspace-list{list-style:none;padding:0;margin:0 0 16px}
.workspace-card{
  border:1px solid var(--line);
  border-radius:var(--radius-md);
  padding:14px 16px;
  margin-bottom:12px;
  background:var(--panel-card);
}
.workspace-form{
  display:flex;
  flex-direction:column;
  gap:10px;
}
.workspace-main-grid{
  display:grid;
  grid-template-columns:repeat(2,minmax(0,1fr));
  gap:12px;
  margin-bottom:12px;
}
.grid-span-2{grid-column:span 2}
.workspace-perms-section{
  padding-top:10px;
  border-top:1px solid var(--line-light);
  margin-bottom:12px;
}
.workspace-perms-section .form-stat-label{margin-bottom:8px;display:block}
.workspace-btn-bar{
  display:flex;
  justify-content:flex-end;
}
.workspace-footer{
  margin-top:12px;
  padding-top:10px;
  border-top:1px solid var(--line);
  display:flex;
  justify-content:space-between;
  align-items:center;
  flex-wrap:wrap;
  gap:10px;
}
.inline-delete-form{
  display:flex;
  align-items:flex-end;
  flex-wrap:wrap;
  gap:8px;
  min-width:0;
  margin:0;
}
.inline-delete-form label{min-width:0;flex:1 1 180px}
.inline-delete-form input{max-width:100%}
.add-workspace-box{
  margin-top:18px;
  padding:16px;
  border:1px dashed var(--line-subtle);
  border-radius:var(--radius-md);
  background:var(--panel-card);
}
.add-workspace-box h3{margin:0 0 12px}
.full-host-label{
  grid-column:span 2;
}
.check-line{
  display:inline-flex;
  align-items:center;
  gap:6px;
  font-weight:500;
  font-size:12.5px;
  color:var(--muted-dark);
}
.empty-item{padding:10px 0;font-style:italic}

/* Tool Grid */
.tool-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.tool-item{
  border:1px solid var(--line);
  border-radius:var(--radius-md);
  padding:10px 12px;
  background:var(--panel-card);
  display:flex;
  flex-direction:column;
  gap:4px;
}
.tool-name-row{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:8px;
}
.tool-name{color:var(--ink-heading);font-size:13px;font-weight:650}
.tool-version{font-size:11.5px;color:var(--muted)}

/* Version Policy */
.version-policy-form{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:10px;
}
.version-stat{
  display:flex;
  flex-direction:column;
  gap:2px;
  padding:6px 10px;
  border:1px solid var(--line);
  border-radius:var(--radius-md);
  background:var(--panel-card);
}
.form-stat-label{
  font-size:10.5px;
  font-weight:650;
  color:var(--muted);
  text-transform:uppercase;
  letter-spacing:0.04em;
}
.version-stat strong{
  font-size:13px;
  color:var(--ink-heading);
}
.policy-status-foot{margin-top:10px;font-size:12.5px}

/* Danger Zone */
.danger-zone{
  margin-top:16px;
  padding-top:14px;
  border-top:1px solid var(--line);
}
.danger-zone h3,.danger-title{
  margin:0 0 6px;
  color:var(--danger-ink);
}
.emergency-lock-form{margin-top:8px}

/* Settings Page */
.settings-form{max-width:400px}
.settings-note{font-size:13px;line-height:1.5}
.logout-box{margin-top:16px}

/* Empty State Box */
.empty-state-box{
  padding:24px 16px;
  text-align:center;
}
.empty-state-box p{margin:0;color:var(--muted)}
.empty-desc{font-size:13px}

/* Details & Lists */
.item-list,.plain-list{list-style:none;padding:0;margin:0}
.item-list li{border-bottom:1px solid var(--line-light);padding:2px 0}
.item-list li:last-child{border:0}
.empty{
  color:var(--muted);
  padding:24px 16px;
  text-align:center;
  border:1px dashed var(--line);
  border-radius:var(--radius-md);
  background:var(--panel-card);
}
.details{
  display:grid;
  grid-template-columns:160px 1fr;
  gap:10px 14px;
  margin:0;
  font-size:13px;
}
.details dt{
  color:var(--muted);
  font-size:11.5px;
  font-weight:650;
  text-transform:uppercase;
  letter-spacing:0.04em;
}
.details dd{margin:0;font-weight:600;color:var(--ink-heading);overflow-wrap:anywhere}

/* Secret & Enrollment Full-Page Dialogs */
.auth-body{
  display:flex;
  align-items:center;
  justify-content:center;
  min-height:100vh;
  padding:0;
  background:var(--auth-bg);
  color:var(--auth-text);
}
.auth-shell{
  width:min(440px,92%);
  margin:auto;
  position:relative;
  z-index:2;
}
.auth-card{
  padding:32px 28px;
  box-shadow:0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.4);
  background:var(--auth-pane-bg);
  border:1px solid var(--auth-border);
  border-radius:var(--radius-lg);
  color:var(--auth-text);
}
.auth-card h1{color:var(--auth-text)}
.auth-card .lede{color:var(--auth-muted)}
.secret-brand-row{
  display:flex;
  align-items:center;
  gap:10px;
  margin-bottom:16px;
}
.secret-mesh-mark,.error-mesh-mark{
  display:block;
  width:210px;
  height:62px;
  object-fit:cover;
  object-position:center 50%;
  padding:2px 7px;
  border-radius:6px;
  background:#fff;
  box-shadow:var(--shadow-sm);
}
.secret-brand-row .brand-name{display:none}
.brand-name{
  font-size:16px;
  font-weight:750;
  letter-spacing:-0.01em;
  color:#ffffff;
}
.secret-url,.secret-card code{
  display:block;
  overflow-wrap:anywhere;
  padding:12px;
  border-radius:var(--radius-md);
  background:rgba(0,0,0,0.3);
  border:1px solid var(--auth-border);
  color:#ffffff;
  margin:0 0 16px;
  font-family:var(--font-mono);
  font-size:12.5px;
}
.secret-actions{
  display:flex;
  gap:10px;
}
.secret-actions .button{background:#fff;color:#000;border-color:#fff}
.secret-actions .button.secondary{background:transparent;color:#fff;border-color:var(--auth-border)}
.error-card{
  border-color:rgba(220,38,38,0.4);
  background:#171012;
}
.enrollment-header{
  width:min(1180px,calc(100% - 40px));
  margin:18px auto 0;
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:16px;
}
.enrollment-brand{display:block;flex-shrink:0}
.enrollment-brand-logo{
  display:block;
  width:170px;
  height:50px;
  object-fit:cover;
  object-position:center 50%;
  padding:2px 6px;
  border-radius:6px;
  background:#fff;
  box-shadow:var(--shadow-sm);
}
.enrollment-header-actions{display:flex;align-items:center;gap:8px}
.enrollment-shell{padding-top:24px;padding-bottom:50px}
.enrollment-dialog{
  display:block;
  position:static;
  inset:auto;
  height:auto;
  max-width:100%;
  width:min(880px,100%);
  margin:0 auto;
  padding:28px;
  color:inherit;
  border:1px solid var(--line);
  box-shadow:var(--shadow-lg);
  background:var(--panel-elevated);
}
.dialog-icon-row{margin-bottom:12px}
.dialog-mark{width:36px;height:36px;color:var(--brand)}
.enrollment-meta-box{
  padding:12px 14px;
  background:var(--panel-card);
  border:1px solid var(--line);
  border-radius:var(--radius-md);
  margin-bottom:16px;
  display:flex;
  flex-direction:column;
  gap:3px;
}
.dialog-actions{
  display:flex;
  justify-content:flex-end;
  gap:10px;
  margin-top:20px;
}
.tabs{display:flex;flex-wrap:wrap;gap:6px;margin:16px 0}
.tabs [role=tab]{
  background:var(--panel-card);
  color:var(--muted-dark);
  border:1px solid var(--line);
  border-radius:999px;
  padding:5px 14px;
  font-weight:600;
  font-size:12.5px;
  cursor:pointer;
}
.tabs [role=tab][aria-selected=true]{
  color:var(--brand-ink);
  background:var(--brand);
  border-color:var(--brand);
}
.tabs [role=tabpanel]{flex:1 1 100%;margin-top:8px}
pre{
  overflow:auto;
  max-width:100%;
  min-width:0;
  box-sizing:border-box;
  padding:14px;
  border-radius:var(--radius-md);
  background:var(--panel-card);
  border:1px solid var(--line);
  color:var(--ink-heading);
  font-family:var(--font-mono);
  font-size:13px;
  line-height:1.5;
}
.warning{
  border:1px solid var(--warn-line);
  background:var(--warn-bg);
  color:var(--warn);
  border-radius:var(--radius-md);
  padding:10px 14px;
  font-size:13px;
}
:focus-visible{
  outline:2px solid var(--brand);
  outline-offset:2px;
}

/* =========================================================================
   Full-Screen Dark Mesh Login / Setup Entry Experience
   ========================================================================= */
.login-layout{
  display:flex;
  width:100vw;
  min-height:100vh;
  position:relative;
  z-index:1;
  background:var(--auth-bg);
}
.login-brand-pane{
  flex:0 0 48%;
  display:flex;
  flex-direction:column;
  justify-content:space-between;
  padding:48px;
  background:linear-gradient(135deg, #0e1117 0%, #07090c 100%);
  border-right:1px solid var(--auth-border);
  position:relative;
  overflow:hidden;
}
.login-brand-pane::before{
  content:"";
  position:absolute;
  inset:0;
  background-image:
    radial-gradient(circle at 20% 30%, rgba(34,197,94,0.06) 0%, transparent 50%),
    radial-gradient(circle at 80% 80%, rgba(255,255,255,0.04) 0%, transparent 60%);
  pointer-events:none;
}
.login-brand-header{
  position:relative;
  z-index:2;
  max-width:440px;
}
.login-brand-title-wrap{
  display:inline-flex;
  align-items:center;
  gap:10px;
  margin-bottom:20px;
}
.login-brand-logo{
  display:block;
  width:260px;
  height:76px;
  object-fit:cover;
  object-position:center 50%;
  padding:3px 9px;
  border-radius:7px;
  background:#fff;
  box-shadow:var(--shadow-sm);
}
.login-brand-title-wrap .brand-name,.login-brand-title-wrap .brand-tag{display:none}
.brand-tag{
  font-size:9.5px;
  font-weight:750;
  letter-spacing:0.08em;
  padding:2px 6px;
  border-radius:var(--radius-sm);
  background:rgba(255,255,255,0.1);
  color:rgba(255,255,255,0.8);
}
.login-brand-headline{
  font-size:22px;
  font-weight:700;
  color:#ffffff;
  margin:0 0 10px;
  letter-spacing:-0.02em;
}
.login-brand-desc{
  font-size:13.5px;
  line-height:1.6;
  color:var(--auth-muted);
  margin:0;
}
.mesh-network-visual{
  position:relative;
  z-index:2;
  display:flex;
  flex-direction:column;
  align-items:center;
  margin:auto 0 0;
  width:100%;
}
.mesh-canvas-wrap{
  width:min(380px,100%);
  aspect-ratio:1/1;
  display:flex;
  align-items:center;
  justify-content:center;
}
.mesh-grid-svg{
  width:100%;
  height:100%;
  filter:drop-shadow(0 0 20px rgba(0,0,0,0.6));
}
.mesh-visual-caption{
  margin-top:16px;
  text-align:center;
}
.mesh-caption-badge{
  display:inline-flex;
  align-items:center;
  gap:6px;
  padding:3px 10px;
  border-radius:999px;
  background:rgba(255,255,255,0.06);
  border:1px solid rgba(255,255,255,0.1);
  font-size:11px;
  font-weight:600;
  color:#e4e4e7;
}
.mesh-caption-sub{
  margin:4px 0 0;
  font-size:11.5px;
  color:var(--auth-muted);
}

/* Right Form Pane */
.login-form-pane{
  flex:1 1 52%;
  display:flex;
  align-items:center;
  justify-content:center;
  padding:48px 32px;
  background:var(--auth-bg);
}
.login-form-container{
  width:min(380px, 100%);
  display:flex;
  flex-direction:column;
}
.auth-header-mobile{
  display:none;
  margin-bottom:24px;
}
.login-title-group{
  margin-bottom:24px;
}
.login-title-group .brand-kicker{
  color:rgba(255,255,255,0.4);
  margin-bottom:2px;
}
.login-title-group h1{
  color:#ffffff;
  font-size:24px;
  font-weight:700;
  margin:0 0 4px;
}
.login-title-group .subtitle{
  color:var(--auth-muted);
  font-size:13px;
  margin:0 0 6px;
}
.login-invite{
  color:#e4e4e7;
  font-size:13.5px;
  margin:6px 0 0;
}
.login-form{
  width:100%;
  display:flex;
  flex-direction:column;
  gap:16px;
}
.input-group{
  display:flex;
  flex-direction:column;
  gap:6px;
}
.input-group label{
  color:#e4e4e7;
  font-size:12.5px;
  font-weight:600;
}
.password-input-wrap{
  position:relative;
  display:flex;
  align-items:center;
  width:100%;
}
.password-input-wrap input{
  width:100%;
  background:var(--auth-input-bg);
  border:1px solid var(--auth-input-border);
  border-radius:var(--radius-md);
  color:#ffffff;
  padding:9px 36px 9px 12px;
  font-size:13.5px;
  transition:all 0.14s ease;
}
.password-input-wrap input:focus{
  border-color:var(--auth-input-focus);
  background:rgba(255,255,255,0.07);
  box-shadow:0 0 0 2px rgba(255,255,255,0.1);
}
.pwd-toggle-btn{
  position:absolute;
  right:6px;
  top:50%;
  transform:translateY(-50%);
  background:transparent!important;
  border:none!important;
  padding:6px!important;
  min-height:auto!important;
  color:var(--auth-muted);
  cursor:pointer;
  display:flex;
  align-items:center;
  justify-content:center;
  border-radius:var(--radius-sm);
  transition:color 0.12s ease;
}
.pwd-toggle-btn:hover{color:var(--auth-text)}
.eye-icon{
  width:16px;
  height:16px;
}
.login-submit-btn{
  margin-top:6px;
  width:100%;
  height:38px;
  background:var(--auth-btn-bg);
  color:var(--auth-btn-ink);
  border:1px solid var(--auth-btn-bg);
  border-radius:var(--radius-md);
  font-size:13.5px;
  font-weight:700;
  cursor:pointer;
  transition:all 0.14s ease;
}
.login-submit-btn:hover{
  background:var(--auth-btn-hover);
  border-color:var(--auth-btn-hover);
}
.login-submit-btn:disabled{
  opacity:0.75;
  cursor:not-allowed;
}

.mono,.secret-url,.secret-card code{
  font-family:var(--font-mono);
  font-size:13px;
  letter-spacing:-0.01em;
}
.sr-only{
  position:absolute;
  width:1px;
  height:1px;
  padding:0;
  overflow:hidden;
  clip:rect(0,0,0,0);
  white-space:nowrap;
  border:0;
}
.hidden{display:none}
.scope-line{font-family:var(--font-mono);font-size:13px;color:var(--muted-dark)}

/* Responsive Breakpoints & Accessibility */
.skip-link{position:absolute;left:12px;top:-48px;z-index:200;padding:8px 12px;background:var(--panel-elevated);border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--ink-heading);text-decoration:none}.skip-link:focus{top:12px}.theme-control{display:inline-flex;align-items:center;justify-content:center;min-height:34px;padding:6px 10px;background:var(--panel-elevated);color:var(--ink-heading);border:1px solid var(--line-subtle);border-radius:var(--radius-md);font:inherit;font-size:12px;font-weight:650;cursor:pointer;transition:background-color .16s ease,border-color .16s ease,color .16s ease}.theme-control:hover{background:var(--surface-hover);border-color:var(--brand)}
@media(prefers-reduced-motion: reduce){
  *,*::before,*::after{
    animation-duration:0.01ms!important;
    animation-iteration-count:1!important;
    transition-duration:0.01ms!important;
    scroll-behavior:auto!important;
  }
  .button:hover,button:hover,.metric:hover,.row-arrow{
    transform:none!important;
  }
}
@media(max-width:920px){
  .header-inner{padding:0 18px}
  .header-left{gap:16px}
  .control-nav a{padding:5px 9px;font-size:12px}
  .metrics{grid-template-columns:repeat(2,1fr)}
  .grid-two{grid-template-columns:1fr}
}
@media(max-width:1100px){
  .header-inner{gap:12px}
  .header-left{gap:12px}
  .header-actions{gap:6px}
  .header-actions .button{padding-left:9px;padding-right:9px;font-size:12px}
}
@media(max-width:1100px) and (min-width:1001px){
  .header-left{flex:1 1 auto;min-width:0;overflow:hidden}
  .control-nav{flex:0 1 auto;min-width:0;width:fit-content;overflow-x:auto;white-space:nowrap;scrollbar-width:none}
  .control-nav::-webkit-scrollbar{display:none;height:0}
}
@media(max-width:1000px) and (min-width:801px){
  .header-inner{height:auto;flex-direction:column;align-items:stretch;gap:8px;padding:6px 18px}
  .header-left{flex-direction:row;align-items:center;gap:12px;min-width:0;overflow:hidden}
  .control-nav{flex:1 1 auto;min-width:0;width:auto;overflow-x:auto;white-space:nowrap;scrollbar-width:none}
  .control-nav::-webkit-scrollbar{display:none;height:0}
  .header-actions{justify-content:flex-start;width:100%;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;padding-bottom:2px}
  .header-actions > *{flex-shrink:0}
}
@media(max-width:800px){
  .login-layout{flex-direction:column}
  .login-brand-pane{display:none}
  .login-form-pane{padding:32px 20px;width:100%;align-items:flex-start}
  .auth-header-mobile{display:block}
  .shell{padding:16px 14px 40px}
  .app-header{height:auto;padding:6px 0}
  .header-inner{height:auto;flex-direction:column;align-items:stretch;gap:8px;padding-left:14px;padding-right:14px}
  .header-left{flex-direction:row;align-items:center;gap:8px;min-width:0;overflow:hidden}
  .header-mesh-mark{width:148px;height:44px;padding:2px 5px}
  .control-nav{flex:1 1 auto;min-width:0;width:auto;overflow-x:auto;white-space:nowrap;scrollbar-width:none}
  .control-nav::-webkit-scrollbar,.header-actions::-webkit-scrollbar{display:none;height:0}
  .control-nav a{padding-left:9px;padding-right:9px}
  .header-actions{justify-content:flex-start;width:100%;flex-wrap:wrap;overflow:visible;row-gap:6px;padding-bottom:0}
  .header-actions > *{flex-shrink:0}
  .header-actions .button{font-size:11.5px;padding:5px 9px}
  .header-actions > a.button{flex:1 1 auto;min-width:0}
  .section-title{align-items:flex-start;flex-direction:column;gap:6px}
  .section-title > .muted{max-width:100%}
  .check{margin-right:0;align-items:flex-start}
  .form-grid{grid-template-columns:1fr 1fr}
  .panel,.auth-card,.detail-header{padding:16px}
  .tool-grid,.details{grid-template-columns:1fr}
  .perm-selects-row{grid-template-columns:repeat(2,1fr)}
  .grid-two > *,.panel,.workspace-card,.workspace-form,.workspace-main-grid,.workspace-perms-section,.workspace-footer{min-width:0;max-width:100%}
  .workspace-main-grid{grid-template-columns:minmax(0,1fr)}
  .grid-span-2,.full-host-label{grid-column:1 / -1}
  .detail-id,.mono-truncate{overflow-wrap:anywhere;word-break:break-word;white-space:normal}
  .page-heading,.detail-header{flex-wrap:wrap}
  .detail-header-actions{width:100%;justify-content:flex-start}
  .table-wrap::after{display:block}
  .scope-editor-form{grid-template-columns:1fr;align-items:stretch}
  .scope-editor-form .form-submit-wrap{margin-top:0}
  .version-policy-form{grid-template-columns:1fr}
  .form-grid.add-form-grid,.form-grid.add-client-grid{flex-direction:column;align-items:stretch}
  .form-grid.add-form-grid > label,.form-grid.add-client-grid > label:not(.check),.form-grid.add-client-grid fieldset,.form-grid.add-form-grid .form-submit-wrap,.form-grid.add-client-grid .form-submit-wrap{width:100%;flex:1 1 auto}
  .add-client-grid fieldset .scope-selector-row{align-items:flex-start}
  .login-brand-logo{width:190px;height:58px}
  .secret-mesh-mark,.error-mesh-mark{width:190px;height:56px}
  .enrollment-header{width:calc(100% - 28px);margin-top:12px;gap:10px;flex-wrap:wrap}
  .enrollment-brand-logo{width:148px;height:44px;padding:2px 5px}
  .enrollment-header-actions{gap:6px;margin-left:auto}
  .enrollment-shell{padding-top:16px}
  .enrollment-dialog{position:static;inset:auto;height:auto;max-width:100%;min-width:0;padding:18px;overflow:hidden}
  .enrollment-dialog .page-heading,.enrollment-dialog .enrollment-meta-box,.enrollment-dialog [role="tabpanel"]{min-width:0;max-width:100%}
  .enrollment-dialog .mono{overflow-wrap:anywhere;word-break:break-word}
  .enrollment-dialog pre{width:100%;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;overflow-x:hidden}
  .enrollment-dialog pre code{white-space:inherit;overflow-wrap:inherit;word-break:inherit}
}
@media(max-width:540px){
  .header-left{flex-wrap:wrap;row-gap:8px}
  .header-left .control-nav{flex:1 1 100%;width:100%;overflow-x:visible}
  .action-btn-group{flex-wrap:nowrap}
  .action-btn-group > *{flex:0 0 auto}
  .action-btn-group .danger-action label{white-space:nowrap}
  .metrics{grid-template-columns:1fr}
  .form-grid{grid-template-columns:1fr}
  .perm-selects-row{grid-template-columns:1fr}
  h1{font-size:20px}
  .detail-title{font-size:17px}
  .scope-editor-form{grid-template-columns:1fr;align-items:stretch}
  .scope-editor-form .button{width:100%}
  .override-form-row{flex-direction:column;align-items:stretch}
  .table-wrap{max-width:100%}
  .form-grid{grid-template-columns:1fr}
}
</style>`; }
function adminScript(): string {
  const translationJson = JSON.stringify(ZH_UI_TEXT);
  return `<script>
(function(){
var key='runmesh-theme';
var values=['system','light','dark'];
function preference(){try{var value=localStorage.getItem(key);return values.indexOf(value)>=0?value:'system'}catch(_){return 'system'}}
function label(value){var zh=document.documentElement.lang==='zh-CN';if(!zh)return 'Theme: '+value;return value==='light'?'主题：浅色':value==='dark'?'主题：深色':'主题：跟随系统'}
function updateThemeLabel(value){document.querySelectorAll('[data-theme-toggle]').forEach(function(button){var text=label(value);button.textContent=text;button.setAttribute('aria-label',text)})}
function applyTheme(value){if(value==='light'||value==='dark')document.documentElement.dataset.theme=value;else delete document.documentElement.dataset.theme;updateThemeLabel(value)}
var ZH_UI_TEXT=${translationJson};function translateKnown(value){
  var trimmed=value.trim();
  if(!trimmed)return value;
  var rawMapped=ZH_UI_TEXT[value];
  if(rawMapped)return rawMapped;
  var mapped=ZH_UI_TEXT[trimmed];
  if(mapped)return value.replace(trimmed,mapped);
  var suffix=' configured';
  if(trimmed.slice(-suffix.length)===suffix&&/^[0-9]+$/.test(trimmed.slice(0,-suffix.length)))return value.replace(trimmed,trimmed.slice(0,-suffix.length)+' 已配置');
  suffix=' connected';
  if(trimmed.slice(-suffix.length)===suffix&&/^[0-9]+$/.test(trimmed.slice(0,-suffix.length)))return value.replace(trimmed,trimmed.slice(0,-suffix.length)+' 已连接');
  if(trimmed.indexOf('Status:')===0)return value.replace(trimmed,'状态：'+statusText(trimmed.slice(7).trim()));
  if(trimmed.indexOf('Validation:')===0)return value.replace(trimmed,'验证：'+statusText(trimmed.slice(11).trim()));
  var separator=' · ';
  var separatorAt=trimmed.indexOf(separator);
  if(separatorAt>0){var status=trimmed.slice(0,separatorAt);if(ZH_UI_TEXT[status])return value.replace(trimmed,statusText(status)+' · '+trimmed.slice(separatorAt+separator.length))}
  return value;
}
function translateTextNodes(root){var walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode:function(node){if(!node.nodeValue||!node.nodeValue.trim())return NodeFilter.FILTER_REJECT;for(var el=node.parentElement;el;el=el.parentElement){if(el.hasAttribute('data-no-i18n')||el.tagName==='CODE'||el.tagName==='PRE'||el.tagName==='SCRIPT'||el.tagName==='STYLE'||el.tagName==='INPUT'||el.tagName==='TEXTAREA')return NodeFilter.FILTER_REJECT}return NodeFilter.FILTER_ACCEPT}});var nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);nodes.forEach(function(node){node.nodeValue=translateKnown(node.nodeValue||'')})}
function translateAttributes(root){['aria-label','alt','placeholder','title'].forEach(function(name){root.querySelectorAll('['+name+']').forEach(function(element){if(element.closest('[data-no-i18n]'))return;var value=element.getAttribute(name)||'';var translated=translateKnown(value);if(translated===value&&value.indexOf('Rename ')===0)translated='重命名 '+value.slice(7);element.setAttribute(name,translated)})})}
function statusText(value){return ZH_UI_TEXT[value]||value}
function applyLocale(locale){var zh=locale==='zh-CN';document.documentElement.lang=zh?'zh-CN':'en';document.querySelectorAll('[data-lang-toggle]').forEach(function(item){var active=item.getAttribute('data-lang-toggle')===locale;item.setAttribute('aria-current',active?'true':'false')});if(zh){translateTextNodes(document.body);translateAttributes(document);var title=document.title;var titleParts=['MCP client created','MCP client rotated','MCP Client','Runmesh · Agent Control Plane','Agent Control Plane','Dashboard','Runners','MCP Clients','Clients','Settings','login','setup','enrollment'];titleParts.forEach(function(part){if(ZH_UI_TEXT[part])title=title.split(part).join(ZH_UI_TEXT[part])});document.title=title}updateThemeLabel(preference())}
function requestedLocale(){var query=new URLSearchParams(location.search).get('lang');if(query==='zh-CN'||query==='zh')return 'zh-CN';if(query==='en')return 'en';var match=/runmesh_lang=(zh-CN|en)/.exec(document.cookie||'');if(match)return match[1];return navigator.language&&navigator.language.toLowerCase().startsWith('zh')?'zh-CN':'en'}
function rememberLocale(locale){document.cookie='runmesh_lang='+locale+'; Max-Age=31536000; Path=/; SameSite=Lax'}
document.querySelectorAll('[data-theme-toggle]').forEach(function(button){button.addEventListener('click',function(){var current=preference();var next=values[(values.indexOf(current)+1)%values.length];try{localStorage.setItem(key,next)}catch(_){}applyTheme(next)})});
document.querySelectorAll('[data-lang-toggle]').forEach(function(link){link.addEventListener('click',function(event){var locale=link.getAttribute('data-lang-toggle')||'en';rememberLocale(locale);if(locale==='zh-CN'&&new URLSearchParams(location.search).get('lang')!=='zh-CN'){event.preventDefault();var url=new URL(location.href);url.searchParams.set('lang','zh-CN');location.href=url.toString()}else if(locale==='en'&&new URLSearchParams(location.search).has('lang')){event.preventDefault();var url=new URL(location.href);url.searchParams.set('lang','en');location.href=url.toString()}})});
var locale=requestedLocale();if(new URLSearchParams(location.search).has('lang'))rememberLocale(locale);applyLocale(locale);
function copyText(text){if(navigator.clipboard&&navigator.clipboard.writeText)return navigator.clipboard.writeText(text);var area=document.createElement('textarea');area.value=text;area.setAttribute('readonly','');area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();try{document.execCommand('copy')}catch(_){}area.remove();return Promise.resolve()}
document.querySelectorAll('[data-copy]').forEach(function(button){button.addEventListener('click',function(){var result=copyText(button.getAttribute('data-copy')||'');var mark=function(){button.textContent=document.documentElement.lang==='zh-CN'?'已复制':'Copied';button.classList.add('copied')};if(result&&typeof result.then==='function')result.then(mark,function(){});else mark()})});
document.querySelectorAll('[data-tab]').forEach(function(tab){tab.addEventListener('click',function(){var target=tab.getAttribute('data-tab');document.querySelectorAll('[data-tab]').forEach(function(item){item.setAttribute('aria-selected',String(item===tab));item.tabIndex=item===tab?0:-1});document.querySelectorAll('[data-panel]').forEach(function(panel){panel.hidden=panel.getAttribute('data-panel')!==target})});tab.addEventListener('keydown',function(event){if(event.key==='ArrowLeft'||event.key==='ArrowRight'){var tabs=Array.prototype.slice.call(document.querySelectorAll('[data-tab]'));var next=tabs[(tabs.indexOf(tab)+(event.key==='ArrowRight'?1:tabs.length-1))%tabs.length];next.focus();next.click()}})});
document.querySelectorAll('.pwd-toggle-btn').forEach(function(btn){btn.addEventListener('click',function(){var wrap=btn.closest('.password-input-wrap');if(!wrap)return;var input=wrap.querySelector('input');if(!input)return;var isPwd=input.type==='password';input.type=isPwd?'text':'password';var isZh=document.documentElement.lang==='zh-CN';var buttonLabel=isPwd?(isZh?'隐藏密码':'Hide password'):(isZh?'显示密码':'Show password');btn.setAttribute('aria-label',buttonLabel);btn.setAttribute('title',buttonLabel);btn.innerHTML=isPwd?'<svg class="eye-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>':'<svg class="eye-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>'})});
document.querySelectorAll('form.login-form').forEach(function(form){form.addEventListener('submit',function(){var btn=form.querySelector('.login-submit-btn');if(!btn||btn.disabled)return;var isZh=document.documentElement.lang==='zh-CN';var isSetup=form.getAttribute('action')==='/setup';var loadingText=isSetup?(isZh?'正在初始化...':'Initializing...'):(isZh?'正在登录...':'Signing in...');var origWidth=btn.offsetWidth;btn.style.width=origWidth>0?(origWidth+'px'):'100%';btn.disabled=true;btn.textContent=loadingText;try{form.submit()}catch(e){}})});
})();
</script>`;
}
function runnerEnrollmentPage(env: RunnerReleaseEnvironment, baseUrl: string, runnerId: string, code: string | undefined, csrf: string, _reEnroll = false): Response {
  if (code === undefined) return adminError(503, "Enrollment code could not be generated.");
  const release = runnerReleaseDescriptor(env);
  const bootstrap = release.distributable;
  const shellCommand = `curl --fail --location --proto '=https' --tlsv1.2 ${new URL("/runner/install.sh", baseUrl).toString()} | sudo sh`;
  const powerShellCommand = `Invoke-WebRequest -UseBasicParsing ${new URL("/runner/install.ps1", baseUrl).toString()} | Invoke-Expression`;
  const manualEnroll = `coding-runner enroll --server ${new URL("/runner/enroll", baseUrl).toString()} --code-stdin`;
  const manualCommand = `${manualEnroll}\ncoding-runner install`;
  const commands = bootstrap ? { linux: shellCommand, macos: shellCommand, windows: powerShellCommand } : { linux: manualCommand, macos: manualCommand, windows: manualCommand };
  const tabs = Object.entries(commands).map(([platform, value], index) => `<button role="tab" id="tab-${platform}" aria-controls="panel-${platform}" aria-selected="${index === 0 ? "true" : "false"}" tabindex="${index === 0 ? "0" : "-1"}" data-tab="${platform}">${platform === "macos" ? "macOS" : platform === "windows" ? "Windows" : "Linux"}</button><section role="tabpanel" id="panel-${platform}" aria-labelledby="tab-${platform}" ${index === 0 ? "" : "hidden"} data-panel="${platform}"><pre><code>${escapeHtml(value)}</code></pre><button type="button" class="button secondary" data-copy="${escapeHtml(value)}">Copy ${bootstrap ? "installer" : "enrollment"} command</button></section>`).join("");
  const title = bootstrap ? "Signed fixed-preview enrollment" : "Manual portable-artifact enrollment";
  const instruction = bootstrap
    ? "The installer verifies the fixed signed Runner artifact before it asks locally for this one-time code. It never places the code in this command, a URL, or process arguments."
    : "The fixed signed hosted release is not enabled on this deployment. Download and verify the portable Runner artifact first, then paste this code only into the local prompt requested by --code-stdin.";
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><script>try{var t=localStorage.getItem('runmesh-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(_){}</script><link rel="icon" href="/assets/favicon.png" type="image/png"><title>Runmesh · Agent Control Plane enrollment</title>${adminStyles()}</head><body class="ops-body enrollment-body"><header class="enrollment-header"><a class="enrollment-brand" href="/admin" aria-label="Runmesh · Agent Control Plane">${brandLogo("enrollment-brand-logo")}</a><div class="enrollment-header-actions">${languageSwitch()}${themeControl()}</div></header><main class="shell enrollment-shell"><dialog open aria-labelledby="enrollment-title" class="enrollment-dialog"><section class="page-heading"><div><div class="dialog-icon-row">${meshMarkSvg("dialog-mark")}</div><p class="eyebrow">${title}</p><h1 id="enrollment-title">Enroll Runner</h1><p class="lede">${instruction} This one-time code expires in 30 minutes and will not be shown again.</p></div></section><div class="enrollment-meta-box"><span class="form-stat-label">Target Runner ID</span><span class="mono">${escapeHtml(runnerId)}</span></div><div class="enrollment-meta-box"><span class="form-stat-label">One-time enrollment code</span><code class="mono" data-no-i18n>${escapeHtml(code)}</code><span class="muted font-12">Paste it only into the local prompt after verification; it is deliberately excluded from copied commands.</span></div><div role="tablist" aria-label="Operating system" class="tabs">${tabs}</div><p class="warning">Do not share this code. It is single-use enrollment material, not an administrator password, MCP secret, or long-term credential.</p><div class="top-actions dialog-actions"><form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/enrollment"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="button secondary">Regenerate enrollment</button></form><a class="button" href="/admin/runners">Done</a></div></dialog></main>${adminScript()}</body></html>`);
}
function secretCreatedPage(title: string, url: string): string { return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/assets/favicon.png" type="image/png"><title>${escapeHtml(title)}</title>${adminStyles()}</head><body class="auth-body">${languageSwitch()}<main class="auth-shell"><section class="auth-card secret-card"><div class="secret-brand-row">${meshMarkSvg("secret-mesh-mark")}<span class="brand-name">Runmesh</span></div><p class="brand-kicker">Runmesh</p><h1>${escapeHtml(title)}</h1><p class="lede">Copy this URL now. It will not be shown again.</p><code>${escapeHtml(url)}</code><div class="secret-actions"><button type="button" class="button" data-copy="${escapeHtml(url)}">Copy MCP URL</button><a class="button secondary" href="/admin">Back to admin</a></div></section></main>${adminScript()}</body></html>`; }
function secretUrl(base: string, secret: string): string { const url = new URL(base); url.pathname = `/${secret}/mcp`; url.search = ""; return url.toString(); }
function selectedScopes(form: FormData): CodingScope[] | undefined { const values = form.getAll("scopes"); const scopes = values.filter((value): value is CodingScope => value === "coding:read" || value === "coding:write" || value === "coding:exec"); return scopes.length === values.length && scopes.length > 0 && new Set(scopes).size === scopes.length ? scopes : undefined; }
function validPassword(password: string): boolean { return password.length >= 12 && password.length <= 1_024; }
function validLabel(label: string): boolean { return label.trim().length > 0 && label.length <= 256; }
function validRunnerVersion(value: string): boolean { return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value); }

export async function pushRunnerPolicy(env: WorkerEnv, runnerId: string, mutationId?: string): Promise<Response> {
  const body = JSON.stringify(mutationId === undefined ? {} : { mutation_id: mutationId });
  const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET ?? "", "POST", "/policy", body);
  return env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/policy", { method: "POST", headers, body }));
}
async function beginRunnerPolicyMutation(env: WorkerEnv, runnerId: string, mutationId: string): Promise<Response> {
  const body = JSON.stringify({ mutation_id: mutationId, runner_id: runnerId });
  const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET ?? "", "POST", "/begin-policy-mutation", body);
  return env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/begin-policy-mutation", { method: "POST", headers, body }));
}
async function markRunnerPolicyCommitted(env: WorkerEnv, runnerId: string, mutationId: string, phase: "committed_pending" | "offline_pending", desiredRevision: number, desiredChecksum: string): Promise<Response> {
  const body = JSON.stringify({ mutation_id: mutationId, phase, desired_revision: desiredRevision, desired_checksum: desiredChecksum });
  const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET ?? "", "POST", "/mark-policy-committed", body);
  return env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/mark-policy-committed", { method: "POST", headers, body }));
}

async function cancelRunnerPolicyMutation(env: WorkerEnv, runnerId: string, mutationId: string): Promise<Response> {
  const body = JSON.stringify({ mutation_id: mutationId });
  const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET ?? "", "POST", "/cancel-policy-mutation", body);
  return env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/cancel-policy-mutation", { method: "POST", headers, body }));
}
async function mutateRunnerPolicy(env: WorkerEnv, runnerId: string, mutation: { readonly path: string; readonly method: "POST" | "PUT" | "DELETE"; readonly payload: Record<string, unknown> }): Promise<Response> {
  const mutationId = `mutation-${crypto.randomUUID()}`;
  let fenced: Response;
  try { fenced = await beginRunnerPolicyMutation(env, runnerId, mutationId); } catch { return new Response("runner policy fence unavailable", { status: 503 }); }
  if (!fenced.ok) return fenced;
  let changed: Response;
  try { changed = await registryRequest(env, mutation.path, mutation.method, JSON.stringify({ mutation_id: mutationId, ...mutation.payload })); } catch { return new Response("registry unavailable after policy fence", { status: 503 }); }
  if (!changed.ok) {
    // A Registry 5xx response is not evidence that no write committed. Do not
    // attempt to treat it as a safe client rejection; leave the transport
    // fenced and hide the uncertain upstream response behind 503.
    if (![400, 404, 409].includes(changed.status)) return new Response("registry mutation outcome is uncertain; Runner remains safely fenced", { status: 503 });
    try {
      const cancelled = await cancelRunnerPolicyMutation(env, runnerId, mutationId);
      if (!cancelled.ok) return new Response("policy mutation failed; Runner remains safely fenced", { status: 503 });
    } catch { return new Response("policy mutation state is uncertain; Runner remains safely fenced", { status: 503 }); }
    return changed;
  }
  const mutationState = await runnerMutationState(env, runnerId, mutationId).catch(() => undefined);
  if (mutationState?.mutation_committed !== true) return new Response("policy mutation outcome is uncertain; Runner remains safely fenced", { status: 503 });
  const phase = mutationState.policy_status === "offline_pending" ? "offline_pending" : "committed_pending";
  try {
    const committed = await markRunnerPolicyCommitted(env, runnerId, mutationId, phase, typeof mutationState.desired_revision === "number" ? mutationState.desired_revision : 0, typeof mutationState.desired_checksum === "string" ? mutationState.desired_checksum : "");
    if (!committed.ok) return new Response("policy mutation outcome is uncertain; Runner remains safely fenced", { status: 503 });
  } catch { return new Response("policy mutation outcome is uncertain; Runner remains safely fenced", { status: 503 }); }
  try {
    const pushed = await pushRunnerPolicy(env, runnerId, mutationId);
    if (!pushed.ok && pushed.status !== 204 && pushed.status !== 503) return pushed;
  } catch { /* desired policy remains pending for reconnect */ }
  // A committed desired policy is successful even while its Runner is offline
  // or validating it. Browser requests redirect normally; token API callers get
  // an explicit accepted response rather than a false transient failure.
  return new Response(changed.body, { status: 202, headers: changed.headers });
}
async function forwardRunnerRpc(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (request.method !== "POST" || segments.length !== 4 || segments[0] !== "internal" || segments[1] !== "runners" || segments[3] !== "rpc" || !isSafeIdentifier(segments[2] ?? "")) return notFound();
  const body = await request.text();
  if (!await verifyInternalRequest(request, env.INTERNAL_CONTROL_SECRET, body, consumeInternalNonce.bind(undefined, env))) return notFound();
  const runnerId = segments[2] as string; const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET ?? "", "POST", "/rpc", body);
  return env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/rpc", { method: "POST", headers, body }));
}

async function handleRunnerAdmin(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  if (!isRunnerAdminRequest(request, env)) { await discardBody(request); return new Response("unauthorized", { status: 401 }); }
  if (env.INTERNAL_CONTROL_SECRET === undefined || env.RUNNER_TOKEN_PEPPER === undefined) { await discardBody(request); return new Response("admin control plane is not configured", { status: 503 }); }
  const segments = url.pathname.split("/").filter(Boolean); const runnerId = segments[2]; const action = segments[3];
  if (segments.length === 2 && request.method === "POST") {
    const input = await readAdminBody(request); const id = typeof input?.runner_id === "string" && isSafeIdentifier(input.runner_id) ? input.runner_id : undefined;
    if (id === undefined) return Response.json({ error: "runner_id must be a safe identifier" }, { status: 400 });
    return registerRunner(env, id, input);
  }
  if (runnerId === undefined || !isSafeIdentifier(runnerId) || action === undefined || segments.length !== 4 || request.method !== "POST") { await discardBody(request); return notFound(); }
  if (action === "rotate") return registerRunner(env, runnerId, await readAdminBody(request));
  if (action === "delete") return deleteRunnerWithAdminToken(env, runnerId, await readAdminBody(request));
  if (action === "revoke") {
    const input = await readAdminBody(request);
    if (input === undefined || input.confirmation !== runnerId) return Response.json({ error: "confirmation must equal runner_id" }, { status: 400 });
    const mutationId = `credential-revoked-${crypto.randomUUID()}`;
    const fenced = await fenceRunnerTransport(env, runnerId, mutationId);
    if (!fenced.ok) return new Response("runner unavailable", { status: 503 });
    let response: Response;
    try { response = await runnerRegistryRequest(env, runnerId, "/revoke", "POST", JSON.stringify({ confirmation: runnerId, mutation_id: mutationId })); } catch { return new Response("registry mutation outcome is uncertain; Runner remains safely fenced", { status: 503 }); }
    if (!response.ok) {
      if (![400, 404, 409].includes(response.status)) return new Response("registry mutation outcome is uncertain; Runner remains safely fenced", { status: 503 });
      try {
        const cancelled = await cancelRunnerPolicyMutation(env, runnerId, mutationId);
        if (!cancelled.ok) return new Response("Runner remains safely fenced", { status: 503 });
      } catch { return new Response("Runner remains safely fenced", { status: 503 }); }
      return new Response("runner revoke failed", { status: response.status });
    }
    try { await revokeRunnerTransport(env, runnerId, mutationId); } catch { /* registry revocation is authoritative */ }
    return new Response(null, { status: 204 });
  }
  return notFound();
}
async function deleteRunnerWithAdminToken(env: WorkerEnv, runnerId: string, input: Record<string, unknown> | undefined): Promise<Response> {
  if (input === undefined || input.confirmation !== runnerId) return Response.json({ error: "confirmation must equal runner_id" }, { status: 400 });
  const mutationId = `runner-delete-${crypto.randomUUID()}`;
  const fenced = await fenceRunnerTransport(env, runnerId, mutationId);
  if (!fenced.ok) return new Response("runner unavailable", { status: 503 });
  let response: Response;
  try { response = await runnerRegistryRequest(env, runnerId, "", "DELETE", JSON.stringify({ confirmation: runnerId, mutation_id: mutationId })); } catch { return new Response("registry mutation outcome is uncertain; Runner remains safely fenced", { status: 503 }); }
  if (!response.ok) {
    if (![400, 404, 409].includes(response.status)) return new Response("registry mutation outcome is uncertain; Runner remains safely fenced", { status: 503 });
    try {
      const state = await runnerMutationState(env, runnerId, mutationId);
      if (state?.runner_exists === false && state.mutation_committed === true) {
        await deleteRunnerTransport(env, runnerId, mutationId);
        return new Response(null, { status: 204 });
      }
      const cancelled = await cancelRunnerPolicyMutation(env, runnerId, mutationId);
      if (!cancelled.ok) return new Response("Runner remains safely fenced", { status: 503 });
    } catch { return new Response("Runner remains safely fenced", { status: 503 }); }
    return new Response("runner delete failed", { status: response.status });
  }
  await deleteRunnerTransport(env, runnerId, mutationId);
  return new Response(null, { status: 204 });
}

async function registerRunner(env: WorkerEnv, runnerId: string, input: Record<string, unknown> | undefined): Promise<Response> {
  const supplied = input?.token;
  if (supplied !== undefined && (typeof supplied !== "string" || supplied.length < 32 || supplied.length > 512 || /\s/.test(supplied))) return Response.json({ error: "token must be 32-512 non-whitespace characters" }, { status: 400 });
  const token = typeof supplied === "string" ? supplied : generateRunnerToken(); const pepper = env.RUNNER_TOKEN_PEPPER;
  if (pepper === undefined) return new Response("admin control plane is not configured", { status: 503 });
    const mutationId = `credential-rotated-${crypto.randomUUID()}`;
    let existingResponse: Response;
    try { existingResponse = await runnerRegistryRequest(env, runnerId, "", "GET", ""); } catch { return new Response("registry unavailable", { status: 503 }); }
    if (!existingResponse.ok && existingResponse.status !== 404) return new Response("registry unavailable", { status: 503 });
    const existing = existingResponse.ok;
    const runner = existing ? record(await json(existingResponse)) : undefined;
    const canFenceExisting = existing && Number(runner?.connection_epoch ?? 0) > 0 && Number(runner?.credential_version ?? 0) > 0 && typeof runner?.session_id === "string" && runner.session_id.length > 0 && runner?.state === "online";
  if (canFenceExisting) {
    const fenced = await fenceRunnerTransport(env, runnerId, mutationId);
    if (!fenced.ok) return new Response("runner unavailable", { status: 503 });
  }
  let response: Response;
  try { response = await runnerRegistryRequest(env, runnerId, "", "PUT", JSON.stringify({ token_verifier: await runnerTokenVerifier(token, pepper), ...(canFenceExisting ? { mutation_id: mutationId } : {}) })); } catch { return new Response("registry mutation outcome is uncertain; Runner remains safely fenced", { status: 503 }); }
  if (!response.ok) {
    if (canFenceExisting && ![400, 404, 409].includes(response.status)) return new Response("registry mutation outcome is uncertain; Runner remains safely fenced", { status: 503 });
    if (canFenceExisting) {
      try {
        const cancelled = await cancelRunnerPolicyMutation(env, runnerId, mutationId);
        if (!cancelled.ok) return new Response("Runner remains safely fenced", { status: 503 });
      } catch { return new Response("Runner remains safely fenced", { status: 503 }); }
    }
    return new Response("runner registration failed", { status: response.status });
  }
  if (canFenceExisting) { try { await revokeRunnerTransport(env, runnerId, mutationId); } catch { /* new credential remains authoritative */ } }
  return Response.json({ runner_id: runnerId, token }, { headers: credentialHeaders("application/json; charset=utf-8") });
}
async function fenceRunnerTransport(env: WorkerEnv, runnerId: string, mutationId: string): Promise<Response> {
  const body = JSON.stringify({ mutation_id: mutationId });
  const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET ?? "", "POST", "/begin-policy-mutation", body);
  return env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/begin-policy-mutation", { method: "POST", headers, body }));
}
async function revokeRunnerTransport(env: WorkerEnv, runnerId: string, mutationId: string): Promise<void> {
  const body = JSON.stringify({ mutation_id: mutationId });
  const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET ?? "", "POST", "/revoke", body);
  await env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/revoke", { method: "POST", headers, body }));
}
async function deleteRunnerTransport(env: WorkerEnv, runnerId: string, mutationId: string): Promise<void> {
  const body = JSON.stringify({ mutation_id: mutationId });
  const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET ?? "", "POST", "/delete", body);
  await env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/delete", { method: "POST", headers, body }));
}
function isRunnerAdminRequest(request: Request, env: WorkerEnv): boolean { const token = bearerToken(request); return token !== undefined && env.ADMIN_TOKEN !== undefined && constantTimeEqual(token, env.ADMIN_TOKEN); }
async function runnerRegistryRequest(env: WorkerEnv, runnerId: string, action: string, method: string, body: string): Promise<Response> { const path = `/runners/${encodeURIComponent(runnerId)}${action}`; const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET as string, method, path, body); return env.REGISTRY.get(env.REGISTRY.idFromName("registry")).fetch(new Request(`https://registry.internal${path}`, { method, ...(body.length === 0 ? {} : { body }), headers })); }

async function runnerMutationState(env: WorkerEnv, runnerId: string, mutationId: string): Promise<Record<string, unknown> | undefined> {
  const response = await registryGet(env, `/runners/${encodeURIComponent(runnerId)}/mutation-state?mutation_id=${encodeURIComponent(mutationId)}`);
  return response.ok ? record(await json(response)) : undefined;
}

async function verifyMcpClient(env: WorkerEnv, secretVerifier: string): Promise<VerifiedMcpClient | undefined> { const response = await registryPost(env, "/auth/mcp/verify", { secret_verifier: secretVerifier }); const body = response.ok ? record(await json(response)) : undefined; if (body === undefined || typeof body.client_id !== "string" || typeof body.label !== "string" || typeof body.secret_version !== "number" || !Array.isArray(body.scopes) || body.scopes.some((scope) => scope !== "coding:read" && scope !== "coding:write" && scope !== "coding:exec")) return undefined; return { client_id: body.client_id, label: body.label, secret_version: body.secret_version, scopes: body.scopes as CodingScope[] }; }
async function registryGet(env: WorkerEnv, path: string): Promise<Response> { const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET ?? "", "GET", path, ""); return env.REGISTRY.get(env.REGISTRY.idFromName("registry")).fetch(new Request(`https://registry.internal${path}`, { headers })); }
async function registryPost(env: WorkerEnv, path: string, payload: Record<string, unknown>): Promise<Response> { const body = JSON.stringify(payload); const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET ?? "", "POST", path, body); return env.REGISTRY.get(env.REGISTRY.idFromName("registry")).fetch(new Request(`https://registry.internal${path}`, { method: "POST", headers, body })); }
type PreAuthThrottle = { readonly allowed: boolean; readonly retry_after_ms: number };
async function authThrottleCheck(env: WorkerEnv, kind: "login" | "setup"): Promise<PreAuthThrottle | undefined> {
  const response = await registryPost(env, "/auth/throttle/check", { kind });
  const body = response.ok ? record(await json(response)) : undefined;
  return body !== undefined && typeof body.allowed === "boolean" && typeof body.retry_after_ms === "number" && Number.isSafeInteger(body.retry_after_ms) && body.retry_after_ms >= 0
    ? { allowed: body.allowed, retry_after_ms: body.retry_after_ms }
    : undefined;
}
async function authThrottleRecord(env: WorkerEnv, kind: "login" | "setup", success: boolean): Promise<void> {
  // The request includes only outcome metadata; passwords/verifiers never enter logs.
  try { await registryPost(env, "/auth/throttle/record", { kind, success }); } catch { /* authentication result remains authoritative */ }
}
function throttleError(retryAfterMs: number): Response {
  const headers = htmlHeaders();
  headers.set("retry-after", String(Math.max(1, Math.ceil(retryAfterMs / 1_000))));
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/assets/favicon.png" type="image/png"><title>Runmesh · Agent Control Plane</title>${adminStyles()}</head><body class="auth-body">${languageSwitch()}<main class="auth-shell"><section class="auth-card error-card"><div class="secret-brand-row">${meshMarkSvg("error-mesh-mark")}<span class="brand-name">Runmesh</span></div><p class="brand-kicker">Runmesh</p><h1>Runmesh</h1><p class="subtitle">Agent Control Plane</p><p class="lede">Invalid administrator password.</p><p class="muted">Please try again shortly.</p><p><a class="button secondary" href="/">Return</a></p></section></main>${adminScript()}</body></html>`, { status: 403, headers });
}
async function formData(request: Request): Promise<FormData | undefined> { return readCappedFormData(request, MAX_ADMIN_BODY_BYTES); }
async function readAdminBody(request: Request): Promise<Record<string, unknown> | undefined> {
  const body = await readBodyText(request, MAX_ADMIN_BODY_BYTES);
  if (body === undefined) return undefined;
  try { const value = JSON.parse(body) as unknown; return record(value); } catch { return undefined; }
}
async function discardBody(request: Request): Promise<void> {
  // Do not allocate an unbounded invalid request body before returning an auth
  // response. Cancelling the stream releases the Worker-side reader.
  try { await request.body?.cancel(); } catch { /* already consumed */ }
}
function cookieValue(request: Request, name: string): string | undefined { const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); const match = new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`).exec(request.headers.get("cookie") ?? ""); return match?.[1]; }
function sessionCookie(value: string): string { return `${ADMIN_SESSION_COOKIE}=${value}; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1_000)}`; }
function csrfCookie(value: string): string { return `${ADMIN_CSRF_COOKIE}=${value}; Secure; Path=/; SameSite=Strict; Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1_000)}`; }
function clearCookie(name: string): string { return `${name}=; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=0`; }
function credentialHeaders(contentType: string): Headers { const headers = htmlHeaders(); headers.set("content-type", contentType); return headers; }
function html(value: string, cookies: readonly string[] = []): Response { const headers = htmlHeaders(); for (const cookie of cookies) headers.append("set-cookie", cookie); return new Response(value, { headers }); }
function htmlHeaders(): Headers { return new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", "x-content-type-options": "nosniff", "x-frame-options": "DENY" }); }
function redirect(location: string, cookies: readonly string[] = []): Response { const headers = htmlHeaders(); headers.set("location", location); for (const cookie of cookies) headers.append("set-cookie", cookie); return new Response(null, { status: 303, headers }); }
function adminError(status: number, message: string, cookies: readonly string[] = []): Response { const response = html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/assets/favicon.png" type="image/png"><title>Runmesh · Agent Control Plane</title>${adminStyles()}</head><body class="auth-body">${languageSwitch()}<main class="auth-shell"><section class="auth-card error-card"><div class="secret-brand-row">${meshMarkSvg("error-mesh-mark")}<span class="brand-name">Runmesh</span></div><p class="brand-kicker">Runmesh</p><h1>Runmesh</h1><p class="subtitle">Agent Control Plane</p><p class="lede">${escapeHtml(message)}</p><p><a class="button secondary" href="/">Return</a></p></section></main>${adminScript()}</body></html>`, cookies.length === 0 ? [] : cookies); return new Response(response.body, { status, headers: response.headers }); }
function methodNotAllowed(allow: string): Response { return new Response("Method not allowed", { status: 405, headers: { allow } }); }
function notFound(): Response { return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } }); }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] as string); }
function time(value: number | null): string { return value === null ? "Never" : new Date(value).toISOString(); }
async function json(response: Response): Promise<unknown> { try { return await response.json(); } catch { return undefined; } }
function arrayField(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function record(value: unknown): Record<string, unknown> | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }

