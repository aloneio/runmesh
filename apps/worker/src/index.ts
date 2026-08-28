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

export { RegistryDO, RunnerDO };

const MAX_ADMIN_BODY_BYTES = 16_384;
const ADMIN_SESSION_COOKIE = "__Host-runmesh_admin_session";
const ADMIN_CSRF_COOKIE = "__Host-runmesh_admin_csrf";
const SETUP_CSRF_COOKIE = "__Host-runmesh_setup_csrf";
const LOGIN_CSRF_COOKIE = "__Host-runmesh_login_csrf";
const MCP_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

export interface RunnerReleaseDescriptor {
  readonly channel: "stable";
  readonly current_version: string;
  readonly latest_version: string;
  readonly package_name: string;
  readonly package_version: string;
  readonly package_spec: string;
  readonly artifacts: Readonly<Record<"linux-x64" | "linux-arm64" | "darwin-x64" | "darwin-arm64" | "windows-x64", { readonly url: string; readonly sha256: string }>> | null;
  /** Backward-compatible source/checksum view for the configured package. */
  readonly artifact: { readonly source: string; readonly checksum?: { readonly algorithm: "sha256"; readonly value: string } } | null;
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
  if (url.pathname === "/runner/install.sh") return runnerInstallScript(request, url);
  if (url.pathname === "/runner/install.ps1") return runnerInstallPowerShell(request, url);
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
  return env.ASSETS.fetch(request);
}

export interface RunnerReleaseEnvironment {
  /** @deprecated Hosted bootstrap is unavailable in v0.1.0-dev.2; this value is ignored. */
  readonly RUNNER_PACKAGE_SPEC?: string;
  /** @deprecated Hosted bootstrap is unavailable in v0.1.0-dev.2; this value is ignored. */
  readonly ALLOW_LEGACY_UNSIGNED_BOOTSTRAP?: string;
  /** @deprecated Hosted bootstrap is unavailable in v0.1.0-dev.2; this value is ignored. */
  readonly RUNNER_PACKAGE_NAME?: string;
  /** @deprecated Hosted bootstrap is unavailable in v0.1.0-dev.2; this value is ignored. */
  readonly RUNNER_PACKAGE_VERSION?: string;
  /** @deprecated Hosted bootstrap is unavailable in v0.1.0-dev.2; this value is ignored. */
  readonly RUNNER_ARTIFACT_SHA256?: string;
  /** @deprecated Hosted bootstrap is unavailable in v0.1.0-dev.2; this value is ignored. */
  readonly RUNNER_ARTIFACTS_JSON?: string;
}

/**
 * Hosted distribution is deliberately unavailable for this preview. Legacy
 * environment variables remain type-compatible only and cannot make a release
 * descriptor distributable because the generated installers always fail closed.
 */
export function runnerReleaseDescriptor(_env: RunnerReleaseEnvironment): RunnerReleaseDescriptor & { readonly distributable: boolean } {
  return {
    channel: "stable", package_name: "", package_version: "", package_spec: "", current_version: "", latest_version: "", artifact: null, artifacts: null,
    distributable: false, protocol: { min_version: PROTOCOL_MIN_VERSION, max_version: PROTOCOL_CURRENT_VERSION },
  };
}
function runnerRelease(request: Request, env: WorkerEnv): Response {
  if (request.method !== "GET" && request.method !== "HEAD") { void discardBody(request); return methodNotAllowed("GET, HEAD"); }
  const descriptor = runnerReleaseDescriptor(env);
  return new Response(JSON.stringify({ ...descriptor, schema_version: 1, published_at: null }), { headers: publicInstallerHeaders("application/json; charset=utf-8") });
}
function runnerInstallScript(request: Request, _url: URL): Response {
  if (request.method !== "GET" && request.method !== "HEAD") { void discardBody(request); return methodNotAllowed("GET, HEAD"); }
  const content = `#!/usr/bin/env sh
set -eu
printf '%s\n' \
  'error: Hosted bootstrap is not available in this development preview.' \
  'Download and verify the portable Runner artifact, then use coding-runner enroll and coding-runner install.' >&2
exit 1
`;
  return new Response(content, { headers: publicInstallerHeaders("text/x-shellscript; charset=utf-8") });
}
function runnerInstallPowerShell(request: Request, _url: URL): Response {
  if (request.method !== "GET" && request.method !== "HEAD") { void discardBody(request); return methodNotAllowed("GET, HEAD"); }
  const content = `$ErrorActionPreference = 'Stop'
Write-Error 'Hosted bootstrap is not available in this development preview. Download and verify the portable Runner artifact, then use coding-runner enroll and coding-runner install.'
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
  const length = request.headers.get("content-length"); if (length !== null && (!/^\d+$/.test(length) || Number(length) > 4_096)) { await discardBody(request); return undefined; }
  const body = typeof request.body === "undefined" ? undefined : await request.text();
  if (body !== undefined && new TextEncoder().encode(body).byteLength > 4_096) return undefined;
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
  const clientDetail = /^\/admin\/clients\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/.exec(url.pathname);
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
    return client === undefined ? adminError(404, "MCP client was not found.") : html(await clientDetailPage(env, client, runners, overrides as Record<string, unknown>[], csrf));
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
    return runner === undefined ? adminError(404, "Runner was not found.") : html(runnerDetailPage(runner, workspaces, jobs, environment, csrf, releaseResponse));
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
  return runnerEnrollmentPage(baseUrl, runnerId, await createEnrollmentCode(env, runnerId), String(form.get("csrf_token") ?? ""));
}
async function handleBrowserRunnerAction(env: WorkerEnv, form: FormData, baseUrl: string, runnerId: string, action: "rename" | "rotate" | "revoke" | "delete" | "enrollment" | "permissions" | "version-policy" | "emergency-lock" | "workspace-create" | "workspace-update" | "workspace-delete"): Promise<Response> {
  if (action === "version-policy") {
    const updateChannel = form.get("update_channel"); const desired = form.get("desired_runner_version");
    if ((updateChannel !== "stable" && updateChannel !== "pinned") || (typeof desired !== "string" && desired !== null)) return adminError(400, "Runner update policy is invalid.");
    const descriptor = runnerReleaseDescriptor(env);
    const payload = {
      update_channel: updateChannel,
      ...(updateChannel === "pinned" && typeof desired === "string" && desired.length > 0 ? { desired_runner_version: desired } : {}),
      ...(updateChannel === "stable" && descriptor.distributable && validRunnerVersion(descriptor.package_version) ? { latest_runner_version: descriptor.package_version } : {}),
    };
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
    const canFence = runnerResponse.ok && Number(runner?.connection_epoch ?? 0) > 0 && typeof runner?.session_id === "string" && runner?.policy_status === "applied" && typeof runner?.applied_policy_revision === "number" && typeof runner?.active_policy_checksum === "string";
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
    return runnerEnrollmentPage(baseUrl, runnerId, await createEnrollmentCode(env, runnerId), String(form.get("csrf_token") ?? ""), true);
  }
  return runnerEnrollmentPage(baseUrl, runnerId, await createEnrollmentCode(env, runnerId), String(form.get("csrf_token") ?? ""), true);
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
  if (isFullHostPath(rootPath) && form.get("confirm_full_host") !== "true") return adminError(400, "Full Host Workspace requires explicit confirmation.");
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
  "Create administrator password": "创建管理员密码",
  "Setup token": "初始化令牌",
  "Password": "密码",
  "Confirm password": "确认密码",
  "Initialize": "初始化",
  "Admin password": "管理员密码",
  "Login": "登录",
  "Main navigation": "主导航",
  "Dashboard": "仪表盘",
  "Runners": "Runner",
  "MCP Clients": "MCP 客户端",
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
  "Policy is recorded for operators; package download, update, and rollback remain deferred.": "策略会记录给操作员；包下载、更新和回滚仍为延期能力。",
  "Hosted distribution is not configured. Portable artifact/manual version management only.": "尚未配置托管分发；仅支持便携制品和手动版本管理。",
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
  "Enabled": "启用",
  "Disabled": "禁用",
  "Allow": "允许",
  "Deny": "拒绝",
  "Save workspace": "保存工作区",
  "Create workspace": "创建工作区",
  "Delete workspace": "删除工作区",
  "Manual portable-artifact enrollment": "手动便携制品注册",
  "Enroll Runner manually": "手动注册 Runner",
  "Hosted installers are disabled in this development preview. Download and verify the portable Runner artifact first. This one-time code expires in 30 minutes and will not be shown again.": "此开发预览版已禁用托管安装器。请先下载并校验便携 Runner 制品。此一次性代码将在 30 分钟后过期，且不会再次显示。",
  "Operating system": "操作系统",
  "Copy enrollment command": "复制注册命令",
  "Do not share this code. It is single-use enrollment material, not an administrator password, MCP secret, or long-term credential.": "不要分享此代码。它是一次性注册材料，不是管理员密码、MCP 密钥或长期凭据。",
  "Regenerate enrollment": "重新生成注册",
  "Done": "完成",
  "MCP client created": "MCP 客户端已创建",
  "MCP client rotated": "MCP 客户端已轮换",
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
};

function languageSwitch(): string { return `<div class="language-switch" data-no-i18n aria-label="Language"><a href="?lang=en" data-lang-toggle="en" hreflang="en">EN</a><a href="?lang=zh-CN" data-lang-toggle="zh-CN" hreflang="zh-CN">中文</a></div>`; }

function setupPage(): Response { const csrf = randomBase64Url(); return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/assets/favicon.png" type="image/png"><title>Runmesh · Agent Control Plane setup</title>${adminStyles()}</head><body class="auth-body">${languageSwitch()}<main class="auth-shell"><section class="auth-card"><p class="brand-kicker">Runmesh</p><h1>Welcome to Runmesh</h1><p class="subtitle">Agent Control Plane</p><p class="lede">Create administrator password</p><form method="post" action="/setup" class="stack"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>Setup token <input type="password" name="setup_token" autocomplete="one-time-code" required></label><label>Password <input type="password" name="password" autocomplete="new-password" required minlength="12"></label><label>Confirm password <input type="password" name="confirm_password" autocomplete="new-password" required minlength="12"></label><button>Initialize</button></form></section></main>${adminScript()}</body></html>`, [`${SETUP_CSRF_COOKIE}=${csrf}; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=${Math.floor(SETUP_CSRF_TTL_MS / 1_000)}`]); }
function loginPage(): Response { const csrf = randomBase64Url(); return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/assets/favicon.png" type="image/png"><title>Runmesh · Agent Control Plane login</title>${adminStyles()}</head><body class="auth-body">${languageSwitch()}<main class="auth-shell"><section class="auth-card"><p class="brand-kicker">Runmesh</p><h1>Runmesh</h1><p class="subtitle">Agent Control Plane</p><form method="post" action="/login" class="stack"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>Admin password <input type="password" name="password" autocomplete="current-password" required></label><button>Login</button></form></section></main>${adminScript()}</body></html>`, [`${LOGIN_CSRF_COOKIE}=${csrf}; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=${Math.floor(SETUP_CSRF_TTL_MS / 1_000)}`]); }
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
  const overrideRows = runners.map((runner) => {
    const override = overrides.find((item) => item.runner_id === runner.runner_id);
    const permissions = record(override?.permissions);
    return `<tr><td>${escapeHtml(runner.display_name)}</td><td>${override === undefined ? "Use global" : "Additional restriction"}</td><td colspan="4"><form method="post" action="/admin/clients/${encodeURIComponent(clientId)}/${override === undefined ? "override" : "override"}" class="form-grid"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input type="hidden" name="runner_id" value="${escapeHtml(runner.runner_id)}">${permissionSelect("read", permissions?.read === true)}${permissionSelect("edit", permissions?.edit === true)}${permissionSelect("shell", permissions?.shell === true)}${permissionSelect("job_control", permissions?.job_control === true)}<button class="small secondary">Save restriction</button>${override === undefined ? "" : `<button class="small danger" formaction="/admin/clients/${encodeURIComponent(clientId)}/reset-override">Reset</button>`}</form></td></tr>`;
  }).join("");
  const scopeValues = Array.isArray(client.scopes) ? client.scopes.filter((scope): scope is string => typeof scope === "string") : [];
  const scopeEditor = `<form method="post" action="/admin/clients/${encodeURIComponent(clientId)}/scopes" class="form-grid"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><fieldset><legend>Base scopes</legend>${scopeCheckboxes(scopeValues)}</fieldset><button class="button secondary">Save scopes</button></form>`;
  return `<section class="page-heading"><div><p class="eyebrow">MCP Client detail</p><h1>${escapeHtml(label)}</h1><p class="lede">Runner-specific access can only further restrict the client's global scopes; it can never grant additional access.</p></div><a class="button secondary" href="/admin/clients">Back to clients</a></section><section class="panel"><h2>Global permissions</h2><p class="muted scope-line">${escapeHtml(scopeValues.join(", "))}</p>${scopeEditor}</section><section class="panel"><h2>Client access on each Runner</h2><p class="muted">Use Global means no additional restriction. Effective access is still limited by Runner and Workspace policy.</p><div class="table-wrap"><table><thead><tr><th>Runner</th><th>Mode</th><th colspan="4">Additional restriction</th></tr></thead><tbody>${overrideRows || `<tr><td colspan="6" class="empty">No runners registered.</td></tr>`}</tbody></table></div></section>`;
}
function adminPage(pathname: string, data: AdminData, csrf: string): string {
  const active = pathname === "/admin" ? "dashboard" : pathname.slice("/admin/".length);
  const nav = `<nav aria-label="Main navigation"><a class="${active === "dashboard" ? "active" : ""}" href="/admin">Dashboard</a><a class="${active === "runners" ? "active" : ""}" href="/admin/runners">Runners</a><a class="${active === "clients" ? "active" : ""}" href="/admin/clients">MCP Clients</a><a class="${active === "settings" ? "active" : ""}" href="/admin/settings">Settings</a></nav>`;
  const body = active === "runners" ? runnersPage(data, csrf) : active === "clients" ? clientsPage(data, csrf) : active === "settings" ? settingsPage(csrf) : overviewPage(data, csrf);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/assets/favicon.png" type="image/png"><link rel="preload" href="/assets/logo.png" as="image" type="image/png"><title>${escapeHtml(active[0]?.toUpperCase() ?? "Dashboard")} · Runmesh · Agent Control Plane</title>${adminStyles()}</head><body class="ops-body"><div class="shell"><header class="topbar"><a class="brand" href="/admin"><img src="/assets/logo.png" alt="Runmesh · Agent Control Plane" class="brand-logo"><span class="brand-copy"><span>Runmesh</span><small>Agent Control Plane</small></span></a><div class="top-actions">${languageSwitch()}<a class="button secondary" href="/admin/runners#add-runner">Add Runner</a><a class="button" href="/admin/clients#add-client">Add MCP Client</a></div></header>${nav}<main class="workspace">${body}</main></div>${adminScript()}</body></html>`;
}
function overviewPage(data: AdminData, csrf: string): string {
  const online = data.runners.filter((runner) => runner.state === "online").length;
  const activeJobs = data.jobs.filter((job) => ["queued", "running", "cancelling"].includes(String(job.status))).length;
  return `<section class="page-heading"><div><p class="eyebrow">Control plane</p><h1>Dashboard</h1><p class="lede">A concise view of connected runtimes, clients, and recent work.</p></div><a class="button secondary" href="/admin">Refresh</a></section><section class="metrics" aria-label="Summary"><div class="metric"><span>Active MCP clients</span><strong>${data.clients.filter((client) => client.revoked_at_ms === null).length}</strong></div><div class="metric"><span>Online / total runners</span><strong>${online} / ${data.runners.length}</strong></div><div class="metric"><span>Running jobs</span><strong>${activeJobs}</strong></div><div class="metric"><span>Recent jobs</span><strong>${data.jobs.length}</strong></div></section><div class="grid-two"><section class="panel"><div class="section-title"><h2>Recent runners</h2><a href="/admin/runners">View all</a></div>${runnerList(data.runners.slice(0, 5))}</section><section class="panel"><div class="section-title"><h2>Recent MCP clients</h2><a href="/admin/clients">View all</a></div>${clientList(data.clients.slice(0, 5))}</section></div><section class="panel"><div class="section-title"><h2>Recent jobs</h2><a href="/admin/runners">Runner activity</a></div>${jobTable(data.jobs.slice(0, 10))}</section><form class="hidden" method="post" action="/admin/logout"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"></form>`;
}
function runnersPage(data: AdminData, csrf: string): string {
  const table = data.runners.map((runner) => `<tr><td><a class="strong" href="/admin/runners/${encodeURIComponent(runner.runner_id)}">${escapeHtml(runner.display_name)}</a><small>${escapeHtml(runner.runner_id)}</small></td><td>${statusBadge(runner.state)}</td><td>${escapeHtml(safePlatform(runner))}</td><td>${runnerWorkspaceCount(runner)}</td><td>${runnerActiveJobs(runner)}</td><td>${escapeHtml(time(runner.last_heartbeat_ms))}</td><td class="actions"><a class="button small secondary" href="/admin/runners/${encodeURIComponent(runner.runner_id)}">View</a><form method="post" action="/admin/runners/${encodeURIComponent(runner.runner_id)}/rename"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input name="display_name" value="${escapeHtml(runner.display_name)}" aria-label="Rename ${escapeHtml(runner.display_name)}" maxlength="256"><button class="small secondary">Rename</button></form><form method="post" action="/admin/runners/${encodeURIComponent(runner.runner_id)}/rotate"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="small secondary">Rotate Credential</button></form><form method="post" action="/admin/runners/${encodeURIComponent(runner.runner_id)}/revoke"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>Type Runner ID to confirm<input name="confirmation" pattern="[A-Za-z0-9][A-Za-z0-9._:-]*" required></label><button class="small danger">Revoke</button></form><form method="post" action="/admin/runners/${encodeURIComponent(runner.runner_id)}/delete"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>Type Runner ID to confirm<input name="confirmation" pattern="[A-Za-z0-9][A-Za-z0-9._:-]*" required></label><button class="small danger">Delete</button></form><form method="post" action="/admin/runners/${encodeURIComponent(runner.runner_id)}/enrollment"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="small secondary">Install / Reinstall</button></form></td></tr>`).join("") || `<tr><td colspan="7" class="empty">No runners yet.</td></tr>`;
  return `<section class="page-heading"><div><p class="eyebrow">Infrastructure</p><h1>Runners</h1><p class="lede">Manage safe runner metadata and one-time enrollment.</p></div></section><section class="panel" id="add-runner"><div class="section-title"><h2>Add Runner</h2><span class="muted">Enrollment codes expire after 30 minutes.</span></div><form method="post" action="/admin/runners" class="form-grid"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>Display name<input name="display_name" maxlength="256" required autocomplete="off"></label><label>Safe runner ID <span class="muted">optional</span><input name="runner_id" maxlength="128" pattern="[A-Za-z0-9][A-Za-z0-9._:-]*" placeholder="generated-id"></label><button class="button">Create enrollment</button></form></section><section class="panel"><div class="table-wrap"><table><caption class="sr-only">Registered runners</caption><thead><tr><th>Display name</th><th>Status</th><th>Platform / architecture</th><th>Workspaces</th><th>Active jobs</th><th>Last seen</th><th>Actions</th></tr></thead><tbody>${table}</tbody></table></div></section>`;
}
function activeRunnerLabel(client: McpClientRecord, runners: readonly RunnerRecord[]): string { const runner = client.active_runner_id === null ? undefined : runners.find((item) => item.runner_id === client.active_runner_id); return runner === undefined ? "Not selected" : runner.display_name; }
function clientsPage(data: AdminData, csrf: string): string {
  const rows = data.clients.map((client) => `<tr><td><a class="strong" href="/admin/clients/${encodeURIComponent(client.client_id)}">${escapeHtml(client.label)}</a><small>${escapeHtml(client.client_id)}</small></td><td>${escapeHtml(client.scopes.join(", "))}</td><td>${escapeHtml(activeRunnerLabel(client, data.runners))}</td><td>${escapeHtml(time(client.last_used_at_ms))}</td><td>${client.revoked_at_ms === null ? statusBadge("online") : statusBadge("offline")}</td><td class="actions"><form method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/rename"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input name="label" value="${escapeHtml(client.label)}" aria-label="Rename ${escapeHtml(client.label)}" maxlength="256"><button class="small secondary">Rename</button></form>${client.revoked_at_ms === null ? `<form method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/rotate"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="small secondary">Rotate</button></form>` : ""}<form method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/reset-runner"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="small secondary">Reset Runner Selection</button></form>${client.revoked_at_ms === null ? `<form method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/revoke"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="small danger">Revoke</button></form>` : ""}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">No MCP clients yet.</td></tr>`;
  return `<section class="page-heading"><div><p class="eyebrow">Integrations</p><h1>MCP Clients</h1><p class="lede">Manage labels, scopes, runner routing, and one-time client secrets.</p></div></section><section class="panel" id="add-client"><div class="section-title"><h2>Add MCP Client</h2></div><form method="post" action="/admin/clients" class="form-grid"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>Label<input name="label" maxlength="256" required></label><fieldset><legend>Scopes</legend>${scopeCheckboxes()}</fieldset><button class="button">Create one-time secret</button></form></section><section class="panel"><div class="table-wrap"><table><caption class="sr-only">MCP clients</caption><thead><tr><th>Label</th><th>Scopes</th><th>Active runner</th><th>Last used</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}
function settingsPage(csrf: string): string { return `<section class="page-heading"><div><p class="eyebrow">Workspace administration</p><h1>Settings</h1><p class="lede">Keep operator notes here; credentials and secrets are never displayed.</p></div></section><div class="grid-two"><section class="panel"><h2>Change password</h2><form method="post" action="/admin/password" class="stack"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>Current password<input type="password" name="current_password" required autocomplete="current-password"></label><label>New password<input type="password" name="password" minlength="12" required autocomplete="new-password"></label><label>Confirm new password<input type="password" name="confirm_password" minlength="12" required autocomplete="new-password"></label><button class="button">Change password</button></form></section><section class="panel danger-panel"><h2>Operator notes</h2><p class="muted">Deployment notes belong in your deployment system. This dashboard intentionally stores no notes or secrets.</p><form method="post" action="/admin/logout" class="stack"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="button secondary">Log out</button></form></section></div>`; }
function runnerList(runners: readonly RunnerRecord[]): string { return runners.length === 0 ? `<p class="empty">No runners yet.</p>` : `<ul class="item-list">${runners.map((runner) => `<li><a href="/admin/runners/${encodeURIComponent(runner.runner_id)}"><span class="strong">${escapeHtml(runner.display_name)}</span><small>${statusBadge(runner.state)} · ${escapeHtml(safePlatform(runner))}</small></a></li>`).join("")}</ul>`; }
function clientList(clients: readonly McpClientRecord[]): string { return clients.length === 0 ? `<p class="empty">No MCP clients yet.</p>` : `<ul class="item-list">${clients.map((client) => `<li><span><span class="strong">${escapeHtml(client.label)}</span><small>${client.active_runner_id === null ? "Not selected" : escapeHtml(client.active_runner_id)} · ${client.revoked_at_ms === null ? "Active" : "Revoked"}</small><form class="hidden" method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/rename"><input name="label" value="${escapeHtml(client.label)}"></form></span></li>`).join("")}</ul>`; }
function jobTable(jobs: readonly Record<string, unknown>[]): string { return jobs.length === 0 ? `<p class="empty">No recent jobs.</p>` : `<div class="table-wrap"><table><thead><tr><th>Job</th><th>Workspace</th><th>Status</th><th>Updated</th></tr></thead><tbody>${jobs.map((job) => { const status = String(job.status ?? "unknown"); return `<tr><td class="mono">${escapeHtml(String(job.job_id ?? "unknown"))}</td><td>${escapeHtml(String(job.workspace_id ?? "unknown"))}</td><td><span class="badge job-status ${escapeHtml(status)}">${escapeHtml(status)}</span></td><td>${escapeHtml(time(typeof job.updated_at_ms === "number" ? job.updated_at_ms : null))}</td></tr>`; }).join("")}</tbody></table></div>`; }
function statusBadge(state: string): string { const safe = ["online", "offline", "stale", "pending", "invalid"].includes(state) ? state : "offline"; return `<span class="badge ${safe}">${safe}</span>`; }
function safePlatform(runner: RunnerRecord): string { return runner.public_info === null ? "Not enrolled" : `${runner.public_info.platform} / ${runner.public_info.architecture}`; }
function runnerWorkspaceCount(runner: RunnerRecord): string { const value = (runner as RunnerRecord & { workspace_count?: unknown }).workspace_count; return typeof value === "number" ? String(value) : "—"; }
function runnerActiveJobs(runner: RunnerRecord): string { const value = (runner as RunnerRecord & { active_job_count?: unknown }).active_job_count; return typeof value === "number" ? String(value) : "—"; }
function scopeCheckboxes(selected: readonly string[] = ["coding:read", "coding:write", "coding:exec"]): string { return ["coding:read", "coding:write", "coding:exec"].map((scope) => `<label class="check"><input type="checkbox" name="scopes" value="${scope}"${selected.includes(scope) ? " checked" : ""}> ${scope}</label>`).join(""); }
function runnerDetailPage(runner: Record<string, unknown>, workspaces: readonly unknown[], jobs: readonly unknown[], environment: Record<string, unknown> | undefined, csrf: string, release: RunnerReleaseDescriptor & { readonly distributable: boolean }): string {
  const runnerId = typeof runner.runner_id === "string" ? runner.runner_id : "unknown";
  const displayName = typeof runner.display_name === "string" ? runner.display_name : runnerId;
  const state = typeof runner.state === "string" ? runner.state : "offline";
  const publicInfo = record(runner.public_info);
  const tools = record(environment?.tools);
  const toolRows = tools === undefined ? `<p class="muted">Environment details unavailable while offline.</p>` : `<div class="tool-grid">${Object.entries(tools).map(([name, value]) => { const item = record(value); return `<div><strong>${escapeHtml(name)}</strong><span>${item?.available === true ? `Available${typeof item.version === "string" ? ` · ${escapeHtml(item.version)}` : ""}` : "Unavailable"}</span></div>`; }).join("")}</div>`;
  const policyStatus = runner.policy_status === "applied" || runner.policy_status === "invalid" ? runner.policy_status : "pending";
  const workspaceRows = workspaces.map((workspace) => managedWorkspaceForm(runnerId, record(workspace), csrf)).join("") || `<li class="muted">No managed workspaces configured.</li>`;
  const updateChannel = runner.update_channel === "pinned" ? "pinned" : "stable";
  const currentVersion = typeof runner.current_runner_version === "string" ? runner.current_runner_version : typeof publicInfo?.runner_version === "string" ? publicInfo.runner_version : "Unknown";
  const latestVersion = typeof runner.latest_runner_version === "string" ? runner.latest_runner_version : release.distributable ? release.latest_version : "Not configured";
  const distributionNotice = release.distributable ? "" : `<p class="muted">Hosted distribution is not configured. Portable artifact/manual version management only.</p>`;
  const desiredVersion = typeof runner.desired_runner_version === "string" ? runner.desired_runner_version : "";
  const protocolCompatibility = runner.protocol_compatibility === "compatible" || runner.protocol_compatibility === "incompatible" ? runner.protocol_compatibility : "unknown";
  const protocolRange = `${String(runner.protocol_min_version ?? "Unknown")}–${String(runner.protocol_max_version ?? "Unknown")}`;
  const permissions = record(runner.runner_permissions);
  const desiredRevision = typeof runner.desired_policy_revision === "number" ? String(runner.desired_policy_revision) : "0";
  const appliedRevision = typeof runner.applied_policy_revision === "number" ? String(runner.applied_policy_revision) : "—";
  return `<section class="page-heading"><div><p class="eyebrow">Runner details</p><h1>${escapeHtml(displayName)}</h1><p class="lede">Control-plane workspace roots appear only in this authenticated administrator view.</p></div><a class="button secondary" href="/admin/runners">Back to runners</a></section><div class="metrics"><div class="metric"><span>Status</span><strong>${statusBadge(state)}</strong></div><div class="metric"><span>Runner ID</span><strong class="mono">${escapeHtml(runnerId)}</strong></div><div class="metric"><span>Policy status</span><strong>${escapeHtml(policyStatus)} · ${escapeHtml(appliedRevision)} / ${escapeHtml(desiredRevision)}</strong></div><div class="metric"><span>Last seen</span><strong>${escapeHtml(time(typeof runner.last_heartbeat_ms === "number" ? runner.last_heartbeat_ms : null))}</strong></div></div><div class="grid-two"><section class="panel"><h2>Safe metadata</h2><dl class="details"><dt>Platform</dt><dd>${escapeHtml(typeof publicInfo?.platform === "string" ? publicInfo.platform : "Unknown")}</dd><dt>Architecture</dt><dd>${escapeHtml(typeof publicInfo?.architecture === "string" ? publicInfo.architecture : "Unknown")}</dd><dt>Hostname</dt><dd>${escapeHtml(typeof publicInfo?.hostname === "string" ? publicInfo.hostname : "Unknown")}</dd><dt>Runner version</dt><dd>${escapeHtml(currentVersion)}</dd><dt>Stable/latest version</dt><dd>${escapeHtml(latestVersion)}</dd><dt>Protocol compatibility</dt><dd>${escapeHtml(protocolRange)} · ${escapeHtml(protocolCompatibility)}</dd></dl></section><section class="panel"><h2>Version policy</h2><p class="muted">Policy is recorded for operators; package download, update, and rollback remain deferred.</p>${distributionNotice}<form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/version-policy" class="form-grid"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>Channel<select name="update_channel"><option value="stable"${updateChannel === "stable" ? " selected" : ""}>Stable</option><option value="pinned"${updateChannel === "pinned" ? " selected" : ""}>Pinned</option></select></label><label>Desired version<input name="desired_runner_version" value="${escapeHtml(desiredVersion)}" placeholder="1.2.3" pattern="[0-9]+\\.[0-9]+\\.[0-9]+"></label><div><strong>Current</strong><span>${escapeHtml(currentVersion)}</span></div><div><strong>Latest</strong><span>${escapeHtml(latestVersion)}</span></div><button class="button">Save version policy</button></form><p class="muted">Status: ${escapeHtml(String(runner.update_status ?? "unknown"))}</p></section><section class="panel"><h2>Environment tools</h2>${toolRows}</section></div><div class="grid-two"><section class="panel"><h2>Runner permission profile</h2><p class="muted">Changes remain pending until the connected Runner validates and applies the revision.</p>${permissionForm(runnerId, permissions, csrf)}<form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/emergency-lock" class="stack"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>Type the Runner ID to confirm emergency lock<input name="confirmation" pattern="[A-Za-z0-9][A-Za-z0-9._:-]*" required></label><p class="muted">Emergency Lock does not automatically stop existing Jobs.</p><button class="button danger">Emergency lock all permissions</button></form></section><section class="panel"><h2>Active jobs</h2>${jobTable(jobs.filter(record) as Record<string, unknown>[])}</section></div><section class="panel"><div class="section-title"><h2>Managed workspaces</h2><span class="muted">Each save increments the desired policy revision.</span></div><ul class="plain-list">${workspaceRows}</ul><h3>Add workspace</h3>${managedWorkspaceForm(runnerId, undefined, csrf)}</section>`;
}
function permissionForm(runnerId: string, permissions: Record<string, unknown> | undefined, csrf: string): string {
  const current = (name: string): boolean => permissions?.[name] === true;
  return `<form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/permissions" class="form-grid"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">${permissionSelect("read", current("read"))}${permissionSelect("edit", current("edit"))}${permissionSelect("shell", current("shell"))}${permissionSelect("job_control", current("job_control"))}<button class="button">Save profile</button></form>`;
}
function permissionSelect(name: string, selected: boolean): string { return `<label>${escapeHtml(name.replaceAll("_", " "))}<select name="${escapeHtml(name)}"><option value="true"${selected ? " selected" : ""}>Allow</option><option value="false"${selected ? "" : " selected"}>Deny</option></select></label>`; }
function managedWorkspaceForm(runnerId: string, workspace: Record<string, unknown> | undefined, csrf: string): string {
  const existing = typeof workspace?.workspace_id === "string";
  const workspaceId = existing ? workspace?.workspace_id as string : "";
  const displayName = typeof workspace?.display_name === "string" ? workspace.display_name : "";
  const rootPath = typeof workspace?.root_path === "string" ? workspace.root_path : "";
  const permissions = record(workspace?.permissions);
  const current = (name: string): boolean => permissions?.[name] === true;
  const enabled = workspace?.enabled !== false;
  const status = typeof workspace?.validation_status === "string" ? workspace.validation_status : "pending";
  return `<li class="workspace-card"><form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/${existing ? "workspace-update" : "workspace-create"}" class="form-grid"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>Workspace ID<input name="workspace_id" value="${escapeHtml(workspaceId)}" ${existing ? "readonly" : "required"} maxlength="128"></label><label>Display name<input name="display_name" value="${escapeHtml(displayName)}" required maxlength="256"></label><label>Absolute root path<input name="root_path" value="${escapeHtml(rootPath)}" required maxlength="4096"></label><label>Usage profile<select name="profile"><option value="custom">Custom</option><option value="read_only">Read Only</option><option value="coding">Coding</option></select></label><label>Full-host confirmation<input type="hidden" name="confirm_full_host" value="false"><input type="checkbox" name="confirm_full_host" value="true"> I understand this exposes the full host filesystem.</label><label>Enabled<select name="enabled"><option value="true"${enabled ? " selected" : ""}>Enabled</option><option value="false"${enabled ? "" : " selected"}>Disabled</option></select></label>${permissionSelect("read", current("read"))}${permissionSelect("edit", current("edit"))}${permissionSelect("shell", current("shell"))}${permissionSelect("job_control", current("job_control"))}<button class="button">${existing ? "Save workspace" : "Create workspace"}</button></form>${existing ? `<div class="top-actions"><span class="muted">Validation: ${escapeHtml(status)}</span><form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/workspace-delete"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input type="hidden" name="workspace_id" value="${escapeHtml(workspaceId)}"><label>Type Workspace ID to confirm<input name="confirmation" pattern="[A-Za-z0-9][A-Za-z0-9._:-]*" required></label><button class="small danger">Delete workspace</button></form></div>` : ""}</li>`;
}
function adminStyles(): string { return `<style>
:root{
  color-scheme:dark;
  --ink:#f1f5f9;
  --ink-heading:#ffffff;
  --muted:#94a3b8;
  --muted-dark:#64748b;
  --line:#1e293b;
  --line-light:#334155;
  --panel:#0f172a;
  --panel-card:#131d33;
  --panel-elevated:#1e293b;
  --canvas:#090d16;
  --brand:#3ee0c5;
  --brand-hover:#5eead4;
  --brand-dim:#134e48;
  --brand-ink:#04221c;
  --danger:#f43f5e;
  --danger-ink:#ffe4e6;
  --danger-bg:#31121d;
  --danger-line:#881337;
  --warn:#fbbf24;
  --warn-bg:#2a1e09;
  --warn-line:#78350f;
  --ok:#34d399;
  --ok-bg:#062d22;
  --ok-line:#065f46;
  --shadow-sm:0 2px 4px rgba(0,0,0,0.3);
  --shadow-md:0 10px 25px -5px rgba(0,0,0,0.4),0 8px 10px -6px rgba(0,0,0,0.4);
  --shadow-lg:0 20px 35px -8px rgba(0,0,0,0.5),0 12px 16px -8px rgba(0,0,0,0.4);
  --glow-brand:0 0 0 1px rgba(62,224,197,0.35),0 0 20px rgba(62,224,197,0.18);
  --glow-subtle:0 0 0 1px rgba(255,255,255,0.08),0 4px 20px rgba(0,0,0,0.35);
  --radius-sm:6px;
  --radius-md:10px;
  --radius-lg:14px;
  --radius-xl:18px;
  --font-sans:"IBM Plex Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --font-mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;
}
*{box-sizing:border-box}
html,body{min-height:100%}
body{
  margin:0;
  background-color:var(--canvas);
  background-image:
    radial-gradient(1100px 550px at 5% -5%, rgba(19, 78, 72, 0.4) 0%, transparent 60%),
    radial-gradient(900px 480px at 95% -5%, rgba(30, 41, 59, 0.7) 0%, transparent 55%),
    linear-gradient(180deg, #0b111e 0%, var(--canvas) 100%);
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
    linear-gradient(rgba(62, 224, 197, 0.028) 1px, transparent 1px),
    linear-gradient(90deg, rgba(62, 224, 197, 0.028) 1px, transparent 1px);
  background-size:40px 40px;
  mask-image:linear-gradient(180deg, #000 0%, rgba(0,0,0,0.6) 40%, transparent 85%);
  z-index:0;
}
.ops-body,.auth-body{position:relative;min-height:100vh}
.shell{
  max-width:1440px;
  margin:auto;
  padding:0 32px 64px;
  position:relative;
  z-index:1;
}
.workspace{padding-top:8px}

/* Topbar & Branding */
.topbar{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:24px;
  padding:22px 0 20px;
  border-bottom:1px solid var(--line);
}
.brand{
  color:var(--ink-heading);
  font-size:17px;
  font-weight:700;
  letter-spacing:0.02em;
  text-decoration:none;
  display:inline-flex;
  align-items:center;
  gap:13px;
}
.brand-copy{display:flex;flex-direction:column;line-height:1.15}
.brand-copy span{font-size:18px;font-weight:760;letter-spacing:-0.01em;color:var(--ink-heading)}
.brand-copy small{
  margin:4px 0 0;
  font-size:11px;
  font-weight:600;
  letter-spacing:0.14em;
  text-transform:uppercase;
  color:var(--muted);
}
.brand-logo{
  display:block;
  width:38px;
  height:38px;
  object-fit:contain;
  border-radius:var(--radius-md);
  background:#090d16;
  border:1px solid var(--line-light);
  box-shadow:var(--glow-brand);
  padding:2px;
}
.top-actions,.actions{display:flex;align-items:center;flex-wrap:wrap;gap:10px}
.actions form{
  display:flex;
  flex-wrap:wrap;
  gap:8px;
  align-items:center;
  padding:6px 8px;
  border:1px solid var(--line);
  border-radius:var(--radius-md);
  background:rgba(15, 23, 42, 0.7);
}

/* Language Switcher */
.language-switch{
  display:inline-flex;
  align-items:center;
  gap:2px;
  padding:3px;
  border:1px solid var(--line);
  border-radius:999px;
  background:rgba(15, 23, 42, 0.8);
  backdrop-filter:blur(8px);
}
.language-switch a{
  min-width:38px;
  padding:4px 10px;
  border-radius:999px;
  color:var(--muted);
  font-size:11.5px;
  font-weight:680;
  letter-spacing:0.02em;
  text-align:center;
  text-decoration:none;
  transition:all 0.15s ease;
}
.language-switch a:hover{color:var(--ink-heading);background:rgba(51, 65, 85, 0.6)}
.language-switch a[aria-current=true]{
  color:var(--brand-ink);
  background:var(--brand);
  box-shadow:0 0 12px rgba(62,224,197,0.3);
}
.auth-body>.language-switch,.ops-body>.language-switch{
  position:fixed;
  top:20px;
  right:20px;
  z-index:10;
}

/* Navigation */
nav{
  display:flex;
  gap:4px;
  margin:22px 0 30px;
  padding:4px;
  background:rgba(15, 23, 42, 0.75);
  border:1px solid var(--line);
  border-radius:var(--radius-lg);
  backdrop-filter:blur(8px);
  width:fit-content;
  max-width:100%;
}
nav a{
  padding:8px 16px;
  color:var(--muted);
  text-decoration:none;
  border-radius:var(--radius-md);
  font-weight:650;
  font-size:13px;
  letter-spacing:0.01em;
  transition:all 0.14s ease;
}
nav a:hover{color:var(--ink-heading);background:rgba(51, 65, 85, 0.5)}
nav a.active{
  color:var(--brand-ink);
  background:var(--brand);
  box-shadow:0 0 14px rgba(62,224,197,0.35);
}

/* Typography & Headings */
h1,h2,h3{
  line-height:1.2;
  margin:0 0 8px;
  color:var(--ink-heading);
  letter-spacing:-0.025em;
}
h1{font-size:30px;font-weight:750}
h2{font-size:16.5px;font-weight:700;letter-spacing:-0.015em}
h3{font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;font-weight:700}
.page-heading{
  display:flex;
  justify-content:space-between;
  align-items:flex-start;
  gap:24px;
  margin-bottom:26px;
}
.eyebrow,.brand-kicker{
  color:var(--brand);
  font-size:11px;
  font-weight:750;
  letter-spacing:0.14em;
  text-transform:uppercase;
  margin:0 0 8px;
}
.lede,.muted,.subtitle{color:var(--muted)}
.lede,.subtitle{margin:0 0 14px;max-width:64ch;font-size:14px;line-height:1.55}

/* Metrics Dashboard Grid */
.metrics{
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:16px;
  margin-bottom:28px;
}
.metric,.panel,.auth-card,.enrollment-dialog{
  background:var(--panel);
  border:1px solid var(--line);
  border-radius:var(--radius-xl);
  box-shadow:var(--shadow-md);
  position:relative;
}
.metric{
  padding:20px 22px 18px;
  overflow:hidden;
  background-image:linear-gradient(180deg, rgba(30, 41, 59, 0.35) 0%, rgba(15, 23, 42, 0.8) 100%);
  border-color:rgba(51, 65, 85, 0.5);
  transition:border-color 0.15s ease,transform 0.15s ease;
}
.metric:hover{
  border-color:rgba(62, 224, 197, 0.3);
  transform:translateY(-1px);
}
.metric::after{
  content:"";
  position:absolute;
  inset:auto 0 0;
  height:2px;
  background:linear-gradient(90deg, transparent 0%, var(--brand) 50%, transparent 100%);
  opacity:0.8;
}
.metric span{
  display:block;
  color:var(--muted);
  font-size:11.5px;
  font-weight:680;
  letter-spacing:0.07em;
  text-transform:uppercase;
  margin-bottom:10px;
}
.metric strong{
  font-size:27px;
  font-weight:750;
  letter-spacing:-0.03em;
  color:var(--ink-heading);
}

/* Panels & Layout Grids */
.grid-two{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin-bottom:28px}
.panel{
  padding:24px;
  margin-bottom:28px;
  background-image:linear-gradient(180deg, rgba(30, 41, 59, 0.25) 0%, rgba(15, 23, 42, 0.7) 100%);
}
.danger-panel{
  border-color:var(--danger-line);
  background-image:linear-gradient(180deg, rgba(136, 19, 55, 0.25) 0%, rgba(15, 23, 42, 0.8) 100%);
}
.section-title{
  display:flex;
  justify-content:space-between;
  gap:14px;
  align-items:center;
  margin-bottom:18px;
  padding-bottom:4px;
}
.section-title h2{margin:0}
.section-title a{
  color:var(--brand);
  font-weight:680;
  font-size:13px;
  text-decoration:none;
  transition:color 0.12s ease;
}
.section-title a:hover{color:var(--brand-hover);text-decoration:underline}

/* Tables */
.table-wrap{
  overflow-x:auto;
  border:1px solid var(--line);
  border-radius:var(--radius-lg);
  background:rgba(11, 17, 30, 0.85);
  box-shadow:inset 0 1px 1px rgba(255,255,255,0.03);
}
table{border-collapse:collapse;width:100%;min-width:760px;font-size:13.5px}
th,td{text-align:left;padding:13px 16px;border-bottom:1px solid var(--line);vertical-align:middle}
th{
  color:var(--muted);
  font-size:11px;
  font-weight:700;
  text-transform:uppercase;
  letter-spacing:0.08em;
  background:rgba(15, 23, 42, 0.95);
  border-bottom:1px solid var(--line-light);
}
tbody tr{transition:background-color 0.12s ease}
tbody tr:hover{background:rgba(30, 41, 59, 0.4)}
tr:last-child td{border-bottom:0}
.strong{font-weight:700;color:var(--ink-heading);text-decoration:none}
a.strong:hover{color:var(--brand);text-decoration:underline}
small{display:block;color:var(--muted);font-size:12px;margin-top:3px;font-family:var(--font-mono)}

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
  font-weight:700;
  letter-spacing:0.01em;
  padding:8px 16px;
  text-decoration:none;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  gap:6px;
  transition:all 0.14s ease;
  min-height:36px;
}
.button:hover,button:hover{
  background:var(--brand-hover);
  border-color:var(--brand-hover);
  transform:translateY(-1px);
  box-shadow:var(--glow-brand);
}
.button.secondary,button.secondary{
  background:rgba(30, 41, 59, 0.4);
  color:var(--ink);
  border-color:var(--line-light);
}
.button.secondary:hover,button.secondary:hover{
  background:rgba(51, 65, 85, 0.6);
  border-color:var(--brand);
  color:var(--brand);
  box-shadow:0 0 12px rgba(62,224,197,0.18);
}
.button.small,button.small{
  font-size:12px;
  font-weight:650;
  padding:5px 10px;
  min-height:28px;
  border-radius:var(--radius-sm);
}
.button.copied,button.copied{
  background:var(--ok);
  border-color:var(--ok);
  color:#04221c;
  box-shadow:0 0 12px rgba(52,211,153,0.35);
}
.danger{
  color:var(--danger-ink)!important;
  border-color:var(--danger-line)!important;
  background:var(--danger-bg)!important;
}
.danger:hover{
  border-color:var(--danger)!important;
  box-shadow:0 0 0 1px rgba(244,63,94,0.4),0 0 16px rgba(244,63,94,0.25)!important;
}

/* Badges & Status */
.badge,.job-status{
  border-radius:999px;
  display:inline-flex;
  align-items:center;
  font-size:11px;
  font-weight:750;
  padding:3px 10px;
  text-transform:capitalize;
  letter-spacing:0.04em;
  border:1px solid transparent;
  line-height:1.2;
}
.badge.online,.job-status.running{
  background:var(--ok-bg);
  color:var(--ok);
  border-color:var(--ok-line);
  box-shadow:0 0 8px rgba(52,211,153,0.15);
}
.badge.offline{
  background:rgba(30, 41, 59, 0.6);
  color:var(--muted);
  border-color:var(--line-light);
}
.badge.stale,.badge.pending,.job-status.queued,.job-status.cancelling{
  background:var(--warn-bg);
  color:var(--warn);
  border-color:var(--warn-line);
}
.badge.invalid,.job-status.failed{
  background:var(--danger-bg);
  color:var(--danger);
  border-color:var(--danger-line);
}
.job-status.succeeded,.job-status.completed{
  background:var(--ok-bg);
  color:var(--ok);
  border-color:var(--ok-line);
}

/* Forms & Inputs */
.form-grid{
  display:grid;
  grid-template-columns:repeat(4,minmax(0,1fr));
  align-items:end;
  gap:16px;
}
label{
  display:flex;
  flex-direction:column;
  gap:6px;
  font-weight:650;
  font-size:12.5px;
  color:var(--ink);
}
input,select,textarea{
  border:1px solid var(--line-light);
  border-radius:var(--radius-md);
  padding:9px 12px;
  font:inherit;
  font-size:13.5px;
  color:var(--ink-heading);
  min-width:0;
  background:rgba(9, 13, 22, 0.85);
  transition:border-color 0.14s ease,box-shadow 0.14s ease;
}
input:hover,select:hover{border-color:#475569}
input:focus,select:focus{
  outline:none;
  border-color:var(--brand);
  box-shadow:0 0 0 3px rgba(62,224,197,0.2);
}
fieldset{
  border:1px solid var(--line);
  border-radius:var(--radius-md);
  padding:10px 14px;
  margin:0;
  background:rgba(9, 13, 22, 0.5);
}
legend{
  padding:0 6px;
  color:var(--muted);
  font-size:11px;
  font-weight:700;
  letter-spacing:0.08em;
  text-transform:uppercase;
}
.check{
  display:inline-flex;
  flex-direction:row;
  align-items:center;
  font-weight:500;
  font-size:13px;
  margin:4px 14px 4px 0;
  cursor:pointer;
}
.check input{min-width:auto;accent-color:var(--brand);cursor:pointer}
.stack{display:flex;flex-direction:column;gap:16px;max-width:520px}

/* Lists & Details */
.item-list,.plain-list{list-style:none;padding:0;margin:0}
.item-list li{border-bottom:1px solid var(--line);padding:12px 0}
.item-list li:last-child{border:0}
.item-list a{
  display:block;
  text-decoration:none;
  border-radius:var(--radius-md);
  padding:6px 10px;
  margin:0 -10px;
  transition:background-color 0.12s ease;
}
.item-list a:hover{background:rgba(30, 41, 59, 0.5)}
.empty{
  color:var(--muted);
  padding:32px 16px;
  text-align:center;
  border:1px dashed var(--line-light);
  border-radius:var(--radius-lg);
  background:rgba(15, 23, 42, 0.4);
}
.details{
  display:grid;
  grid-template-columns:160px 1fr;
  gap:12px 16px;
  margin:0;
  font-size:13.5px;
}
.details dt{
  color:var(--muted);
  font-size:11.5px;
  font-weight:680;
  text-transform:uppercase;
  letter-spacing:0.07em;
}
.details dd{margin:0;font-weight:650;color:var(--ink-heading);overflow-wrap:anywhere}
.tool-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.tool-grid div{
  border:1px solid var(--line);
  border-radius:var(--radius-md);
  padding:14px;
  background:rgba(9, 13, 22, 0.6);
}
.tool-grid strong{color:var(--ink-heading);font-size:13.5px}
.tool-grid span{display:block;color:var(--muted);font-size:12.5px;margin-top:4px}
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
.workspace-card{
  border:1px solid var(--line);
  border-radius:var(--radius-lg);
  padding:18px;
  margin-bottom:16px;
  background:rgba(9, 13, 22, 0.7);
  box-shadow:inset 0 1px 1px rgba(255,255,255,0.02);
}
.scope-line{font-family:var(--font-mono);font-size:13px;color:var(--brand)}

/* Auth / Full-Page Cards */
.auth-body{
  display:grid;
  place-items:center;
  min-height:100vh;
  padding:40px 20px;
}
.auth-shell{width:min(480px,100%)}
.auth-card{
  padding:36px 32px 32px;
  box-shadow:var(--shadow-lg);
  background-image:linear-gradient(180deg, rgba(30, 41, 59, 0.4) 0%, rgba(15, 23, 42, 0.9) 100%);
}
.brand-kicker{margin-bottom:6px}
.secret-url,.secret-card code{
  display:block;
  overflow-wrap:anywhere;
  padding:14px;
  border-radius:var(--radius-md);
  background:#090d16;
  border:1px solid var(--line-light);
  color:var(--brand);
  margin:0 0 20px;
}
.error-card{border-color:var(--danger-line)}
.enrollment-shell{padding-top:48px;padding-bottom:64px}
.enrollment-dialog{
  display:block;
  width:min(940px,100%);
  margin:0 auto;
  padding:32px;
  color:inherit;
  border:1px solid var(--line-light);
  box-shadow:var(--shadow-lg);
}
.tabs{display:flex;flex-wrap:wrap;gap:8px;margin:20px 0}
.tabs [role=tab]{
  background:rgba(15, 23, 42, 0.8);
  color:var(--muted);
  border:1px solid var(--line-light);
  border-radius:999px;
  padding:7px 16px;
  font-weight:650;
  font-size:12.5px;
}
.tabs [role=tab][aria-selected=true]{
  color:var(--brand-ink);
  background:var(--brand);
  border-color:var(--brand);
  box-shadow:0 0 14px rgba(62,224,197,0.3);
}
.tabs [role=tabpanel]{flex:1 1 100%;margin-top:10px}
pre{
  overflow:auto;
  padding:16px;
  border-radius:var(--radius-lg);
  background:#070b12;
  border:1px solid var(--line-light);
  color:#99f6e4;
  font-family:var(--font-mono);
  font-size:13px;
  line-height:1.5;
}
.warning{
  border:1px solid var(--warn-line);
  background:var(--warn-bg);
  color:var(--warn);
  border-radius:var(--radius-md);
  padding:12px 16px;
  font-size:13px;
}
:focus-visible{
  outline:2px solid var(--brand);
  outline-offset:2px;
}

/* Responsive Breakpoints & Accessibility */
@media(prefers-reduced-motion: reduce){
  *,*::before,*::after{
    animation-duration:0.01ms!important;
    animation-iteration-count:1!important;
    transition-duration:0.01ms!important;
    scroll-behavior:auto!important;
  }
  .button:hover,button:hover,.metric:hover{
    transform:none!important;
  }
}
@media(max-width:800px){
  .shell{padding:0 18px 40px}
  .topbar,.page-heading{align-items:stretch;flex-direction:column}
  .brand{align-self:flex-start}
  .top-actions{width:100%}
  .top-actions .button{flex:1;text-align:center}
  nav{overflow-x:auto;width:100%;margin-bottom:24px}
  .metrics,.grid-two,.form-grid{grid-template-columns:1fr 1fr}
  .panel,.auth-card{padding:18px}
  .actions{min-width:210px}
  .tool-grid,.details{grid-template-columns:1fr}
  h1{font-size:26px}
}
@media(max-width:480px){
  .metrics,.grid-two,.form-grid{grid-template-columns:1fr}
  h1{font-size:24px}
  nav a{padding:8px 12px}
}
</style>`; }
function adminScript(): string { return `<script>var ZH_UI_TEXT=${JSON.stringify(ZH_UI_TEXT)};function translateTextNodes(root){var walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode:function(node){if(!node.nodeValue||!node.nodeValue.trim())return NodeFilter.FILTER_REJECT;for(var el=node.parentElement;el;el=el.parentElement){if(el.hasAttribute('data-no-i18n')||el.tagName==='CODE'||el.tagName==='PRE'||el.tagName==='SCRIPT'||el.tagName==='STYLE'||el.tagName==='INPUT'||el.tagName==='TEXTAREA')return NodeFilter.FILTER_REJECT}return NodeFilter.FILTER_ACCEPT}});var nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);nodes.forEach(function(node){var text=node.nodeValue||'';var trimmed=text.trim();var mapped=ZH_UI_TEXT[trimmed];if(text.indexOf('coding:')>=0)return;if(mapped)node.nodeValue=text.replace(trimmed,mapped);else Object.keys(ZH_UI_TEXT).sort(function(a,b){return b.length-a.length}).forEach(function(key){if(node.nodeValue&&node.nodeValue.indexOf(key)>=0)node.nodeValue=node.nodeValue.split(key).join(ZH_UI_TEXT[key])})})}function translateAttributes(root){['aria-label','alt','placeholder','title'].forEach(function(name){root.querySelectorAll('['+name+']').forEach(function(element){if(element.closest('[data-no-i18n]'))return;var value=element.getAttribute(name)||'';Object.keys(ZH_UI_TEXT).sort(function(a,b){return b.length-a.length}).forEach(function(key){if(value.indexOf(key)>=0)value=value.split(key).join(ZH_UI_TEXT[key])});element.setAttribute(name,value)})})}function applyLocale(locale){var zh=locale==='zh-CN';document.documentElement.lang=zh?'zh-CN':'en';document.querySelectorAll('[data-lang-toggle]').forEach(function(item){var active=item.getAttribute('data-lang-toggle')===locale;item.setAttribute('aria-current',active?'true':'false')});if(zh){translateTextNodes(document.body);translateAttributes(document);var title=document.title;Object.keys(ZH_UI_TEXT).sort(function(a,b){return b.length-a.length}).forEach(function(key){if(title.indexOf(key)>=0)title=title.split(key).join(ZH_UI_TEXT[key])});document.title=title}}function requestedLocale(){var query=new URLSearchParams(location.search).get('lang');if(query==='zh-CN'||query==='zh')return 'zh-CN';if(query==='en')return 'en';var match=/runmesh_lang=(zh-CN|en)/.exec(document.cookie||'');if(match)return match[1];return navigator.language&&navigator.language.toLowerCase().startsWith('zh')?'zh-CN':'en'}function rememberLocale(locale){document.cookie='runmesh_lang='+locale+'; Max-Age=31536000; Path=/; SameSite=Lax'}document.querySelectorAll('[data-lang-toggle]').forEach(function(link){link.addEventListener('click',function(event){var locale=link.getAttribute('data-lang-toggle')||'en';rememberLocale(locale);if(locale==='zh-CN'&&new URLSearchParams(location.search).get('lang')!=='zh-CN'){event.preventDefault();var url=new URL(location.href);url.searchParams.set('lang','zh-CN');location.href=url.toString()}else if(locale==='en'&&new URLSearchParams(location.search).has('lang')){event.preventDefault();var url=new URL(location.href);url.searchParams.set('lang','en');location.href=url.toString()}})});var locale=requestedLocale();if(new URLSearchParams(location.search).has('lang'))rememberLocale(locale);applyLocale(locale);function copyText(text){if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text);return}var area=document.createElement('textarea');area.value=text;area.setAttribute('readonly','');area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();document.execCommand('copy');area.remove()}document.querySelectorAll('[data-copy]').forEach(function(button){button.addEventListener('click',function(){copyText(button.getAttribute('data-copy')||'');button.textContent=document.documentElement.lang==='zh-CN'?'已复制':'Copied';button.classList.add('copied')})});document.querySelectorAll('[data-tab]').forEach(function(tab){tab.addEventListener('click',function(){var target=tab.getAttribute('data-tab');document.querySelectorAll('[data-tab]').forEach(function(item){item.setAttribute('aria-selected',String(item===tab));item.tabIndex=item===tab?0:-1});document.querySelectorAll('[data-panel]').forEach(function(panel){panel.hidden=panel.getAttribute('data-panel')!==target})});tab.addEventListener('keydown',function(event){if(event.key==='ArrowLeft'||event.key==='ArrowRight'){var tabs=Array.prototype.slice.call(document.querySelectorAll('[data-tab]'));var next=tabs[(tabs.indexOf(tab)+(event.key==='ArrowRight'?1:tabs.length-1))%tabs.length];next.focus();next.click()}})});</script>`; }
function runnerEnrollmentPage(baseUrl: string, runnerId: string, code: string | undefined, csrf: string, _reEnroll = false): Response {
  if (code === undefined) return adminError(503, "Enrollment code could not be generated.");
  const enroll = `coding-runner enroll --server ${new URL("/runner/enroll", baseUrl).toString()} --code ${code}`;
  const command = `${enroll}\ncoding-runner install`;
  const tabs = Object.entries({ linux: command, macos: command, windows: command }).map(([platform, value], index) => `<button role="tab" id="tab-${platform}" aria-controls="panel-${platform}" aria-selected="${index === 0 ? "true" : "false"}" tabindex="${index === 0 ? "0" : "-1"}" data-tab="${platform}">${platform === "macos" ? "macOS" : platform === "windows" ? "Windows" : "Linux"}</button><section role="tabpanel" id="panel-${platform}" aria-labelledby="tab-${platform}" ${index === 0 ? "" : "hidden"} data-panel="${platform}"><pre><code>${escapeHtml(value)}</code></pre><button type="button" class="button secondary" data-copy="${escapeHtml(enroll)}">Copy enrollment command</button></section>`).join("");
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Runmesh · Agent Control Plane enrollment</title>${adminStyles()}</head><body class="ops-body">${languageSwitch()}<main class="shell enrollment-shell"><dialog open aria-labelledby="enrollment-title" class="enrollment-dialog"><section class="page-heading"><div><p class="eyebrow">Manual portable-artifact enrollment</p><h1 id="enrollment-title">Enroll Runner manually</h1><p class="lede">Hosted installers are disabled in this development preview. Download and verify the portable Runner artifact first. This one-time code expires in 30 minutes and will not be shown again.</p></div></section><p class="muted">Runner: <span class="mono">${escapeHtml(runnerId)}</span></p><div role="tablist" aria-label="Operating system" class="tabs">${tabs}</div><p class="warning">Do not share this code. It is single-use enrollment material, not an administrator password, MCP secret, or long-term credential.</p><div class="top-actions"><form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/enrollment"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="button secondary">Regenerate enrollment</button></form><a class="button" href="/admin/runners">Done</a></div></dialog></main>${adminScript()}</body></html>`);
}
function secretCreatedPage(title: string, url: string): string { return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/assets/favicon.png" type="image/png"><title>${escapeHtml(title)}</title>${adminStyles()}</head><body class="auth-body">${languageSwitch()}<main class="auth-shell"><section class="auth-card secret-card"><p class="brand-kicker">Runmesh</p><h1>${escapeHtml(title)}</h1><p class="lede">Copy this URL now. It will not be shown again.</p><code>${escapeHtml(url)}</code><p><a class="button" href="/admin">Back to admin</a></p></section></main>${adminScript()}</body></html>`; }
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
    const existingRecord = existing ? record(await json(existingResponse)) : undefined;
    const canFenceExisting = existing && Number(existingRecord?.connection_epoch ?? 0) > 0 && typeof existingRecord?.session_id === "string" && existingRecord?.policy_status === "applied" && typeof existingRecord?.applied_policy_revision === "number" && typeof existingRecord?.active_policy_checksum === "string";
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
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/assets/favicon.png" type="image/png"><title>Runmesh · Agent Control Plane</title>${adminStyles()}</head><body class="auth-body">${languageSwitch()}<main class="auth-shell"><section class="auth-card error-card"><p class="brand-kicker">Runmesh</p><h1>Runmesh</h1><p class="subtitle">Agent Control Plane</p><p class="lede">Invalid administrator password.</p><p class="muted">Please try again shortly.</p><p><a class="button secondary" href="/">Return</a></p></section></main>${adminScript()}</body></html>`, { status: 403, headers });
}
async function formData(request: Request): Promise<FormData | undefined> { const length = request.headers.get("content-length"); if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_ADMIN_BODY_BYTES)) { await discardBody(request); return undefined; } try { const form = await request.formData(); let size = 0; for (const [key, value] of form) { if (typeof value !== "string") return undefined; size += new TextEncoder().encode(key).byteLength + new TextEncoder().encode(value).byteLength; } return size <= MAX_ADMIN_BODY_BYTES ? form : undefined; } catch { return undefined; } }
async function readAdminBody(request: Request): Promise<Record<string, unknown> | undefined> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_ADMIN_BODY_BYTES)) { await discardBody(request); return undefined; }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_ADMIN_BODY_BYTES) return undefined;
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
function htmlHeaders(): Headers { return new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", "x-content-type-options": "nosniff", "x-frame-options": "DENY" }); }
function redirect(location: string, cookies: readonly string[] = []): Response { const headers = htmlHeaders(); headers.set("location", location); for (const cookie of cookies) headers.append("set-cookie", cookie); return new Response(null, { status: 303, headers }); }
function adminError(status: number, message: string, cookies: readonly string[] = []): Response { const response = html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/assets/favicon.png" type="image/png"><title>Runmesh · Agent Control Plane</title>${adminStyles()}</head><body class="auth-body">${languageSwitch()}<main class="auth-shell"><section class="auth-card error-card"><p class="brand-kicker">Runmesh</p><h1>Runmesh</h1><p class="subtitle">Agent Control Plane</p><p class="lede">${escapeHtml(message)}</p><p><a class="button secondary" href="/">Return</a></p></section></main>${adminScript()}</body></html>`, cookies.length === 0 ? [] : cookies); return new Response(response.body, { status, headers: response.headers }); }
function methodNotAllowed(allow: string): Response { return new Response("Method not allowed", { status: 405, headers: { allow } }); }
function notFound(): Response { return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } }); }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] as string); }
function time(value: number | null): string { return value === null ? "Never" : new Date(value).toISOString(); }
async function json(response: Response): Promise<unknown> { try { return await response.json(); } catch { return undefined; } }
function arrayField(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function record(value: unknown): Record<string, unknown> | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
