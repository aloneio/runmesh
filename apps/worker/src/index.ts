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
  containsControlCharacter,
  constantTimeEqual,
  generateRunnerToken,
  internalHeaders,
  isConfiguredSecret,
  isSafeIdentifier,
  passwordVerifier,
  randomBase64Url,
  runnerTokenVerifier,
  sha256Hex,
  verifyInternalRequest,
  verifySetupToken,
  verifyPassword,
} from "./security.js";
import { readCappedBytes, readCappedFormData, readCappedText as readBodyText } from "./body.js";
import { canonicalPublicOrigin, fixedReleaseDescriptor, powershellQuote, renderPosixInstaller, renderPowerShellInstaller, resolvePublicOrigin, shellQuote, signedReleaseIsAvailable, type FixedReleaseDescriptor } from "./installer.js";

export { RegistryDO, RunnerDO };

const MAX_ADMIN_BODY_BYTES = 16_384;
const MAX_INTERNAL_RPC_BODY_BYTES = 1_048_576;
// Match the SDK's documented maximum while enforcing it even when a client
// omits Content-Length (chunked request bodies must not reach request.json()
// unbounded).
const MAX_MCP_BODY_BYTES = 4 * 1024 * 1024;
const ADMIN_SESSION_COOKIE = "__Host-runmesh_admin_session";
const ADMIN_CSRF_COOKIE = "__Host-runmesh_admin_csrf";
const SETUP_CSRF_COOKIE = "__Host-runmesh_setup_csrf";
const LOGIN_CSRF_COOKIE = "__Host-runmesh_login_csrf";
const MCP_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
// Keep the brand asset behind one stable path so the final customer-supplied
// SVG can replace the working copy without touching any page templates.
const BRAND_LOGO_ASSET = "/assets/logo-transparent.svg";

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
  if (url.pathname === "/health") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      await discardBody(request);
      return methodNotAllowed("GET, HEAD");
    }
    return Response.json({ ok: true, service: "runmesh-agent-control-plane" });
  }
  if (url.pathname === "/assets/logo.png" || url.pathname === BRAND_LOGO_ASSET || url.pathname === "/assets/favicon.png") return asset(request, env);
  if (url.pathname === "/runner/install.sh") return runnerInstallScript(request, url, env);
  if (url.pathname === "/runner/install.ps1") return runnerInstallPowerShell(request, url, env);
  if (url.pathname === "/runner/releases/latest" || url.pathname === "/runner/releases/stable") return runnerRelease(request, env);
  // Public health/static/release probes remain available while provisioning,
  // but every control-plane route fails closed before attempting HMAC/WebCrypto
  // when the Worker↔Durable-Object secret is absent or empty.
  if (requiresInternalControl(url.pathname) && !isConfiguredSecret(env.INTERNAL_CONTROL_SECRET)) {
    await discardBody(request);
    return new Response("control plane is not configured", { status: 503, headers: { "cache-control": "no-store" } });
  }
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
  /** Canonical external HTTPS origin; required before hosted bootstrap is exposed. */
  readonly RUNMESH_PUBLIC_ORIGIN?: string;
}

export function runnerReleaseDescriptor(env: RunnerReleaseEnvironment): RunnerReleaseDescriptor {
  let originConfigured = false;
  try { originConfigured = env.RUNMESH_PUBLIC_ORIGIN !== undefined && canonicalPublicOrigin(env.RUNMESH_PUBLIC_ORIGIN).length > 0; } catch { originConfigured = false; }
  return { ...fixedReleaseDescriptor(signedReleaseIsAvailable(env.RUNMESH_SIGNED_RELEASE_AVAILABLE) && originConfigured), protocol: { min_version: PROTOCOL_MIN_VERSION, max_version: PROTOCOL_CURRENT_VERSION } };
}
function runnerRelease(request: Request, env: WorkerEnv): Response {
  if (request.method !== "GET" && request.method !== "HEAD") { void discardBody(request); return methodNotAllowed("GET, HEAD"); }
  const descriptor = runnerReleaseDescriptor(env);
  return new Response(JSON.stringify({ ...descriptor, schema_version: 1, published_at: null }), { headers: publicInstallerHeaders("application/json; charset=utf-8") });
}
function runnerInstallScript(request: Request, _url: URL, env: RunnerReleaseEnvironment): Response {
  if (request.method !== "GET" && request.method !== "HEAD") { void discardBody(request); return methodNotAllowed("GET, HEAD"); }
  const descriptor = runnerReleaseDescriptor(env);
  let content: string;
  if (descriptor.distributable) {
    try { content = renderPosixInstaller(resolvePublicOrigin(request, env.RUNMESH_PUBLIC_ORIGIN)); }
    catch { return installerOriginUnavailable(); }
  } else {
    content =
`#!/usr/bin/env sh
set -eu
printf '%s\\n' 'error: The fixed signed Runmesh v0.1.0-dev.2 release is not enabled on this deployment.' 'Use the manual verified portable-artifact route until the exact immutable release is available.' >&2
exit 1
`;
  }
  return new Response(content, { headers: publicInstallerHeaders("text/x-shellscript; charset=utf-8") });
}
function runnerInstallPowerShell(request: Request, _url: URL, env: RunnerReleaseEnvironment): Response {
  if (request.method !== "GET" && request.method !== "HEAD") { void discardBody(request); return methodNotAllowed("GET, HEAD"); }
  const descriptor = runnerReleaseDescriptor(env);
  let content: string;
  if (descriptor.distributable) {
    try { content = renderPowerShellInstaller(resolvePublicOrigin(request, env.RUNMESH_PUBLIC_ORIGIN)); }
    catch { return installerOriginUnavailable(); }
  } else {
    content = `$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Write-Error 'The fixed signed Runmesh v0.1.0-dev.2 release is not enabled on this deployment. Use the manual verified portable-artifact route until the exact immutable release is available.'
exit 1
`;
  }
  return new Response(content, { headers: publicInstallerHeaders("text/plain; charset=utf-8") });
}
function installerOriginUnavailable(): Response {
  return new Response("hosted installer is unavailable for this request origin", { status: 421, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" } });
}
function publicInstallerHeaders(contentType: string): Headers {
  return new Headers({ "content-type": contentType, "cache-control": "public, max-age=300", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "permissions-policy": "geolocation=(), microphone=(), camera=()" });
}
async function handleRunnerEnrollment(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method !== "POST") { await discardBody(request); return methodNotAllowed("POST"); }
  const input = await readEnrollmentBody(request);
  const code = typeof input?.enrollment_code === "string" && /^[A-Za-z0-9_-]{43}$/.test(input.enrollment_code) ? input.enrollment_code : undefined;
  const publicInfo = runnerPublicInfo(input?.runner_public_info);
  if (code === undefined || publicInfo === undefined || typeof env.RUNNER_TOKEN_PEPPER !== "string" || env.RUNNER_TOKEN_PEPPER.length === 0 || typeof env.INTERNAL_CONTROL_SECRET !== "string" || env.INTERNAL_CONTROL_SECRET.length === 0) return enrollmentError();
  // Resolve the endpoint that will be persisted before consuming the one-time
  // code. This prevents a successful enrollment from returning an attacker-
  // controlled or unusable reconnect URL when the request arrived through a
  // misconfigured proxy.
  let publicOrigin: string;
  try { publicOrigin = resolveConnectionOrigin(request, env.RUNMESH_PUBLIC_ORIGIN); } catch { return installerOriginUnavailable(); }
  const verifier = await sha256Hex(code);
  // Resolve the target before redeeming so the RunnerDO can acquire its
  // mutation fence. A direct redeem fallback would let an old socket remain
  // authorized while Registry advances the credential/epoch.
  let targetResponse: Response;
  try { targetResponse = await registryPost(env, "/enrollments/lookup", { verifier }); } catch { return enrollmentUnavailable(); }
  if (!targetResponse.ok) return targetResponse.status >= 500 ? enrollmentUnavailable() : enrollmentError();
  const target = record(await json(targetResponse));
  const runnerId = typeof target?.runner_id === "string" && isSafeIdentifier(target.runner_id) ? target.runner_id : undefined;
  if (runnerId === undefined) return enrollmentError();

  const mutationId = `credential-enrolled-${crypto.randomUUID()}`;
  let fenced: Response;
  try { fenced = await fenceRunnerTransport(env, runnerId, mutationId); } catch { return enrollmentUnavailable(); }
  if (!fenced.ok) return fenced.status === 409
    ? new Response("Runner credential mutation is already in progress", { status: 409, headers: credentialHeaders("text/plain; charset=utf-8") })
    : enrollmentUnavailable();

  const token = generateRunnerToken();
  let response: Response;
  try {
    response = await registryPost(env, "/enrollments/redeem", {
      verifier, token_verifier: await runnerTokenVerifier(token, env.RUNNER_TOKEN_PEPPER), runner_public_info: publicInfo, mutation_id: mutationId,
    });
  } catch {
    // A lost response may follow a committed Registry transaction. Consult the
    // durable mutation ledger; otherwise keep the Runner fenced and report
    // uncertainty rather than issuing an unverifiable credential.
    const state = await runnerMutationState(env, runnerId, mutationId).catch(() => undefined);
    if (state?.mutation_committed === true) { try { await revokeRunnerTransport(env, runnerId, mutationId); } catch { /* fail closed */ } }
    return enrollmentUnavailable();
  }
  if (!response.ok) {
    const state = await runnerMutationState(env, runnerId, mutationId).catch(() => undefined);
    if (state?.mutation_committed === true) {
      try { await revokeRunnerTransport(env, runnerId, mutationId); } catch { /* Registry credential is authoritative */ }
      return enrollmentUnavailable();
    }
    try {
      const cancelled = await cancelRunnerPolicyMutation(env, runnerId, mutationId);
      if (!cancelled.ok) return enrollmentUnavailable();
    } catch { return enrollmentUnavailable(); }
    return response.status >= 500 ? enrollmentUnavailable() : enrollmentError();
  }
  const body = record(await json(response));
  if (body?.runner_id !== runnerId) return enrollmentUnavailable();
  const committed = await runnerMutationState(env, runnerId, mutationId).catch(() => undefined);
  if (committed?.mutation_committed !== true) return enrollmentUnavailable();
  // Do not release a newly-issued credential while the RunnerDO cleanup is
  // uncertain.  Registry has committed the new generation, but an old
  // pre-hello socket may still be retained by this DO; returning the token
  // before revoke succeeds would hand out a credential while transport
  // admission is not known to be clean.  The mutation remains durably fenced
  // so a later retry/reconciliation can finish the cleanup.
  try { await revokeRunnerTransport(env, runnerId, mutationId); }
  catch { return enrollmentUnavailable(); }
  const connectUrl = new URL("/runner/connect", publicOrigin).toString();
  return Response.json({ runner_id: runnerId, server_url: connectUrl, token }, { headers: credentialHeaders("application/json; charset=utf-8") });
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
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 4_096)) { await discardBody(request); return undefined; }
  // Do not use request.text() here: when Content-Length is absent or forged it
  // buffers the entire stream before the size check, allowing an unauthenticated
  // enrollment request to consume unbounded Worker memory. The capped reader
  // enforces the limit while consuming the stream and cancels oversized bodies.
  const body = await readBodyText(request, 4_096);
  try { return record(body === undefined ? undefined : JSON.parse(body) as unknown); } catch { return undefined; }
}
function enrollmentError(): Response { return new Response("invalid enrollment", { status: 401, headers: credentialHeaders("text/plain; charset=utf-8") }); }
function enrollmentUnavailable(): Response { return new Response("enrollment service unavailable; Runner remains safely fenced", { status: 503, headers: credentialHeaders("text/plain; charset=utf-8") }); }

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
  let forwarded: Request;
  if (request.method === "POST") {
    const body = await readCappedBytes(request, MAX_MCP_BODY_BYTES);
    if (body === undefined) return new Response("request body too large", { status: 413, headers: publicInstallerHeaders("text/plain; charset=utf-8") });
    forwarded = new Request(rewritten, { method: request.method, headers: request.headers, body: body.buffer as ArrayBuffer });
  } else {
    forwarded = new Request(rewritten, request);
  }
  return handler.fetch(forwarded, { authInfo: auth });
}

function isMcpPath(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length === 2 && parts[1] === "mcp";
}

function requiresInternalControl(pathname: string): boolean {
  return pathname === "/"
    || pathname === "/setup"
    || pathname === "/login"
    || pathname === "/runner/enroll"
    || pathname === "/runner/connect"
    || pathname === "/admin"
    || pathname.startsWith("/admin/")
    || isMcpPath(pathname);
}

async function handleLanding(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  // A Registry outage or malformed status cannot be interpreted as
  // "not initialized"; doing so would expose setup UI during an outage.
  const statusResponse = await registryGet(env, "/auth/status");
  if (!statusResponse.ok) {
    await discardBody(request);
    return registryStatusUnavailable();
  }
  const initialized = record(await json(statusResponse));
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
  if (!await verifyPreAuthCsrf(request, form, LOGIN_CSRF_COOKIE, env)) return adminError(403, "Login request was rejected.");
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
  if (form === undefined || !await verifyAdminPost(request, form, session, env)) return adminError(403, "Administrative request was rejected.");
  // Generated enrollment/MCP URLs must use the deployment's canonical public
  // origin when configured. Local development intentionally has no config and
  // may use HTTP; copied manual commands still quote this derived origin.
  let publicOrigin: string;
  try {
    publicOrigin = resolveConnectionOrigin(request, env.RUNMESH_PUBLIC_ORIGIN);
  } catch { return installerOriginUnavailable(); }
  if (url.pathname === "/admin/logout") {
    await registryPost(env, "/auth/sessions/logout", { session_hash: session.hash });
    return redirect("/", [clearCookie(ADMIN_SESSION_COOKIE), clearCookie(ADMIN_CSRF_COOKIE)]);
  }
  if (url.pathname === "/admin/password") return changePassword(env, form);
  if (url.pathname === "/admin/clients") return createClient(env, form, publicOrigin);
  if (url.pathname === "/admin/runners") return createBrowserRunner(env, form, publicOrigin);
  const runnerMatch = /^\/admin\/runners\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/(rename|rotate|revoke|delete|enrollment|permissions|version-policy|emergency-lock|workspace-create|workspace-update|workspace-delete)$/.exec(url.pathname);
  if (runnerMatch !== null) return handleBrowserRunnerAction(env, form, publicOrigin, runnerMatch[1] as string, runnerMatch[2] as "rename" | "rotate" | "revoke" | "delete" | "enrollment" | "permissions" | "version-policy" | "emergency-lock" | "workspace-create" | "workspace-update" | "workspace-delete");
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
  return html(secretCreatedPage("MCP client rotated", secretUrl(publicOrigin, secret)));
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
  const mutationId = `runner-create-${crypto.randomUUID()}`;
  let existingResponse: Response;
  try { existingResponse = await runnerRegistryRequest(env, runnerId, "", "GET", ""); }
  catch { return adminError(503, "Runner creation could not read the Runner state."); }
  if (!existingResponse.ok && existingResponse.status !== 404) return adminError(503, "Runner creation could not read the Runner state.");
  // The Registry row may have been deleted while a RunnerDO still owns an
  // authenticated pre-hello socket. Acquire the DO fence before /add for both
  // a fresh ID and a reused ID; the mutation ledger below lets cleanup prove
  // that this exact creation committed.
  const fenced = await fenceRunnerTransport(env, runnerId, mutationId);
  if (!fenced.ok) return adminError(503, "Runner creation could not fence the Runner.");

  let response: Response;
  try { response = await runnerRegistryRequest(env, runnerId, "/add", "POST", JSON.stringify({ display_name: displayName, mutation_id: mutationId })); }
  catch { response = new Response("registry unavailable", { status: 503 }); }
  if (!response.ok) {
    const settled = await settleRunnerMutation(env, runnerId, mutationId, true);
    if (settled === "uncertain") return adminError(503, "Runner creation outcome is uncertain; Runner remains safely fenced.");
    return adminError(response.status >= 500 ? 503 : response.status === 409 ? 409 : 400, "Runner could not be added.");
  }
  const committed = await runnerMutationState(env, runnerId, mutationId).catch(() => undefined);
  if (committed?.mutation_committed !== true) return adminError(503, "Runner creation outcome is uncertain; Runner remains safely fenced.");
  const code = await createEnrollmentCode(env, runnerId);
  if (code === undefined) return adminError(503, "Runner enrollment code could not be created.");
  // /add creates an offline central row (credential_version 0), so revoke is
  // used here as a transport finalizer: it closes any stale sockets and clears
  // the fence without changing the central row or its enrollment semantics.
  // Keep the fence while creating the enrollment code; a concurrent delete or
  // rotation must not slip between finalization and code issuance.
  try { await revokeRunnerTransport(env, runnerId, mutationId, true); }
  catch { return adminError(503, "Runner creation cleanup is uncertain; Runner remains safely fenced."); }
  return runnerEnrollmentPage(env, baseUrl, runnerId, code, String(form.get("csrf_token") ?? ""));
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
          try {
            await deleteRunnerTransport(env, runnerId, mutationId);
            return redirect("/admin");
          } catch { return adminError(503, "Runner deletion outcome is uncertain; Runner remains safely fenced."); }
        }
        const cancelled = await cancelRunnerPolicyMutation(env, runnerId, mutationId);
        if (!cancelled.ok) return adminError(503, "Runner deletion failed; Runner remains safely fenced.");
      } catch { return adminError(503, "Runner deletion state is uncertain; Runner remains safely fenced."); }
      return adminError(response.status === 404 ? 404 : 400, "Runner delete failed.");
    }
    try {
      await deleteRunnerTransport(env, runnerId, mutationId);
      return redirect("/admin");
    } catch { return adminError(503, "Runner deletion outcome is uncertain; Runner remains safely fenced."); }
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
    try { await revokeRunnerTransport(env, runnerId, mutationId); }
    catch { return adminError(503, "Runner revocation cleanup is uncertain; Runner remains safely fenced."); }
    return redirect("/admin");
  }
  if (action === "rotate") {
    const mutationId = `credential-rotated-${crypto.randomUUID()}`;
    const runnerResponse = await runnerRegistryRequest(env, runnerId, "", "GET", "");
    if (!runnerResponse.ok && runnerResponse.status !== 404) return adminError(503, "Runner credential rotation could not read the Runner state.");
    // Registry state can lag a live RunnerDO/socket (for example after a
    // heartbeat timeout), and a 404 can race a concurrent recreate. Fence the
    // DO even when the initial row lookup is missing; this keeps a stale
    // pre-hello socket isolated if /rotate observes a newly-created row.
    const fenced = await fenceRunnerTransport(env, runnerId, mutationId);
    if (!fenced.ok) return adminError(503, "Runner credential rotation could not fence the Runner.");
    let response: Response;
    try { response = await runnerRegistryRequest(env, runnerId, "/rotate", "POST", JSON.stringify({ mutation_id: mutationId })); } catch { return adminError(503, "Runner credential rotation outcome is uncertain; Runner remains safely fenced."); }
    if (!response.ok) {
      if (![400, 404, 409].includes(response.status)) return adminError(503, "Runner credential rotation outcome is uncertain; Runner remains safely fenced.");
      try {
        const cancelled = await cancelRunnerPolicyMutation(env, runnerId, mutationId);
        if (!cancelled.ok) return adminError(503, "Runner credential rotation failed; Runner remains safely fenced.");
      } catch { return adminError(503, "Runner credential rotation state is uncertain; Runner remains safely fenced."); }
      return adminError(response.status === 404 ? 404 : 400, "Runner credential rotation failed.");
    }
    // Keep the credential mutation fence while issuing the one-time
    // enrollment code. Releasing it first would let a concurrent delete,
    // rotation, or reconnect race in and make the displayed code belong to a
    // different Runner generation.
    const code = await createEnrollmentCode(env, runnerId);
    if (code === undefined) return adminError(503, "Enrollment code could not be generated; Runner remains safely fenced.");
    try { await revokeRunnerTransport(env, runnerId, mutationId, true); }
    catch { return adminError(503, "Runner credential cleanup is uncertain; Runner remains safely fenced."); }
    return runnerEnrollmentPage(env, baseUrl, runnerId, code, String(form.get("csrf_token") ?? ""), true);
  }
  if (action === "enrollment") {
    // Enrollment-code regeneration does not change the credential generation,
    // but it is still a capability mutation. Hold the RunnerDO fence while
    // replacing the one-time code so a concurrent delete/rotate cannot make
    // the page describe a different lifecycle. Since no credential ledger
    // marker is committed by createEnrollmentCode, release this policy-style
    // fence with cancel rather than the credential-only /revoke finalizer.
    const mutationId = `runner-enrollment-${crypto.randomUUID()}`;
    let fenced: Response;
    try { fenced = await beginRunnerPolicyMutation(env, runnerId, mutationId); }
    catch { return adminError(503, "Runner enrollment could not fence the Runner."); }
    if (!fenced.ok) return adminError(503, "Runner enrollment could not fence the Runner.");
    let code: string | undefined;
    try { code = await createEnrollmentCode(env, runnerId); } catch { code = undefined; }
    // A failed/ambiguous Registry response may still have committed the
    // one-time code. Do not release the fence in that case: no code is shown,
    // and a later reconciliation can safely determine the outcome.
    if (code === undefined) return adminError(503, "Enrollment code creation is uncertain; Runner remains safely fenced.");
    try {
      const cancelled = await cancelRunnerPolicyMutation(env, runnerId, mutationId);
      if (!cancelled.ok) return adminError(503, "Enrollment code cleanup is uncertain; Runner remains safely fenced.");
    } catch { return adminError(503, "Enrollment code cleanup is uncertain; Runner remains safely fenced."); }
    return runnerEnrollmentPage(env, baseUrl, runnerId, code, String(form.get("csrf_token") ?? ""), true);
  }
  return adminError(404, "Runner enrollment action is not available.");
}
async function consumeInternalNonce(env: WorkerEnv, nonce: string, expiresAtMs: number): Promise<boolean> {
  const body = JSON.stringify({ nonce, expires_at_ms: expiresAtMs });
  const headers = await signedInternalHeaders(env, "POST", "/auth/internal-nonces", body);
  if (headers === undefined) return false;
  try {
    const response = await env.REGISTRY.get(env.REGISTRY.idFromName("registry")).fetch(
      new Request("https://registry.internal/auth/internal-nonces", { method: "POST", headers, body }),
    );
    return response.status === 204;
  } catch { return false; }
}

async function signedInternalHeaders(env: WorkerEnv, method: string, path: string, body: string): Promise<HeadersInit | undefined> {
  if (!isConfiguredSecret(env.INTERNAL_CONTROL_SECRET)) return undefined;
  try { return await internalHeaders(env.INTERNAL_CONTROL_SECRET, method, path, body); } catch { return undefined; }
}
function controlPlaneUnavailable(): Response {
  return new Response("control plane is not configured", { status: 503, headers: { "cache-control": "no-store" } });
}

async function registryRequest(env: WorkerEnv, path: string, method: string, body: string): Promise<Response> {
  const headers = await signedInternalHeaders(env, method, path, body);
  if (headers === undefined) return controlPlaneUnavailable();
  try {
    const init: RequestInit = { method, headers, ...(body.length === 0 || method === "GET" || method === "HEAD" ? {} : { body }) };
    return await env.REGISTRY.get(env.REGISTRY.idFromName("registry")).fetch(new Request(`https://registry.internal${path}`, init));
  } catch { return new Response("registry unavailable", { status: 503 }); }
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
async function verifyAdminPost(request: Request, form: FormData, session: { csrf_hash: string }, env: WorkerEnv): Promise<boolean> {
  if (!sameOrigin(request, env.RUNMESH_PUBLIC_ORIGIN)) return false;
  const supplied = form.get("csrf_token"); const cookie = cookieValue(request, ADMIN_CSRF_COOKIE);
  return typeof supplied === "string" && typeof cookie === "string" && constantTimeEqual(supplied, cookie) && constantTimeEqual(await sha256Hex(supplied), session.csrf_hash);
}
async function verifyPreAuthCsrf(request: Request, form: FormData, name: string, env: WorkerEnv): Promise<boolean> {
  if (!sameOrigin(request, env.RUNMESH_PUBLIC_ORIGIN)) return false;
  const supplied = form.get("csrf_token"); const cookie = cookieValue(request, name);
  return typeof supplied === "string" && typeof cookie === "string" && constantTimeEqual(supplied, cookie);
}
/**
 * Resolve the origin used for browser-generated links and CSRF checks. Hosted
 * deployments must configure a canonical HTTPS origin; local development may
 * use HTTP only on an explicit loopback address so an arbitrary Host header
 * can never become a persisted credential endpoint.
 */
function resolveConnectionOrigin(request: Request, configuredOrigin?: string): string {
  if (configuredOrigin !== undefined) return resolvePublicOrigin(request, configuredOrigin);
  let url: URL;
  try { url = new URL(request.url); } catch { throw new Error("request URL is malformed"); }
  if (url.protocol === "https:") return resolvePublicOrigin(request);
  if (url.protocol !== "http:" || url.username !== "" || url.password !== "" || !isLoopbackHostname(url.hostname)) throw new Error("an HTTPS or loopback HTTP origin is required");
  const hostHeader = request.headers.get("host");
  if (hostHeader !== null) {
    if (/^[\u0000-\u0020\u007f\\\/?#@]/u.test(hostHeader) || /[\u0000-\u0020\u007f\\\/?#@]/u.test(hostHeader)) throw new Error("request Host is malformed");
    let hostUrl: URL;
    try { hostUrl = new URL(`http://${hostHeader}`); } catch { throw new Error("request Host is malformed"); }
    if (hostUrl.username !== "" || hostUrl.password !== "" || hostUrl.pathname !== "/" || hostUrl.search !== "" || hostUrl.hash !== "" || !isLoopbackHostname(hostUrl.hostname) || normalizeHostname(hostUrl.hostname) !== normalizeHostname(url.hostname) || hostUrl.port !== url.port) throw new Error("request Host does not match the loopback origin");
  }
  return url.origin;
}
function normalizeHostname(value: string): string { return value.toLowerCase().replace(/^\[/, "").replace(/\]$/, ""); }
function isLoopbackHostname(value: string): boolean {
  const hostname = normalizeHostname(value);
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}
function sameOrigin(request: Request, configuredOrigin?: string): boolean {
  let origin: string;
  try { origin = resolveConnectionOrigin(request, configuredOrigin); } catch { return false; }
  const candidate = request.headers.get("origin") ?? request.headers.get("referer");
  if (candidate === null || candidate === "null") return true; // privacy browsers may submit Origin: null; the synchronizer token still remains mandatory.
  try { return new URL(candidate).origin === origin; } catch { return false; }
}

function registryStatusUnavailable(): Response {
  return new Response("control plane status unavailable", { status: 503, headers: { "cache-control": "no-store" } });
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
  "RUNMESH / CONTROL PLANE": "RUNMESH / 控制平面",
  "Runmesh network visualization": "Runmesh 网络可视化",
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
  "This command downloads the pinned Runmesh Runner release, verifies its manifest, signature, and checksum, enrolls this host, and installs the service. The one-time code expires in 30 minutes and will not be shown again.": "此命令会下载固定版本的 Runmesh Runner，并校验其清单、签名和 checksum，然后注册当前主机并安装服务。一次性代码将在 30 分钟后过期，且不会再次显示。",
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
  "Manual Runner enrollment and install": "手动注册并安装 Runner",
  "Enroll Runner manually": "手动注册 Runner",
  "Enroll Runner": "注册 Runner",
  "Target Runner ID": "目标 Runner ID",
  "One-time enrollment code": "一次性注册代码",
  "Hosted installers are disabled in this development preview. Download and verify the portable Runner artifact first. This one-time code expires in 30 minutes and will not be shown again.": "此开发预览版已禁用托管安装器。请先下载并校验便携 Runner 制品。此一次性代码将在 30 分钟后过期，且不会再次显示。",
  "The fixed signed hosted release is not enabled on this deployment. Install the verified portable Runner artifact first, then run the single-line command below. It will ask for this code locally; paste it and press Enter. The install step runs only after enrollment succeeds. This one-time code expires in 30 minutes and will not be shown again.": "当前部署未启用固定签名托管版本。请先安装已校验的便携 Runner 制品，再运行下面的单行命令。命令会在本地请求此代码；粘贴后按 Enter，只有注册成功才会继续安装。此一次性代码将在 30 分钟后过期，且不会再次显示。",
  "The installer verifies the fixed signed Runner artifact before it asks locally for this one-time code. It never places the code in this command, a URL, or process arguments. This one-time code expires in 30 minutes and will not be shown again.": "安装器会先校验固定签名的 Runner 制品，再在本地请求此一次性代码。代码不会放入此命令、URL 或进程参数中。此一次性代码将在 30 分钟后过期，且不会再次显示。",
  "Paste it only into the local prompt after verification; it is deliberately excluded from copied commands.": "请仅在完成校验后将其粘贴到本地提示中；代码不会包含在复制的命令里。",
  "Operating system": "操作系统",
  "Copy enrollment command": "复制注册命令",
  "Copy enrollment and install command": "复制注册并安装命令",
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
  "Read": "读取",
  "Write": "写入",
  "Exec": "执行",
  "Each base scope has a distinct ceiling: Read permits inspection, Write permits approved edits, and Exec permits Host shell and Job control. Runner and Workspace policy can only reduce these permissions.": "每个基础权限范围都有独立上限：Read 允许查看，Write 允许已批准的编辑，Exec 允许使用主机 Shell 和任务控制。Runner 与工作区策略只能收紧这些权限。",
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
  return `<img class="${className}" src="${BRAND_LOGO_ASSET}" alt="${escapeHtml(alt)}" width="1672" height="941" decoding="async">`;
}

function meshMarkSvg(className = "mesh-mark"): string {
  if (className === "header-mesh-mark") {
    return `<svg class="${className}" viewBox="100 230 1470 450" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Runmesh · Agent Control Plane">
      <path fill="#fd4a05" fill-rule="evenodd" d="M448.55 247.08c-13.4 3.3-22.16 15.69-21.38 30.25 1.16 21.6 22.43 34 41.63 24.27 17.65-8.94 20.61-34.37 5.54-47.6-7.06-6.2-17.42-8.98-25.8-6.92M333 296.61c-29.43 8.67-51.84 21.68-81 47.01-23.24 20.2-38.64 40.6-54.55 72.31-45.56 90.79-20.12 175.33 59.68 198.3 15.95 4.58 46 4.86 65.37.6 18.8-4.14 46.87-13.74 33.5-11.47-8.21 1.4-34.01 1.84-44.01.75-69.72-7.6-111.6-54.04-111.45-123.61.08-38.5 12.08-72.17 38.48-108 25.6-34.74 56.94-59.1 95.98-74.62 10.97-4.36 10.19-4.86-2-1.27m21 42.28c-1.37.44-6.77 3.72-12 7.27s-20.75 14.07-34.5 23.37l-31 20.98c-10.15 6.9-9.5 1.97-9.5 71.7 0 43.47.33 61.4 1.15 63.21 1.38 3.04 40.47 28.94 42.5 28.16.74-.28 1.35-1.1 1.36-1.8l.25-65.73.24-64.45 21.5-14.36c11.82-7.9 21.99-14.58 22.59-14.85 1.07-.47 38.82 21.48 45.16 26.26 2.35 1.77 3.25 3.25 3.25 5.34 0 2.64-2.07 4.3-24.95 19.96-13.73 9.39-25.65 18.07-26.5 19.29-1.28 1.81-1.55 5.8-1.55 22.42v20.2l4.25 3.4c5.46 4.38 59.53 40.15 65.37 43.26 3.6 1.9 4.96 2.17 7.16 1.35 2.97-1.1 32.35-25.64 32.96-27.54.32-1-31.88-23.6-52.99-37.17-3.71-2.39-6.75-4.66-6.75-5.04s10.33-7.63 22.97-16.1c28.32-19 26.05-14.98 25.99-45.79-.05-23.55-.68-28.05-4.52-32.3-1.61-1.78-33.38-21.84-44.94-28.38-2.75-1.55-12.54-7.3-21.76-12.75-16.58-9.82-20.88-11.48-25.74-9.91m263.12 17.47c-.82.99-1.06 19.54-.88 67.75l.26 66.39 16.75.27 16.75.28V446h18.75l18.75.01 6.1 8.25c3.35 4.53 10.74 14.65 16.41 22.49L720.33 491h19.83c10.91 0 19.84-.39 19.84-.86s-7.25-10.48-16.12-22.25c-8.86-11.76-16.3-21.86-16.53-22.43s1.74-1.83 4.37-2.78c15.93-5.8 23.6-18.7 23.58-39.68-.03-29.17-11.39-43.72-36.72-47.02-12.12-1.57-100.12-1.25-101.47.38m32.89 44.6V418h29.05c31.4 0 32.59-.18 36.78-5.5 4.64-5.92 3.93-18.6-1.37-24.39l-3.3-3.61-30.58-.3-30.58-.28zm122.45-11.61c-.33 1.32-.43 19-.22 39.27.44 41.1.62 42.34 7.4 50.27 8.95 10.44 17.22 12.38 50.84 11.9 28.03-.4 31.98-1.2 40.14-8.19 10.3-8.81 11.55-15.59 11.18-60.6l-.29-34.5-15.75-.28-15.75-.27v33.56c0 36.6-.27 38.66-5.62 42.16-3.89 2.55-27.2 3.27-32.61 1-7.22-3-7.21-2.98-7.77-41.62l-.5-34.55-15.22-.28-15.23-.27zm128.27-1.73c-.4.39-.72 23.81-.72 52.05V491h32v-72.15l2.83-2.83c2.32-2.32 4.03-2.95 9.67-3.56 9.24-.99 21.95.1 26.38 2.27 6.47 3.16 6.59 3.87 6.92 42.05l.3 34.27 15.7-.28 15.7-.27v-79.15l-3-5.82a33.5 33.5 0 0 0-18.07-15.8c-5.73-2.15-7.32-2.24-46.46-2.53-22.3-.17-40.86.02-41.25.42m-760.28 31.75c-16.25 7.57-20.78 30.25-8.73 43.65 5.97 6.64 11.16 8.98 19.9 8.98 28.82 0 38.2-37.6 13-52.05-6.8-3.9-16.52-4.14-24.17-.58m274.48 167.74c-22.2 3.3-31.03 30.48-15.47 47.7 16.78 18.57 48.03 5.63 47.88-19.83-.1-17.78-14.87-30.48-32.41-27.87"/>
      <path fill="#0e1e2a" fill-rule="evenodd" d="M364.3 245c-81.19 8.52-160.02 64.1-199.44 140.61-6.58 12.77-6.96 14.39-3.41 14.39 1.34 0 5.92 1.8 10.17 4s7.8 3.88 7.9 3.75c.1-.14 1.45-2.5 3-5.25 25.73-45.87 55.25-77.77 93.48-101.06 36.4-22.18 79.48-34.19 114.5-31.92 21.5 1.4 19.8 1.68 20.7-3.52a33 33 0 0 1 5.48-13.98c1.28-1.92 2.32-3.78 2.32-4.13 0-2.44-39.23-4.52-54.7-2.9M493 297.45c0 .24 2.41 4.03 5.36 8.44 10.28 15.36 20.13 37.17 25.63 56.74 18.28 65.12-7.29 141.06-67.75 201.2l-13.4 13.33 5.4 5.68c2.96 3.12 6.24 7.14 7.3 8.93 2.4 4.12 2 4.3 13.38-6.32 48.94-45.69 79.64-103.3 85.16-159.86 4.15-42.54-6.93-85.14-27.58-105.98-12-12.12-33.5-26.34-33.5-22.16m951.7 54.2c-.39.38-.7 31.9-.7 70.03V491h30v-35.43c0-38.17.17-39.52 5.2-42.27 4.62-2.52 27.78-2.63 32.3-.15 7.28 3.98 6.95 2.15 7.5 41.7l.5 35.65 15.3.28 15.3.27-.3-39.77-.3-39.78-2.7-5.5c-4.26-8.72-8.7-12.62-18.4-16.15-8.86-3.23-40.25-3.94-48.63-1.11l-5.73 1.94-.27-19.6-.27-19.58-14.06-.28c-7.73-.15-14.37.04-14.75.42m-393.44 36.88c-10.04 2.75-16.06 7.08-19.61 14.13-3.03 6-3.7 16.22-3.42 52.35l.28 35.5 15.25.28 15.25.27v-34.27c0-21.13.42-35.75 1.08-38.11 1.55-5.6 4.88-6.67 20.89-6.67H1094v79h31v-79.15l14.48.33c14.3.32 14.51.35 17.25 3.1l2.77 2.76.5 36.23.5 36.23h30v-39c0-41.2-.26-43.88-4.76-50.56-3.16-4.69-9.89-9.57-16.03-11.64-7.24-2.44-109.92-3.1-118.46-.78m181.25-.15c-14.15 3.61-22.34 12.15-25.37 26.43-2.07 9.7-1.46 44.91.9 52.55 3.66 11.87 11.27 18.72 24.55 22.12 5.04 1.3 12.14 1.51 42 1.3l35.92-.27-.28-10.94c-.16-6.01-.76-11.5-1.34-12.2-.81-.98-8.75-1.35-33.55-1.57l-32.5-.29-2.91-3.27c-2.3-2.58-2.92-4.2-2.92-7.75V450h36.47c36.1 0 36.47-.02 37.6-2.12 1.88-3.52.68-35.21-1.58-41.35-2.49-6.77-9.52-13.61-17.05-16.6-5.6-2.22-7.35-2.37-30.44-2.6-17.31-.17-25.97.14-29.5 1.04m118.23-.28c-18.95 4.46-29.07 25.85-20.92 44.19 6.1 13.74 15.98 17.7 44.12 17.73 16.93.02 19.9.73 21.45 5.12 1.35 3.84 0 7.63-3.34 9.35-2.44 1.26-8.02 1.52-32.45 1.52-34.5 0-31.19-1.47-31.72 14l-.37 10.5h77l5.71-2.8c12.22-6 17.26-15.72 16.61-32.03-.4-10.2-2.02-14.66-7.18-19.74-7.23-7.14-14.13-8.88-38.14-9.6-21.35-.65-23.5-1.36-23.5-7.81 0-7.1-.58-6.96 33.17-7.52l30.33-.5.28-11.75.28-11.75-33.78.1c-18.58.06-35.47.5-37.55.99m-101.67 22.85c-8 .98-12.06 4.66-12.06 10.93v3.84l18.75.7c24 .9 27.25.44 27.25-3.79 0-3.77-3.05-9.04-6.19-10.72-2.78-1.49-18.89-2.05-27.75-.96M133.4 493.56c-.38 1.52-.4 9.2-.07 17.07 3.29 76.1 50.45 131.51 124.75 146.56 15.5 3.13 58.21 3.42 71.93.47 20.3-4.36 37.85-9.39 48.03-13.77l4.69-2.01-3.34-6.2c-1.83-3.4-3.63-8.32-3.99-10.93s-.84-4.75-1.08-4.75-5.7 1.78-12.12 3.96c-39.24 13.31-77.47 15-114.93 5.1-52.76-13.97-88.43-61.68-90.96-121.67l-.6-14.12-8.49-.65c-4.67-.36-9.54-.91-10.8-1.23-1.92-.48-2.45-.1-3.02 2.17m498.64 47.63c-2.4 5.64-13.03 32.9-13.03 33.39 0 .3 1.43.4 3.17.23 2.52-.25 3.37-.93 4.14-3.31 1.66-5.2 2.43-5.6 10.1-5.3l7.09.3 1.47 4.25c1.32 3.83 1.8 4.25 4.71 4.25h3.25l-2.17-5.75c-11.77-31.1-11.1-29.72-14.56-30.06-2.54-.25-3.38.15-4.17 2m49.19-.53c-11.59 5.71-11.87 25.97-.45 32.64 4.6 2.69 14.04 2.6 18.53-.17 4.19-2.6 5.7-5.83 5.7-12.18V556h-7.5c-7.33 0-7.5.06-7.5 2.5 0 2.3.37 2.5 4.5 2.5 4.1 0 4.5.22 4.5 2.43 0 3.53-4.37 6.58-9.39 6.55-7.18-.04-10.61-4.41-10.61-13.51 0-5.11.33-6 3.4-9.07 4.81-4.81 11.7-4.48 15.4.76 1.73 2.43 6.2 2.48 6.2.06 0-7.2-14.04-11.87-22.78-7.56m47.78 16.3V575h24v-2.5c0-2.48-.07-2.5-9-2.5h-9v-11h8c7.87 0 8-.04 8-2.5s-.13-2.5-8-2.5h-8v-10h9.07c8.83 0 9.06-.06 8.75-2.25-.3-2.17-.74-2.26-12.07-2.53L729 538.94zm48 .04v18.13l2.75-.31 2.75-.32.28-12.4.28-12.41 8.55 12.65c7.68 11.38 8.84 12.66 11.47 12.66H806v-36h-5.94l-.28 12.75-.28 12.75L791 552c-7.03-10.34-8.98-12.55-11.25-12.82l-2.75-.31zm52-15.58c0 2.28.42 2.5 5.15 2.78l5.16.3.1 15 .11 15h5.98l.17-15 .17-15 5.64-.3c5.17-.28 5.62-.49 5.33-2.5-.3-2.13-.76-2.2-14.06-2.48L829 538.94zm89.22-.76c-11.66 5.75-11.92 25.94-.43 32.65 7.82 4.57 21.12.52 22.37-6.81.56-3.32-3.45-3.06-6.95.45-2.29 2.28-3.97 3.05-6.7 3.05-7.23 0-10.51-4.23-10.51-13.55 0-10.8 10.36-16.56 17-9.45 4.52 4.84 9.89 3.53 6.53-1.6-3.97-6.05-14.08-8.3-21.31-4.74m53.77.29c-5.74 3.03-8.28 8.72-7.83 17.57.57 11.33 5.87 16.77 16.34 16.77 11.68 0 19.12-9.74 17-22.27-1.95-11.58-14.87-17.7-25.51-12.07m50.01 15.98V575h6v-25.37l8.67 12.68c7.66 11.23 8.99 12.69 11.5 12.69h2.83v-36h-6l-.05 12.75c-.05 12.3-.11 12.66-1.75 10.29-14.31-20.76-15.76-22.55-18.45-22.86l-2.75-.31zm52-15.48c0 2.25.43 2.47 5.25 2.75l5.25.3.28 15.25.27 15.25h5.95v-31h5.5c5.2 0 5.5-.14 5.5-2.5V539h-28zm51.67-1.78c-.37.36-.67 8.46-.67 18V575h6v-14h3.8c3.6 0 3.96.3 7.64 6.59 4.11 7.03 4.99 7.74 8.88 7.23l2.5-.32-4.4-6.77-4.41-6.77 3.06-2.73c5.82-5.2 4.77-14.04-2.08-17.48-3.5-1.76-18.83-2.57-20.32-1.08m57.42 1.5c-10.66 7.3-11.12 25.57-.8 31.86 3.87 2.37 13.46 2.67 17.51.56 11.17-5.8 12.4-24.33 2.1-31.66-4.96-3.54-14.22-3.92-18.8-.77m49.9 15.77V575h23v-2.5c0-2.47-.1-2.5-8.47-2.5h-8.48l-.27-15.25-.28-15.25-2.75-.32-2.75-.31zm79-.03V575h6v-12.77l6.49-.41c10.34-.66 15.34-6.44 12.91-14.9-1.6-5.6-5.23-7.37-15.97-7.77l-9.43-.34zm50 .03V575h23v-2.5c0-2.47-.1-2.5-8.47-2.5h-8.48l-.27-15.25-.28-15.25-2.75-.32-2.75-.31zm52.04-1.23-6.8 18.05q-.44 1.25 2.57 1.25c2.66 0 3.23-.54 4.74-4.5l1.72-4.5h14.32l1.54 4.25c1.32 3.64 2 4.3 4.7 4.56 4 .4 4.25 1.68-3.65-18.31-6.52-16.5-6.8-17-9.76-17.3l-3.05-.3zm48.96 1.23V575h6.16l-.33-12.5c-.32-12.33 0-14.25 1.77-10.68.5 1 4.25 6.62 8.34 12.5 6.46 9.27 7.81 10.68 10.25 10.68h2.81v-36h-5.94l-.28 12.64-.28 12.63-8.51-12.38c-7-10.18-9-12.45-11.25-12.7l-2.74-.32zm55 .07v18h24v-2.5c0-2.48-.07-2.5-9-2.5h-9v-10.92l7.75-.29c6.99-.26 7.75-.49 7.75-2.29s-.76-2.03-7.75-2.3l-7.75-.28V544h8.5c8.4 0 8.5-.03 8.5-2.5V539h-23zm-544.05-10.25c-3.42 3.06-4.7 8.45-3.5 14.8 1.83 9.79 14.63 11.99 19.13 3.3 6.65-12.86-5.6-27.05-15.63-18.1m157.72-2.08c-.37.36-.67 3.06-.67 6V556h5.94c8.29 0 11.92-5.14 7.06-10-1.98-1.98-10.74-2.93-12.33-1.33m53.33 2.18c-7.9 7.89-3.27 23.15 7 23.15 3.23 0 4.78-.63 7-2.85 7.9-7.89 3.27-23.15-7-23.15-3.23 0-4.79.63-7 2.85m133 3.65v6.5h5c5.72 0 9-2.37 9-6.5s-3.28-6.5-9-6.5h-5zm-684.9 2.7c-2.75 8.1-2.86 7.8 2.9 7.8 2.75 0 5-.34 5-.75 0-1.61-4.52-13.25-5.15-13.25-.37 0-1.6 2.79-2.76 6.2m789.55-5.2c-3.72 9.98-4.54 12.44-4.23 12.75.2.2 2.58.22 5.28.06l4.91-.31-2.7-7c-1.62-4.2-2.92-6.4-3.26-5.5"/>
    </svg>`;
  }
  if (["login-brand-logo", "secret-mesh-mark", "error-mesh-mark", "dialog-mark"].includes(className)) return brandLogo(className);
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
  return `<div class="mesh-network-visual" role="img" aria-label="Runmesh network visualization">
    <div class="mesh-canvas-wrap">
      <svg class="mesh-geometry-svg" viewBox="0 0 400 400" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <defs>
          <radialGradient id="mesh-core-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="#fd4a05" stop-opacity="0.22" />
            <stop offset="60%" stop-color="#fd4a05" stop-opacity="0.05" />
            <stop offset="100%" stop-color="#fd4a05" stop-opacity="0" />
          </radialGradient>
          <linearGradient id="mesh-arc-grad1" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#fd4a05" stop-opacity="0.85" />
            <stop offset="50%" stop-color="#0e1e2a" stop-opacity="0.5" />
            <stop offset="100%" stop-color="#fd4a05" stop-opacity="0.1" />
          </linearGradient>
          <linearGradient id="mesh-arc-grad2" x1="100%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="#0e1e2a" stop-opacity="0.8" />
            <stop offset="60%" stop-color="#fd4a05" stop-opacity="0.6" />
            <stop offset="100%" stop-color="#0e1e2a" stop-opacity="0.15" />
          </linearGradient>
          <linearGradient id="mesh-poly-grad" x1="0%" y1="0%" x2="100%" y2="80%">
            <stop offset="0%" stop-color="#fd4a05" stop-opacity="0.18" />
            <stop offset="100%" stop-color="#0e1e2a" stop-opacity="0.06" />
          </linearGradient>
          <filter id="mesh-glow-filter" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
        </defs>

        <circle cx="200" cy="200" r="160" fill="url(#mesh-core-glow)" class="mesh-backdrop-glow" />

        <circle cx="200" cy="200" r="168" stroke="#0e1e2a" stroke-opacity="0.12" stroke-width="1" stroke-dasharray="3 6" class="mesh-orbit-ring mesh-orbit-ring-outer" />
        <circle cx="200" cy="200" r="126" stroke="#fd4a05" stroke-opacity="0.2" stroke-width="1" stroke-dasharray="5 7" class="mesh-orbit-ring mesh-orbit-ring-mid" />
        <circle cx="200" cy="200" r="82" stroke="#0e1e2a" stroke-opacity="0.16" stroke-width="1.2" class="mesh-orbit-ring mesh-orbit-ring-inner" />

        <!-- Logo-derived orbital arcs -->
        <path d="M120 285 C 80 230, 95 145, 155 100 C 220 50, 310 75, 335 150" stroke="url(#mesh-arc-grad1)" stroke-width="2.5" stroke-linecap="round" fill="none" class="mesh-arc-a" />
        <path d="M280 115 C 320 170, 305 255, 245 300 C 180 350, 90 325, 65 250" stroke="url(#mesh-arc-grad2)" stroke-width="2.5" stroke-linecap="round" fill="none" class="mesh-arc-b" />

        <!-- Geometric orchestration mesh grid -->
        <polygon points="200,95 295,150 295,250 200,305 105,250 105,150" fill="url(#mesh-poly-grad)" stroke="#0e1e2a" stroke-opacity="0.18" stroke-width="1.2" class="mesh-hex-outer" />
        <polygon points="200,135 255,168 255,232 200,265 145,232 145,168" stroke="#fd4a05" stroke-opacity="0.32" stroke-width="1" fill="none" class="mesh-hex-inner" />

        <!-- Dynamic interconnection vectors -->
        <g class="mesh-connections" stroke-width="1" stroke-opacity="0.25">
          <line x1="200" y1="95" x2="200" y2="305" stroke="#fd4a05" stroke-dasharray="4 4" class="mesh-ray-v" />
          <line x1="105" y1="150" x2="295" y2="250" stroke="#0e1e2a" stroke-dasharray="4 4" class="mesh-ray-d1" />
          <line x1="105" y1="250" x2="295" y2="150" stroke="#0e1e2a" stroke-dasharray="4 4" class="mesh-ray-d2" />
          <line x1="145" y1="168" x2="255" y2="232" stroke="#fd4a05" />
          <line x1="145" y1="232" x2="255" y2="168" stroke="#fd4a05" />
        </g>

        <!-- Center Orchestration Core: Pure geometric control hub (NO logo image) -->
        <g class="mesh-core-group">
          <circle cx="200" cy="200" r="32" fill="#ffffff" stroke="#0e1e2a" stroke-width="2" stroke-opacity="0.15" class="mesh-core-plate" />
          <circle cx="200" cy="200" r="22" stroke="#fd4a05" stroke-width="1.8" stroke-dasharray="3 3" class="mesh-core-ring" />
          <circle cx="200" cy="200" r="9" fill="#fd4a05" filter="url(#mesh-glow-filter)" class="mesh-core-nucleus" />
          <circle cx="200" cy="200" r="4" fill="#ffffff" class="mesh-core-dot" />
        </g>

        <!-- Dynamic network nodes at logo vertex points -->
        <g class="mesh-nodes-group">
          <!-- Top apex -->
          <circle cx="200" cy="95" r="6" fill="#fd4a05" class="mesh-vertex-node node-1" />
          <circle cx="200" cy="95" r="12" stroke="#fd4a05" stroke-opacity="0.4" stroke-width="1" class="mesh-node-halo halo-1" />

          <!-- Top-right vertex -->
          <circle cx="295" cy="150" r="5.5" fill="#0e1e2a" class="mesh-vertex-node node-2" />
          <circle cx="295" cy="150" r="11" stroke="#0e1e2a" stroke-opacity="0.35" stroke-width="1" class="mesh-node-halo halo-2" />

          <!-- Bottom-right vertex -->
          <circle cx="295" cy="250" r="5.5" fill="#fd4a05" class="mesh-vertex-node node-3" />
          <circle cx="295" cy="250" r="11" stroke="#fd4a05" stroke-opacity="0.4" stroke-width="1" class="mesh-node-halo halo-3" />

          <!-- Bottom apex -->
          <circle cx="200" cy="305" r="6" fill="#0e1e2a" class="mesh-vertex-node node-4" />
          <circle cx="200" cy="305" r="12" stroke="#0e1e2a" stroke-opacity="0.35" stroke-width="1" class="mesh-node-halo halo-4" />

          <!-- Bottom-left vertex -->
          <circle cx="105" cy="250" r="5.5" fill="#fd4a05" class="mesh-vertex-node node-5" />
          <circle cx="105" cy="250" r="11" stroke="#fd4a05" stroke-opacity="0.4" stroke-width="1" class="mesh-node-halo halo-5" />

          <!-- Top-left vertex -->
          <circle cx="105" cy="150" r="5.5" fill="#0e1e2a" class="mesh-vertex-node node-6" />
          <circle cx="105" cy="150" r="11" stroke="#0e1e2a" stroke-opacity="0.35" stroke-width="1" class="mesh-node-halo halo-6" />

          <!-- Orbiting particle beacons -->
          <circle cx="160" cy="120" r="3.5" fill="#fd4a05" class="mesh-satellite sat-1" />
          <circle cx="240" cy="280" r="3.5" fill="#0e1e2a" class="mesh-satellite sat-2" />
        </g>
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

function authEntryDocument(kind: "login" | "setup", csrf: string): string {
  const setup = kind === "setup";
  const brandHeadline = setup ? "Set up Runmesh" : "Runner &amp; MCP Control Plane";
  const brandDescription = setup
    ? "Create your administrator master password to begin managing distributed runtimes and MCP clients."
    : "Unified orchestration for distributed secure tool sandboxes, persistent agent runtimes, and MCP client bridges.";
  const title = setup ? "Runmesh · Agent Control Plane setup" : "Runmesh · Agent Control Plane login";
  const form = setup
    ? `<div class="input-group"><label for="setup_token">Setup token</label><div class="password-input-wrap"><input id="setup_token" type="password" name="setup_token" autocomplete="one-time-code" required>${passwordToggle()}</div></div><div class="input-group"><label for="password">Password</label><div class="password-input-wrap"><input id="password" type="password" name="password" autocomplete="new-password" required minlength="12">${passwordToggle()}</div></div><div class="input-group"><label for="confirm_password">Confirm password</label><div class="password-input-wrap"><input id="confirm_password" type="password" name="confirm_password" autocomplete="new-password" required minlength="12">${passwordToggle()}</div></div>`
    : `<div class="input-group"><label for="admin_password">Admin password</label><div class="password-input-wrap"><input id="admin_password" type="password" name="password" autocomplete="current-password" required>${passwordToggle()}</div></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><link rel="icon" href="/assets/favicon.png" type="image/png"><title>${title}</title>${adminStyles()}</head><body class="auth-body login-entry-body">${languageSwitch()}<div class="login-layout"><aside class="login-brand-pane"><div class="login-brand-header"><a class="login-brand-title-wrap" href="/" aria-label="Runmesh · Agent Control Plane">${brandLogo("login-brand-logo")}</a><p class="brand-kicker">RUNMESH / CONTROL PLANE</p><h2 class="login-brand-headline">${brandHeadline}</h2><p class="login-brand-desc">${brandDescription}</p></div>${meshVisualGraphic()}</aside><main class="login-form-pane"><div class="login-form-container"><div class="auth-header-mobile"><a class="login-brand-title-wrap" href="/" aria-label="Runmesh · Agent Control Plane">${brandLogo("login-brand-logo")}</a></div><div class="login-title-group"><p class="brand-kicker">Runmesh</p><h1>${setup ? "Welcome to Runmesh" : "Runmesh"}</h1><p class="subtitle">Agent Control Plane</p><p class="login-invite">${setup ? "Create administrator password" : "Enter the Runmesh control plane"}</p></div><form method="post" action="/${setup ? "setup" : "login"}" class="login-form stack"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">${form}<button class="login-submit-btn">${setup ? "Initialize" : "Login"}</button></form></div></main></div>${adminScript()}</body></html>`;
}

function setupPage(): Response {
  const csrf = randomBase64Url();
  return html(authEntryDocument("setup", csrf), [`${SETUP_CSRF_COOKIE}=${csrf}; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=${Math.floor(SETUP_CSRF_TTL_MS / 1_000)}`]);
}

function loginPage(): Response {
  const csrf = randomBase64Url();
  return html(authEntryDocument("login", csrf), [`${LOGIN_CSRF_COOKIE}=${csrf}; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=${Math.floor(SETUP_CSRF_TTL_MS / 1_000)}`]);
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
  const headers = await signedInternalHeaders(env, "POST", "/rpc", body);
  if (headers === undefined) return controlPlaneUnavailable();
  try { return await env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/rpc", { method: "POST", headers, body })); }
  catch { return new Response("runner unavailable", { status: 503 }); }
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
        <p class="muted scope-line">${escapeHtml(scopeValues.map(displayScopeLabel).join(", "))}</p>
      </div>
      <p class="muted scope-help">Each base scope has a distinct ceiling: <span class="mono">Read</span> permits inspection, <span class="mono">Write</span> permits approved edits, and <span class="mono">Exec</span> permits Host shell and Job control. Runner and Workspace policy can only reduce these permissions.</p>
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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><link rel="icon" href="/assets/favicon.png" type="image/png"><title>${escapeHtml(title)} · Runmesh · Agent Control Plane</title>${adminStyles()}</head><body class="ops-body"><a class="skip-link" href="#main-content">Skip to main content</a><header class="app-header"><div class="header-inner"><div class="header-left"><a class="brand" href="/admin">${meshMarkSvg("header-mesh-mark")}<span class="brand-copy"><span>Runmesh</span><small>Agent Control Plane</small></span></a>${nav}</div><div class="header-actions">${languageSwitch()}</div></div></header><div class="shell"><main class="workspace" id="main-content" tabindex="-1">${body}</main></div>${adminScript()}</body></html>`;
}
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
  const rows = data.clients.map((client) => `<tr class="data-row"><td><div class="table-primary-cell"><a class="strong" href="/admin/clients/${encodeURIComponent(client.client_id)}">${escapeHtml(client.label)}</a><span class="sub-id mono">${escapeHtml(client.client_id)}</span></div></td><td><div class="scope-tags">${client.scopes.map((s) => `<span class="scope-pill">${escapeHtml(displayScopeLabel(s))}</span>`).join("")}</div></td><td><span class="routing-badge">${escapeHtml(activeRunnerLabel(client, data.runners))}</span></td><td class="time-cell">${escapeHtml(time(client.last_used_at_ms))}</td><td>${client.revoked_at_ms === null ? statusBadge("online") : statusBadge("offline")}</td><td class="actions"><div class="action-btn-group"><a class="button small secondary" href="/admin/clients/${encodeURIComponent(client.client_id)}">View</a><form method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/rename" class="inline-action-form"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input name="label" value="${escapeHtml(client.label)}" aria-label="Rename ${escapeHtml(client.label)}" maxlength="256"><button class="small secondary">Rename</button></form>${client.revoked_at_ms === null ? `<form method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/rotate" class="inline-action-form"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="small secondary">Rotate</button></form>` : ""}<form method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/reset-runner" class="inline-action-form"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="small secondary">Reset Runner Selection</button></form>${client.revoked_at_ms === null ? `<form method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/revoke" class="inline-action-form danger-action"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="small danger">Revoke</button></form>` : ""}</div></td></tr>`).join("") || `<tr><td colspan="6" class="empty"><div class="empty-state-box"><p>No MCP clients yet.</p></div></td></tr>`;
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
function displayScopeLabel(scope: string): string {
  switch (scope) {
    case "coding:read":
      return "Read";
    case "coding:write":
      return "Write";
    case "coding:exec":
      return "Exec";
    default:
      return scope.startsWith("coding:") ? scope.slice("coding:".length) : scope;
  }
}
function scopeCheckboxes(selected: readonly string[] = ["coding:read", "coding:write", "coding:exec"]): string {
  const descriptions: Record<CodingScope, string> = {
    "coding:read": "Inspect workspaces and read files.",
    "coding:write": "Apply approved edits.",
    "coding:exec": "Use Host shell and control Jobs.",
  };
  const titles: Record<CodingScope, string> = {
    "coding:read": "Read",
    "coding:write": "Write",
    "coding:exec": "Exec",
  };
  return (["coding:read", "coding:write", "coding:exec"] as const).map((scope) => `<label class="check"><input type="checkbox" name="scopes" value="${scope}"${selected.includes(scope) ? " checked" : ""}> <span><strong>${titles[scope]}</strong><small>${descriptions[scope]}</small></span></label>`).join("");
}
function runnerDetailPage(runner: Record<string, unknown>, workspaces: readonly unknown[], jobs: readonly unknown[], environment: Record<string, unknown> | undefined, csrf: string, release: RunnerReleaseDescriptor & { readonly distributable: boolean }): string {
  const runnerId = typeof runner.runner_id === "string" ? runner.runner_id : "unknown";
  const displayName = typeof runner.display_name === "string" ? runner.display_name : runnerId;
  const state = typeof runner.state === "string" ? runner.state : "offline";
  const metadata = record(runner.metadata);
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
  const executionMode = typeof metadata?.execution_mode === "string" ? metadata.execution_mode : "migration_required";
  const privilegeState = typeof metadata?.privilege_state === "string" ? metadata.privilege_state : "unknown";
  const serviceIdentity = typeof metadata?.service_identity === "string" ? metadata.service_identity : "Unknown";
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
        <dt>Execution mode</dt>
        <dd class="mono">${escapeHtml(executionMode)}</dd>
        <dt>Service identity</dt>
        <dd class="mono">${escapeHtml(serviceIdentity)}</dd>
        <dt>Privilege state</dt>
        <dd class="mono">${escapeHtml(privilegeState)}</dd>
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
  color-scheme:light;
  --canvas:#f4f6f8;
  --canvas-subtle:#eaedf1;
  --panel:#ffffff;
  --panel-card:#f8fafc;
  --panel-elevated:#ffffff;
  --panel-subtle:#f1f5f9;
  --surface-hover:#eef2f6;
  --header-bg:rgba(255,255,255,0.92);
  --header-hover:rgba(241,245,249,0.85);
  --grid-line:rgba(15,23,42,0.035);
  --focus-ring:rgba(253,74,5,0.22);
  --line:#e2e8f0;
  --line-light:#f1f5f9;
  --line-subtle:#cbd5e1;
  --ink:#0f172a;
  --ink-heading:#020617;
  --muted:#64748b;
  --muted-dark:#334155;
  --brand:#fd4a05;
  --brand-hover:#e03e00;
  --brand-dim:#c2410c;
  --brand-ink:#ffffff;
  --accent-gray:#f1f5f9;
  --accent-gray-hover:#e2e8f0;
  --danger:#dc2626;
  --danger-hover:#b91c1c;
  --danger-ink:#991b1b;
  --danger-bg:#fef2f2;
  --danger-panel:#fffafb;
  --danger-line:#fecaca;
  --warn:#d97706;
  --warn-bg:#fffbeb;
  --warn-line:#fde68a;
  --ok:#16a34a;
  --ok-bg:#f0fdf4;
  --ok-line:#bbf7d0;
  --shadow-sm:0 1px 2px rgba(15,23,42,0.05);
  --shadow-md:0 4px 10px -2px rgba(15,23,42,0.08),0 2px 4px -2px rgba(15,23,42,0.04);
  --shadow-lg:0 12px 24px -4px rgba(15,23,42,0.09),0 4px 8px -4px rgba(15,23,42,0.04);
  --glow-subtle:0 0 0 1px rgba(15,23,42,0.05);
  --radius-sm:6px;
  --radius-md:8px;
  --radius-lg:12px;
  --radius-xl:16px;
  --font-sans:"IBM Plex Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --font-mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;

  /* Auth / Login Page Layout (light only) */
  --auth-bg:#f8fafc;
  --auth-pane-bg:#ffffff;
  --auth-border:#e2e8f0;
  --auth-text:#0f172a;
  --auth-muted:#64748b;
  --auth-input-bg:#ffffff;
  --auth-input-border:#cbd5e1;
  --auth-input-focus:#fd4a05;
  --auth-btn-bg:#0f172a;
  --auth-btn-ink:#ffffff;
  --auth-btn-hover:#1e293b;
}
*{box-sizing:border-box}
html,body{min-height:100%}
body{
  margin:0;
  background-color:var(--canvas);
  background-image:
    radial-gradient(1200px 600px at 50% -10%, rgba(253,74,5,0.04) 0%, transparent 60%),
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
  gap:24px;
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
.brand-copy span{font-size:15px;font-weight:700;letter-spacing:-0.01em;color:var(--ink-heading)}
.brand-copy small{
  margin:2px 0 0;
  font-size:11px;
  font-weight:600;
  letter-spacing:0.06em;
  text-transform:uppercase;
  color:var(--muted);
}
.header-mesh-mark{
  display:block;
  width:160px;
  height:40px;
  flex-shrink:0;
}
.control-nav{
  display:flex;
  gap:3px;
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
  font-size:13px;
  letter-spacing:0.01em;
  transition:all 0.12s ease;
  white-space:nowrap;
}
.control-nav a:hover{color:var(--ink-heading);background:var(--header-hover)}
.control-nav a.active{
  color:var(--brand-ink);
  background:var(--ink-heading);
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
  font-weight:600;
  letter-spacing:0.02em;
  text-align:center;
  text-decoration:none;
  transition:all 0.12s ease;
}
.language-switch a:hover{color:var(--ink-heading);background:var(--accent-gray)}
.language-switch a[aria-current=true]{
  color:var(--brand-ink);
  background:var(--ink-heading);
}
.auth-body>.language-switch{
  position:fixed;
  top:20px;
  right:20px;
  z-index:20;
  background:rgba(255,255,255,0.92);
  border-color:var(--line);
  backdrop-filter:blur(8px);
}
.auth-body>.language-switch a{color:var(--muted)}
.auth-body>.language-switch a:hover{color:var(--ink-heading);background:var(--accent-gray)}
.auth-body>.language-switch a[aria-current=true]{color:var(--brand-ink);background:var(--brand-dim)}

/* Typography & Headings */
h1,h2,h3{
  line-height:1.25;
  margin:0 0 8px;
  color:var(--ink-heading);
  letter-spacing:-0.02em;
}
h1{font-size:22px;font-weight:700}
h2{font-size:16px;font-weight:650;letter-spacing:-0.01em}
h3{font-size:12px;color:var(--muted-dark);text-transform:uppercase;letter-spacing:0.06em;font-weight:650}
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
  font-weight:650;
  letter-spacing:0.06em;
  text-transform:uppercase;
  margin:0 0 4px;
}
.lede,.muted,.subtitle{color:var(--muted)}
.lede,.subtitle{margin:0 0 10px;max-width:64ch;font-size:13.5px;line-height:1.55}
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
  font-size:13px;
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
  font-size:12px;
  color:var(--muted);
}
.mono-truncate{
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
  font-size:16px!important;
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
  font-size:13px;
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
table,.data-table{border-collapse:collapse;width:100%;min-width:760px;font-size:13.5px}
th,td{text-align:left;padding:10px 14px;border-bottom:1px solid var(--line-light);vertical-align:middle}
th{
  color:var(--muted-dark);
  font-size:11px;
  font-weight:650;
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
.strong{font-weight:650;color:var(--ink-heading);text-decoration:none}
a.strong:hover{color:var(--brand-hover);text-decoration:underline}
.sub-id,small{display:block;color:var(--muted);font-size:12px;font-family:var(--font-mono)}
.num-cell{font-variant-numeric:tabular-nums;font-weight:600}
.time-cell{font-family:var(--font-mono);font-size:12px;color:var(--muted)}
.platform-tag{
  display:inline-block;
  padding:2px 7px;
  background:var(--panel-card);
  border:1px solid var(--line);
  border-radius:var(--radius-sm);
  font-size:11.5px;
  font-family:var(--font-mono);
  color:var(--muted-dark);
}
.routing-badge{
  display:inline-block;
  padding:2px 8px;
  background:var(--accent-gray);
  border:1px solid var(--line-subtle);
  border-radius:var(--radius-sm);
  font-size:12px;
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
  height:28px;
  max-width:140px;
}
.danger-action label{
  font-size:11.5px;
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
  font-size:11.5px;
  font-weight:600;
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
  font-size:12px;
  font-weight:600;
  color:var(--muted-dark);
}
.perm-select-label select{
  padding:2px 6px;
  font-size:12px;
  height:26px;
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
.scope-help{font-size:13px;line-height:1.6;margin:0 0 14px;max-width:72ch}
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
  font-size:11.5px;
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
.platform-meta,.client-runner-meta{font-size:12px}
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
  border:1px solid var(--ink-heading);
  background:var(--ink-heading);
  border-radius:var(--radius-md);
  color:var(--brand-ink);
  cursor:pointer;
  font:inherit;
  font-size:13px;
  font-weight:600;
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
  min-height:28px;
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
  font-size:11.5px;
  font-weight:600;
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
  font-size:12px;
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
  font-size:12px;
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
  font-size:13px;
  color:var(--ink-heading);
}
input,select,textarea{
  border:1px solid var(--line-subtle);
  border-radius:var(--radius-md);
  padding:7px 10px;
  font:inherit;
  font-size:13.5px;
  color:var(--ink-heading);
  min-width:0;
  background:var(--panel-elevated);
  transition:border-color 0.14s ease,box-shadow 0.14s ease;
}
input:hover,select:hover{border-color:var(--muted-dark)}
input:focus,select:focus{
  outline:none;
  border-color:var(--brand);
  box-shadow:0 0 0 3px var(--focus-ring);
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
  font-weight:650;
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
.check small{font-family:var(--font-sans);font-size:11.5px;line-height:1.35;color:var(--muted)}
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
  font-size:13px;
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
.tool-name{color:var(--ink-heading);font-size:13.5px;font-weight:650}
.tool-version{font-size:12px;color:var(--muted)}

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
  font-size:11px;
  font-weight:650;
  color:var(--muted);
  text-transform:uppercase;
  letter-spacing:0.04em;
}
.version-stat strong{
  font-size:13.5px;
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
.settings-note{font-size:13.5px;line-height:1.55}
.logout-box{margin-top:16px}

/* Empty State Box */
.empty-state-box{
  padding:24px 16px;
  text-align:center;
}
.empty-state-box p{margin:0;color:var(--muted)}
.empty-desc{font-size:13.5px}

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
  font-size:13.5px;
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
.auth-body::before{display:none}
.auth-shell{
  width:min(460px,92%);
  margin:auto;
  position:relative;
  z-index:2;
}
.auth-card{
  padding:32px 28px;
  box-shadow:var(--shadow-lg);
  background:var(--auth-pane-bg);
  border:1px solid var(--auth-border);
  border-radius:var(--radius-xl);
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
  background:transparent;
  box-shadow:var(--shadow-sm);
}
.secret-brand-row .brand-name{display:none}
.brand-name{
  font-size:16px;
  font-weight:750;
  letter-spacing:-0.01em;
  color:var(--ink-heading);
}
.secret-url,.secret-card code{
  display:block;
  overflow-wrap:anywhere;
  padding:12px;
  border-radius:var(--radius-md);
  background:var(--panel-card);
  border:1px solid var(--line);
  color:var(--ink-heading);
  margin:0 0 16px;
  font-family:var(--font-mono);
  font-size:13px;
}
.secret-actions{
  display:flex;
  gap:10px;
}
.secret-actions .button{background:var(--ink-heading);color:var(--brand-ink);border-color:var(--ink-heading)}
.secret-actions .button:hover{background:var(--brand-hover);border-color:var(--brand-hover)}
.secret-actions .button.secondary{background:var(--panel);color:var(--ink-heading);border-color:var(--line-subtle)}
.error-card{
  border-color:var(--danger-line);
  background:var(--danger-panel);
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
  font-size:13px;
  cursor:pointer;
}
.tabs [role=tab][aria-selected=true]{
  color:var(--brand-ink);
  background:var(--ink-heading);
  border-color:var(--ink-heading);
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
.skip-link{position:absolute;left:12px;top:-48px;z-index:200;padding:8px 12px;background:var(--panel-elevated);border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--ink-heading);text-decoration:none}.skip-link:focus{top:12px}
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
  .control-nav a{padding:5px 9px;font-size:12.5px}
  .metrics{grid-template-columns:repeat(2,1fr)}
  .grid-two{grid-template-columns:1fr}
}
@media(max-width:1100px){
  .header-inner{gap:12px}
  .header-left{gap:12px}
  .header-actions{gap:6px}
  .header-actions .button{padding-left:9px;padding-right:9px;font-size:12.5px}
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
  .header-mesh-mark{width:140px;height:35px}
  .control-nav{flex:1 1 auto;min-width:0;width:auto;overflow-x:auto;white-space:nowrap;scrollbar-width:none}
  .control-nav::-webkit-scrollbar,.header-actions::-webkit-scrollbar{display:none;height:0}
  .control-nav a{padding-left:9px;padding-right:9px}
  .header-actions{justify-content:flex-start;width:100%;flex-wrap:wrap;overflow:visible;row-gap:6px;padding-bottom:0}
  .header-actions > *{flex-shrink:0}
  .header-actions .button{font-size:12px;padding:5px 9px}
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
  .header-left .control-nav{flex:1 1 100%;width:100%;overflow-x:visible;flex-wrap:wrap;row-gap:2px}
  .card-row{align-items:flex-start;gap:8px;min-width:0}
  .card-row-main{min-width:0;max-width:100%}
  .card-row-sub{display:flex;flex-wrap:wrap;min-width:0;max-width:100%;row-gap:3px}
  .platform-meta,.client-runner-meta{min-width:0;max-width:100%;overflow-wrap:anywhere;word-break:break-word}
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
/* Auth surface light layout */
:root{color-scheme:light}
.auth-body.login-entry-body{display:block;min-height:100vh;padding:0;background:var(--auth-bg);color:var(--auth-text)}
.auth-body::before{display:none}
.auth-body>.language-switch{background:rgba(255,255,255,.92);border-color:var(--line);box-shadow:0 8px 24px rgba(15,23,42,.06)}
.auth-body>.language-switch a{color:var(--muted)}
.auth-body>.language-switch a:hover{color:var(--ink-heading);background:var(--accent-gray)}
.auth-body>.language-switch a[aria-current=true]{color:#fff;background:var(--brand-dim)}
.login-layout{display:grid;grid-template-columns:minmax(0,1.12fr) minmax(420px,.88fr);width:100%;min-height:100vh;background:#fff}
.login-brand-pane{min-height:100vh;padding:clamp(36px,6vw,84px) clamp(30px,6vw,84px) 44px;background:linear-gradient(145deg,#ffffff 0%,#f8fafc 60%,#f1f5f9 100%);border-right:1px solid #e2e8f0;display:flex;flex-direction:column;justify-content:space-between;position:relative;overflow:hidden}
.login-brand-pane::before{content:"";position:absolute;inset:-20%;pointer-events:none;background:radial-gradient(circle at 18% 20%,rgba(253,74,5,.1),transparent 36%),radial-gradient(circle at 86% 86%,rgba(14,30,42,.06),transparent 36%)}
.login-brand-header{position:relative;z-index:2;max-width:520px}
.login-brand-title-wrap{display:inline-flex;align-items:center;gap:10px;margin:0 0 28px;text-decoration:none}
.login-brand-logo{display:block;width:min(340px,100%);height:104px;object-fit:cover;object-position:center 50%;padding:0;border-radius:0;background:transparent;box-shadow:none}
.login-brand-title-wrap .brand-name,.login-brand-title-wrap .brand-tag{display:none}
.login-brand-header .brand-kicker{color:var(--brand-dim);margin-bottom:12px}
.login-brand-headline{max-width:480px;margin:0 0 12px;color:#0f172a;font-size:clamp(26px,3.2vw,40px);line-height:1.15;letter-spacing:-.035em}
.login-brand-desc{max-width:50ch;margin:0;color:#64748b;font-size:15px;line-height:1.65}
.mesh-network-visual{position:relative;z-index:2;display:flex;flex-direction:column;align-items:center;margin:auto 0 0;width:100%}
.mesh-canvas-wrap{position:relative;width:min(420px,100%);aspect-ratio:1;display:flex;align-items:center;justify-content:center}
.mesh-geometry-svg{width:100%;height:100%;overflow:visible;filter:drop-shadow(0 12px 28px rgba(15,23,42,0.06))}

/* Bespoke logo-derived animated geometry */
.mesh-orbit-ring{transform-origin:200px 200px}
.mesh-orbit-ring-outer{animation:mesh-spin-slow 40s linear infinite}
.mesh-orbit-ring-mid{animation:mesh-spin-rev 28s linear infinite}
.mesh-orbit-ring-inner{animation:mesh-spin-slow 18s linear infinite}

.mesh-arc-a{transform-origin:200px 200px;animation:mesh-arc-pulse-a 7s ease-in-out infinite alternate}
.mesh-arc-b{transform-origin:200px 200px;animation:mesh-arc-pulse-b 7s ease-in-out infinite alternate}

.mesh-hex-outer{transform-origin:200px 200px;animation:mesh-hex-breathe 8s ease-in-out infinite}
.mesh-hex-inner{transform-origin:200px 200px;animation:mesh-spin-rev 36s linear infinite}

.mesh-core-plate{animation:mesh-core-subtle 4s ease-in-out infinite alternate}
.mesh-core-ring{transform-origin:200px 200px;animation:mesh-spin-slow 12s linear infinite}
.mesh-core-nucleus{animation:mesh-nucleus-glow 3s ease-in-out infinite alternate}

.mesh-vertex-node{transform-box:fill-box;transform-origin:center;animation:mesh-vertex-pulse 3s ease-in-out infinite}
.mesh-node-halo{transform-box:fill-box;transform-origin:center;animation:mesh-halo-wave 3s cubic-bezier(0.2,0.8,0.2,1) infinite}

.node-1,.halo-1{animation-delay:0s}
.node-2,.halo-2{animation-delay:0.5s}
.node-3,.halo-3{animation-delay:1.0s}
.node-4,.halo-4{animation-delay:1.5s}
.node-5,.halo-5{animation-delay:2.0s}
.node-6,.halo-6{animation-delay:2.5s}

.mesh-satellite{transform-origin:200px 200px}
.sat-1{animation:mesh-spin-slow 14s linear infinite}
.sat-2{animation:mesh-spin-rev 16s linear infinite}

@keyframes mesh-spin-slow{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
@keyframes mesh-spin-rev{from{transform:rotate(360deg)}to{transform:rotate(0deg)}}
@keyframes mesh-arc-pulse-a{0%{transform:rotate(0deg) scale(0.98);opacity:0.75}100%{transform:rotate(24deg) scale(1.03);opacity:1}}
@keyframes mesh-arc-pulse-b{0%{transform:rotate(0deg) scale(1.02);opacity:0.8}100%{transform:rotate(-24deg) scale(0.97);opacity:1}}
@keyframes mesh-hex-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.035)}}
@keyframes mesh-core-subtle{0%{transform:scale(0.97)}100%{transform:scale(1.03)}}
@keyframes mesh-nucleus-glow{0%{opacity:0.75;transform:scale(0.9)}100%{opacity:1;transform:scale(1.15)}}
@keyframes mesh-vertex-pulse{0%,100%{transform:scale(0.88);opacity:0.8}50%{transform:scale(1.2);opacity:1}}
@keyframes mesh-halo-wave{0%{transform:scale(0.6);opacity:0.8}100%{transform:scale(1.8);opacity:0}}

.mesh-visual-caption{margin-top:16px;text-align:center}
.mesh-caption-badge{display:inline-flex;align-items:center;gap:7px;padding:6px 14px;border-radius:999px;background:#fff;border:1px solid #e2e8f0;color:#334155;font-size:12px;font-weight:650;box-shadow:0 4px 12px rgba(15,23,42,.05)}
.mesh-caption-sub{margin:6px 0 0;color:#64748b;font-size:12.5px}

.login-form-pane{display:flex;align-items:center;justify-content:center;padding:54px clamp(28px,7vw,104px);background:#fff}
.login-form-container{width:min(420px,100%);display:flex;flex-direction:column}
.auth-header-mobile{display:none;margin-bottom:24px}
.login-title-group{margin-bottom:30px}
.login-title-group .brand-kicker{color:var(--brand-dim);margin-bottom:8px}
.login-title-group h1{color:#0f172a;font-size:32px;line-height:1.12;margin:0 0 7px;letter-spacing:-.04em}
.login-title-group .subtitle{color:#64748b;font-size:14px;margin:0 0 10px}
.login-invite{color:#475569;font-size:15px;margin:8px 0 0}
.login-form{width:100%;display:flex;flex-direction:column;gap:18px}
.input-group{display:flex;flex-direction:column;gap:7px}
.input-group label{color:#334155;font-size:13px;font-weight:650}
.password-input-wrap{position:relative;display:flex;align-items:center;width:100%}
.password-input-wrap input{width:100%;height:48px;background:#fff;border:1px solid #cbd5e1;border-radius:10px;color:#0f172a;padding:11px 42px 11px 14px;font-size:14px;transition:border-color .14s ease,box-shadow .14s ease}
.password-input-wrap input:hover{border-color:#94a3b8}
.password-input-wrap input:focus{border-color:var(--brand);background:#fff;box-shadow:0 0 0 4px var(--focus-ring);outline:none}
.pwd-toggle-btn{position:absolute;right:7px;top:50%;transform:translateY(-50%);background:transparent!important;border:0!important;padding:7px!important;min-height:auto!important;color:#64748b;cursor:pointer;display:flex;align-items:center;justify-content:center;border-radius:7px;transition:color .12s ease}
.pwd-toggle-btn:hover{color:#0f172a}
.eye-icon{width:18px;height:18px}
.login-submit-btn{margin-top:8px;width:100%;height:48px;background:#0f172a;color:#fff;border:1px solid #0f172a;border-radius:10px;font-size:14px;font-weight:750;cursor:pointer;box-shadow:0 8px 18px rgba(15,23,42,.15);transition:background-color .14s ease,border-color .14s ease,transform .14s ease,box-shadow .14s ease}
.login-submit-btn:hover{background:#1e293b;border-color:#1e293b;box-shadow:0 10px 22px rgba(15,23,42,.2);transform:translateY(-1px)}
.login-submit-btn:disabled{opacity:.72;cursor:not-allowed;transform:none}
.enrollment-brand-logo,.secret-mesh-mark,.error-mesh-mark,.dialog-mark{object-fit:cover;object-position:center 50%;background:transparent;box-shadow:none}
.dialog-mark{width:64px;height:36px;padding:0}

@media(min-width:801px) and (max-height:760px){
  .login-brand-pane{padding-top:28px;padding-bottom:22px}
  .login-brand-title-wrap{margin-bottom:14px}
  .login-brand-logo{width:270px;height:82px}
  .login-brand-headline{font-size:28px}
  .login-brand-desc{font-size:13px}
  .mesh-canvas-wrap{width:min(300px,32vw)}
  .mesh-visual-caption{margin-top:8px}
}
@media(prefers-reduced-motion:reduce){
  .mesh-orbit-ring-outer,.mesh-orbit-ring-mid,.mesh-orbit-ring-inner,.mesh-arc-a,.mesh-arc-b,.mesh-hex-outer,.mesh-hex-inner,.mesh-core-plate,.mesh-core-ring,.mesh-core-nucleus,.mesh-vertex-node,.mesh-node-halo,.mesh-satellite{
    animation:none!important;
  }
}
@media(max-width:800px){
  .login-layout{display:block;min-height:100vh}
  .login-brand-pane{min-height:auto;padding:30px 24px 24px;border-right:0;border-bottom:1px solid #e2e8f0}
  .login-brand-logo{width:min(280px,86vw);height:86px}
  .login-brand-title-wrap{margin-bottom:20px}
  .login-brand-headline{font-size:26px}
  .login-brand-desc{font-size:14px}
  .mesh-network-visual{margin-top:20px}
  .mesh-canvas-wrap{width:min(280px,78vw)}
  .mesh-visual-caption{margin-top:9px}
  .login-form-pane{padding:38px 24px 52px;align-items:flex-start}
  .auth-header-mobile{display:none}
  .login-form-container{max-width:500px;margin:0 auto}
  .login-title-group h1{font-size:28px}
}
@media(max-width:480px){
  .auth-body>.language-switch{top:12px;right:12px}
  .login-brand-pane{padding:24px 18px 20px}
  .login-brand-logo{width:230px;height:72px}
  .login-brand-headline{font-size:23px}
  .mesh-canvas-wrap{width:235px}
  .login-form-pane{padding:32px 18px 42px}
  .login-title-group{margin-bottom:24px}
  .login-title-group h1{font-size:25px}
}
</style>`; }
 function adminScript(): string {
   const translationJson = JSON.stringify(ZH_UI_TEXT);
   return `<script>
 (function(){
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
 function applyLocale(locale){var zh=locale==='zh-CN';document.documentElement.lang=zh?'zh-CN':'en';document.querySelectorAll('[data-lang-toggle]').forEach(function(item){var active=item.getAttribute('data-lang-toggle')===locale;item.setAttribute('aria-current',active?'true':'false')});if(zh){translateTextNodes(document.body);translateAttributes(document);var title=document.title;var titleParts=['MCP client created','MCP client rotated','MCP Clients','MCP Client','Runmesh · Agent Control Plane','Agent Control Plane','Dashboard','Runners','Clients','Settings','login','setup','enrollment'];titleParts.forEach(function(part){if(ZH_UI_TEXT[part])title=title.split(part).join(ZH_UI_TEXT[part])});document.title=title}}
function requestedLocale(){var query=new URLSearchParams(location.search).get('lang');if(query==='zh-CN'||query==='zh')return 'zh-CN';if(query==='en')return 'en';var match=/runmesh_lang=(zh-CN|en)/.exec(document.cookie||'');if(match)return match[1];return navigator.language&&navigator.language.toLowerCase().startsWith('zh')?'zh-CN':'en'}
function rememberLocale(locale){document.cookie='runmesh_lang='+locale+'; Max-Age=31536000; Path=/; SameSite=Lax'}
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
export function runnerEnrollmentPage(env: RunnerReleaseEnvironment, baseUrl: string, runnerId: string, code: string | undefined, csrf: string, _reEnroll = false): Response {
  if (code === undefined) return adminError(503, "Enrollment code could not be generated.");
  const release = runnerReleaseDescriptor(env);
  const bootstrap = release.distributable;
  // Validate the origin for both the hosted and manual paths.  The manual
  // fallback still emits a server URL into a copyable command; deriving it
  // with `new URL(...).origin` alone would allow a forged Host header to send
  // the operator's one-time code to an attacker-controlled endpoint.
  let publicBase: string;
  try {
    const parsed = new URL(baseUrl);
    const headers = new Headers({ host: parsed.host });
    publicBase = resolveConnectionOrigin(new Request(parsed.toString(), { headers }), env.RUNMESH_PUBLIC_ORIGIN);
    if (bootstrap) publicBase = canonicalPublicOrigin(publicBase);
  } catch {
    return installerOriginUnavailable();
  }
  const shellInstallerUrl = shellQuote(new URL("/runner/install.sh", publicBase).toString());
  const powerShellInstallerUrl = powershellQuote(new URL("/runner/install.ps1", publicBase).toString());
  // The copied bootstrap command is itself a code-fetching trust boundary:
  // download to a private temporary file and check the fetch status before a
  // privileged interpreter sees any bytes. Automatic redirects are disabled;
  // the installer script performs its own pinned multi-hop checks for GitHub
  // assets after it starts.
  const shellCommand = `set -eu
installer="$(mktemp)"
trap 'rm -f "$installer"' EXIT
curl -q --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --max-redirs 0 --max-time 60 --max-filesize 262144 --output "$installer" ${shellInstallerUrl}
test -s "$installer"
sudo sh "$installer"`;
  const powerShellCommand = `$ErrorActionPreference = 'Stop'
$installer = Join-Path ([IO.Path]::GetTempPath()) ('runmesh-installer-' + [guid]::NewGuid().ToString('N') + '.ps1')
try {
  $response = Invoke-WebRequest -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 60 -ErrorAction Stop -OutFile $installer -Uri ${powerShellInstallerUrl}
  $status = [int]$response.StatusCode
  if ($status -lt 200 -or $status -ge 300) { throw \"Installer download returned HTTP $status.\" }
  if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw 'Installer download did not produce a file.' }
  $length = (Get-Item -LiteralPath $installer).Length
  if ($length -le 0 -or $length -gt 262144) { throw 'Installer download size is invalid.' }
  & ([scriptblock]::Create([IO.File]::ReadAllText($installer)))
} finally {
  Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
}`;
  const server = new URL("/runner/enroll", publicBase).toString();
  const shellServer = shellQuote(server);
  const powershellServer = powershellQuote(server);
  const manualCommands = {
    linux: `set -euo pipefail
RUNNER=/opt/runmesh/current/bin/coding-runner # replace with the verified absolute path if different
test -x "$RUNNER"
printf '%s' 'One-time enrollment code: ' >&2
read -r -s RUNMESH_ENROLLMENT_CODE
printf '\\n' >&2
printf '%s\\n' "$RUNMESH_ENROLLMENT_CODE" | sudo "$RUNNER" enroll --server ${shellServer} --code-stdin
unset RUNMESH_ENROLLMENT_CODE
sudo "$RUNNER" install --execution-mode privileged_host --confirm-privileged-host --executable-path "$RUNNER"
sudo "$RUNNER" doctor --json`,
    macos: `set -euo pipefail
RUNNER=/opt/runmesh/current/bin/coding-runner # replace with the verified absolute path if different
test -x "$RUNNER"
printf '%s' 'One-time enrollment code: ' >&2
read -r -s RUNMESH_ENROLLMENT_CODE
printf '\\n' >&2
printf '%s\\n' "$RUNMESH_ENROLLMENT_CODE" | sudo "$RUNNER" enroll --server ${shellServer} --code-stdin
unset RUNMESH_ENROLLMENT_CODE
sudo "$RUNNER" install --execution-mode privileged_host --confirm-privileged-host --executable-path "$RUNNER"
sudo "$RUNNER" doctor --json`,
    windows: `# Run this in an elevated PowerShell session
$ErrorActionPreference = 'Stop'
$RunnerPath = 'C:\\Program Files\\Runmesh\\current\\coding-runner.cmd' # replace with the verified absolute shim path if different
if (-not (Test-Path -LiteralPath $RunnerPath -PathType Leaf)) { throw 'Set RunnerPath to the verified coding-runner.cmd path.' }
$EnrollmentCode = Read-Host 'One-time enrollment code'
try {
  $EnrollmentCode | & $RunnerPath enroll --server ${powershellServer} --code-stdin --execution-mode privileged_host --confirm-privileged-host
  if ($LASTEXITCODE -ne 0) { throw 'Runner enrollment failed.' }
} finally {
  Remove-Variable EnrollmentCode -ErrorAction SilentlyContinue
}
& $RunnerPath install --execution-mode privileged_host --confirm-privileged-host --executable-path $RunnerPath
if ($LASTEXITCODE -ne 0) { throw 'Runner service installation failed.' }
& $RunnerPath doctor --json
if ($LASTEXITCODE -ne 0) { throw 'Runner doctor check failed.' }`,
  };
  const commands = bootstrap ? { linux: shellCommand, macos: shellCommand, windows: powerShellCommand } : manualCommands;
  const tabs = Object.entries(commands).map(([platform, value], index) => `<button role="tab" id="tab-${platform}" aria-controls="panel-${platform}" aria-selected="${index === 0 ? "true" : "false"}" tabindex="${index === 0 ? "0" : "-1"}" data-tab="${platform}">${platform === "macos" ? "macOS" : platform === "windows" ? "Windows" : "Linux"}</button><section role="tabpanel" id="panel-${platform}" aria-labelledby="tab-${platform}" ${index === 0 ? "" : "hidden"} data-panel="${platform}"><pre><code>${escapeHtml(value)}</code></pre><button type="button" class="button secondary" data-copy="${escapeHtml(value)}">Copy ${bootstrap ? "installer" : "enrollment and install"} command</button></section>`).join("");
  const title = bootstrap ? "Signed fixed-preview enrollment" : "Manual portable-artifact enrollment";
  const instruction = bootstrap
    ? "The installer verifies the fixed signed Runner artifact before it asks locally for this one-time code. It never places the code in this command, a URL, or process arguments. The recommended execution mode is privileged_host; dedicated_user stays available for explicit isolation cases and privileged_host still requires an explicit --confirm-privileged-host acknowledgement in the Runner CLI."
    : "Manual Runner enrollment and install uses a verified portable artifact. The fixed signed hosted release is not enabled on this deployment. Install the artifact first, then run the single-line command below. It will ask for this code locally; paste it and press Enter. The install step runs only after enrollment succeeds. The recommended execution mode is privileged_host; dedicated_user stays available for explicit isolation cases and privileged_host still requires an explicit --confirm-privileged-host acknowledgement in the Runner CLI.";
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><link rel="icon" href="/assets/favicon.png" type="image/png"><title>Runmesh · Agent Control Plane enrollment</title>${adminStyles()}</head><body class="ops-body enrollment-body"><header class="enrollment-header"><a class="enrollment-brand" href="/admin" aria-label="Runmesh · Agent Control Plane">${brandLogo("enrollment-brand-logo")}</a><div class="enrollment-header-actions">${languageSwitch()}</div></header><main class="shell enrollment-shell"><dialog open aria-labelledby="enrollment-title" class="enrollment-dialog"><section class="page-heading"><div><div class="dialog-icon-row">${meshMarkSvg("dialog-mark")}</div><p class="eyebrow">${title}</p><h1 id="enrollment-title">Enroll Runner</h1><p class="lede">${instruction} This one-time code expires in 30 minutes and will not be shown again.</p></div></section><div class="enrollment-meta-box"><span class="form-stat-label">Target Runner ID</span><span class="mono">${escapeHtml(runnerId)}</span></div><div class="enrollment-meta-box"><span class="form-stat-label">One-time enrollment code</span><code class="mono" data-no-i18n>${escapeHtml(code)}</code><span class="muted font-12">Paste it only into the local prompt after verification; it is deliberately excluded from copied commands.</span></div><div role="tablist" aria-label="Operating system" class="tabs">${tabs}</div><p class="warning">Do not share this code. It is single-use enrollment material, not an administrator password, MCP secret, or long-term credential.</p><div class="top-actions dialog-actions"><form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/enrollment"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="button secondary">Regenerate enrollment</button></form><a class="button" href="/admin/runners">Done</a></div></dialog></main>${adminScript()}</body></html>`);
}
  function secretCreatedPage(title: string, url: string): string { return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><link rel="icon" href="/assets/favicon.png" type="image/png"><title>${escapeHtml(title)}</title>${adminStyles()}</head><body class="auth-body">${languageSwitch()}<main class="auth-shell"><section class="auth-card secret-card"><div class="secret-brand-row">${meshMarkSvg("secret-mesh-mark")}<span class="brand-name">Runmesh</span></div><p class="brand-kicker">Runmesh</p><h1>${escapeHtml(title)}</h1><p class="lede">Copy this URL now. It will not be shown again.</p><code>${escapeHtml(url)}</code><div class="secret-actions"><button type="button" class="button" data-copy="${escapeHtml(url)}">Copy MCP URL</button><a class="button secondary" href="/admin">Back to admin</a></div></section></main>${adminScript()}</body></html>`; }
function secretUrl(base: string, secret: string): string { const url = new URL(base); url.pathname = `/${secret}/mcp`; url.search = ""; return url.toString(); }
function selectedScopes(form: FormData): CodingScope[] | undefined { const values = form.getAll("scopes"); const scopes = values.filter((value): value is CodingScope => value === "coding:read" || value === "coding:write" || value === "coding:exec"); return scopes.length === values.length && scopes.length > 0 && new Set(scopes).size === scopes.length ? scopes : undefined; }
function validPassword(password: string): boolean { return password.length >= 12 && password.length <= 1_024; }
function validLabel(label: string): boolean { return label.trim().length > 0 && label.length <= 256; }
function validRunnerVersion(value: string): boolean { return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value); }

export async function pushRunnerPolicy(env: WorkerEnv, runnerId: string, mutationId?: string): Promise<Response> {
  const body = JSON.stringify(mutationId === undefined ? {} : { mutation_id: mutationId });
  const headers = await signedInternalHeaders(env, "POST", "/policy", body);
  if (headers === undefined) return controlPlaneUnavailable();
  try { return await env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/policy", { method: "POST", headers, body })); }
  catch { return new Response("runner unavailable", { status: 503 }); }
}
async function beginRunnerPolicyMutation(env: WorkerEnv, runnerId: string, mutationId: string): Promise<Response> {
  const body = JSON.stringify({ mutation_id: mutationId, runner_id: runnerId });
  const headers = await signedInternalHeaders(env, "POST", "/begin-policy-mutation", body);
  if (headers === undefined) return controlPlaneUnavailable();
  try { return await env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/begin-policy-mutation", { method: "POST", headers, body })); }
  catch { return new Response("runner unavailable", { status: 503 }); }
}
async function markRunnerPolicyCommitted(env: WorkerEnv, runnerId: string, mutationId: string, phase: "committed_pending" | "offline_pending", desiredRevision: number, desiredChecksum: string): Promise<Response> {
  const body = JSON.stringify({ mutation_id: mutationId, phase, desired_revision: desiredRevision, desired_checksum: desiredChecksum });
  const headers = await signedInternalHeaders(env, "POST", "/mark-policy-committed", body);
  if (headers === undefined) return controlPlaneUnavailable();
  try { return await env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/mark-policy-committed", { method: "POST", headers, body })); }
  catch { return new Response("runner unavailable", { status: 503 }); }
}

async function cancelRunnerPolicyMutation(env: WorkerEnv, runnerId: string, mutationId: string): Promise<Response> {
  const body = JSON.stringify({ mutation_id: mutationId });
  const headers = await signedInternalHeaders(env, "POST", "/cancel-policy-mutation", body);
  if (headers === undefined) return controlPlaneUnavailable();
  try { return await env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/cancel-policy-mutation", { method: "POST", headers, body })); }
  catch { return new Response("runner unavailable", { status: 503 }); }
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
  // This route is reachable before authentication. Cap the stream before
  // buffering it for HMAC verification so an unauthenticated large request
  // cannot exhaust Worker memory.
  const body = await readBodyText(request, MAX_INTERNAL_RPC_BODY_BYTES);
  let verified = false;
  try { verified = body !== undefined && await verifyInternalRequest(request, env.INTERNAL_CONTROL_SECRET, body, consumeInternalNonce.bind(undefined, env)); } catch { verified = false; }
  if (!verified || body === undefined) return notFound();
  const runnerId = segments[2] as string;
  const headers = await signedInternalHeaders(env, "POST", "/rpc", body);
  if (headers === undefined) return notFound();
  try { return await env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/rpc", { method: "POST", headers, body })); }
  catch { return new Response("runner unavailable", { status: 503 }); }
}

async function handleRunnerAdmin(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  if (!isRunnerAdminRequest(request, env)) { await discardBody(request); return new Response("unauthorized", { status: 401 }); }
  if (!isConfiguredSecret(env.INTERNAL_CONTROL_SECRET) || !isConfiguredSecret(env.RUNNER_TOKEN_PEPPER)) { await discardBody(request); return new Response("admin control plane is not configured", { status: 503 }); }
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
    try { await revokeRunnerTransport(env, runnerId, mutationId); }
    catch { return new Response("runner revocation cleanup is uncertain; Runner remains safely fenced", { status: 503 }); }
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
  try {
    await deleteRunnerTransport(env, runnerId, mutationId);
  } catch { return new Response("runner deletion outcome is uncertain; Runner remains safely fenced", { status: 503 }); }
  return new Response(null, { status: 204 });
}

async function registerRunner(env: WorkerEnv, runnerId: string, input: Record<string, unknown> | undefined): Promise<Response> {
  const supplied = input?.token;
  if (supplied !== undefined && (typeof supplied !== "string" || supplied.length < 32 || supplied.length > 512 || /\s/.test(supplied) || containsControlCharacter(supplied))) return Response.json({ error: "token must be 32-512 non-whitespace characters" }, { status: 400 });
  const token = typeof supplied === "string" ? supplied : generateRunnerToken(); const pepper = env.RUNNER_TOKEN_PEPPER;
  if (!isConfiguredSecret(pepper) || !isConfiguredSecret(env.INTERNAL_CONTROL_SECRET)) return new Response("admin control plane is not configured", { status: 503 });
  const mutationId = `credential-rotated-${crypto.randomUUID()}`;
  let existingResponse: Response;
  try { existingResponse = await runnerRegistryRequest(env, runnerId, "", "GET", ""); } catch { return new Response("registry unavailable", { status: 503 }); }
  if (!existingResponse.ok && existingResponse.status !== 404) return new Response("registry unavailable", { status: 503 });
  // A missing Registry row does not prove that the corresponding RunnerDO is
  // empty: a prior delete may have committed in Registry while transport
  // cleanup failed, leaving an authenticated pre-hello socket behind. Always
  // acquire the DO fence before creating or replacing a credential.
  const fenced = await fenceRunnerTransport(env, runnerId, mutationId);
  if (!fenced.ok) return new Response("runner unavailable", { status: 503 });
  let response: Response;
  try {
    // Creation mutations are recorded with a synthetic pre-version in
    // Registry, making the same fenced cleanup/retry protocol work for both a
    // fresh row and an existing credential replacement.
    response = await runnerRegistryRequest(env, runnerId, "", "PUT", JSON.stringify({ token_verifier: await runnerTokenVerifier(token, pepper), mutation_id: mutationId }));
  } catch {
    const state = await runnerMutationState(env, runnerId, mutationId).catch(() => undefined);
    if (state?.mutation_committed === true) {
      // The Registry marker and the RunnerDO mutation owner jointly identify
      // this exact registration.  The row may have crossed a delete/recreate
      // lifecycle after the initial GET, so let the transport finalizer accept
      // the committed marker's new lifecycle; it still fails closed when the
      // marker is absent, stale, or owned by another mutation.
      try { await revokeRunnerTransport(env, runnerId, mutationId, true); } catch { /* remain fenced */ }
    } else {
      try { await cancelRunnerPolicyMutation(env, runnerId, mutationId); } catch { /* remain fenced */ }
    }
    return new Response("registry mutation outcome is uncertain; Runner remains safely fenced", { status: 503 });
  }
  if (!response.ok) {
    if (![400, 404, 409].includes(response.status)) return new Response("registry mutation outcome is uncertain; Runner remains safely fenced", { status: 503 });
    const state = await runnerMutationState(env, runnerId, mutationId).catch(() => undefined);
    if (state?.mutation_committed === true) {
      try { await revokeRunnerTransport(env, runnerId, mutationId, true); } catch { return new Response("Runner remains safely fenced", { status: 503 }); }
      return new Response("registry mutation failed after commit", { status: 503 });
    }
    try {
      const cancelled = await cancelRunnerPolicyMutation(env, runnerId, mutationId);
      if (!cancelled.ok) return new Response("Runner remains safely fenced", { status: 503 });
    } catch { return new Response("Runner remains safely fenced", { status: 503 }); }
    return new Response("runner registration failed", { status: response.status });
  }
  const committed = await runnerMutationState(env, runnerId, mutationId).catch(() => undefined);
  if (committed?.mutation_committed !== true) return new Response("registry mutation outcome is uncertain; Runner remains safely fenced", { status: 503 });
  // A concurrent delete/recreate can replace the lifecycle between the
  // pre-fence GET and this finalizer.  `allow_lifecycle_change` is safe here:
  // RunnerDO still requires ownership of this mutation ID and verifies that
  // Registry committed the matching marker before it closes any socket.
  try { await revokeRunnerTransport(env, runnerId, mutationId, true); }
  catch { return new Response("runner credential cleanup is uncertain; Runner remains safely fenced", { status: 503 }); }
  return Response.json({ runner_id: runnerId, token }, { headers: credentialHeaders("application/json; charset=utf-8") });
}
async function fenceRunnerTransport(env: WorkerEnv, runnerId: string, mutationId: string): Promise<Response> {
  const body = JSON.stringify({ mutation_id: mutationId, runner_id: runnerId });
  const headers = await signedInternalHeaders(env, "POST", "/begin-policy-mutation", body);
  if (headers === undefined) return controlPlaneUnavailable();
  try { return await env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/begin-policy-mutation", { method: "POST", headers, body })); }
  catch { return new Response("runner unavailable", { status: 503 }); }
}
async function revokeRunnerTransport(env: WorkerEnv, runnerId: string, mutationId: string, allowLifecycleChange = false): Promise<void> {
  const body = JSON.stringify({ mutation_id: mutationId, ...(allowLifecycleChange ? { allow_lifecycle_change: true } : {}) });
  const headers = await signedInternalHeaders(env, "POST", "/revoke", body);
  if (headers === undefined) throw new Error("control plane is not configured");
  let response: Response;
  try { response = await env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/revoke", { method: "POST", headers, body })); }
  catch (error) { throw error; }
  if (!response.ok) throw new Error(`RunnerDO revoke rejected with status ${response.status}`);
}
async function deleteRunnerTransport(env: WorkerEnv, runnerId: string, mutationId: string): Promise<void> {
  const body = JSON.stringify({ mutation_id: mutationId });
  const headers = await signedInternalHeaders(env, "POST", "/delete", body);
  if (headers === undefined) throw new Error("control plane is not configured");
  const response = await env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/delete", { method: "POST", headers, body }));
  if (!response.ok) throw new Error(`RunnerDO delete rejected with status ${response.status}`);
}
function isRunnerAdminRequest(request: Request, env: WorkerEnv): boolean { const token = bearerToken(request); return token !== undefined && isConfiguredSecret(env.ADMIN_TOKEN) && constantTimeEqual(token, env.ADMIN_TOKEN); }
async function runnerRegistryRequest(env: WorkerEnv, runnerId: string, action: string, method: string, body: string): Promise<Response> {
  const path = `/runners/${encodeURIComponent(runnerId)}${action}`;
  return registryRequest(env, path, method, body);
}

async function runnerMutationState(env: WorkerEnv, runnerId: string, mutationId: string): Promise<Record<string, unknown> | undefined> {
  const response = await registryGet(env, `/runners/${encodeURIComponent(runnerId)}/mutation-state?mutation_id=${encodeURIComponent(mutationId)}`);
  return response.ok ? record(await json(response)) : undefined;
}
/** Resolve a fenced mutation after a Registry response that may have been
 * lost.  A committed mutation is finalized by closing RunnerDO sockets; an
 * uncommitted one is cancelled only after the DO re-verifies Registry state.
 * Any inability to prove either outcome leaves the fence in place. */
async function settleRunnerMutation(env: WorkerEnv, runnerId: string, mutationId: string, allowLifecycleChange = false): Promise<"committed" | "cancelled" | "uncertain"> {
  const state = await runnerMutationState(env, runnerId, mutationId).catch(() => undefined);
  if (state?.mutation_committed === true) {
    try { await revokeRunnerTransport(env, runnerId, mutationId, allowLifecycleChange); return "committed"; }
    catch { return "uncertain"; }
  }
  try {
    const cancelled = await cancelRunnerPolicyMutation(env, runnerId, mutationId);
    return cancelled.ok ? "cancelled" : "uncertain";
  } catch { return "uncertain"; }
}

async function verifyMcpClient(env: WorkerEnv, secretVerifier: string): Promise<VerifiedMcpClient | undefined> {
  let response: Response;
  try { response = await registryPost(env, "/auth/mcp/verify", { secret_verifier: secretVerifier }); } catch { return undefined; }
  const body = response.ok ? record(await json(response)) : undefined;
  if (body === undefined || typeof body.client_id !== "string" || typeof body.label !== "string" || typeof body.secret_version !== "number" || !Array.isArray(body.scopes) || body.scopes.some((scope) => scope !== "coding:read" && scope !== "coding:write" && scope !== "coding:exec")) return undefined;
  return { client_id: body.client_id, label: body.label, secret_version: body.secret_version, scopes: body.scopes as CodingScope[] };
}
async function registryGet(env: WorkerEnv, path: string): Promise<Response> { return registryRequest(env, path, "GET", ""); }
async function registryPost(env: WorkerEnv, path: string, payload: Record<string, unknown>): Promise<Response> { return registryRequest(env, path, "POST", JSON.stringify(payload)); }
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
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><link rel="icon" href="/assets/favicon.png" type="image/png"><title>Runmesh · Agent Control Plane</title>${adminStyles()}</head><body class="auth-body">${languageSwitch()}<main class="auth-shell"><section class="auth-card error-card"><div class="secret-brand-row">${meshMarkSvg("error-mesh-mark")}<span class="brand-name">Runmesh</span></div><p class="brand-kicker">Runmesh</p><h1>Runmesh</h1><p class="subtitle">Agent Control Plane</p><p class="lede">Invalid administrator password.</p><p class="muted">Please try again shortly.</p><p><a class="button secondary" href="/">Return</a></p></section></main>${adminScript()}</body></html>`, { status: 403, headers });
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
function adminError(status: number, message: string, cookies: readonly string[] = []): Response { const response = html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><link rel="icon" href="/assets/favicon.png" type="image/png"><title>Runmesh · Agent Control Plane</title>${adminStyles()}</head><body class="auth-body">${languageSwitch()}<main class="auth-shell"><section class="auth-card error-card"><div class="secret-brand-row">${meshMarkSvg("error-mesh-mark")}<span class="brand-name">Runmesh</span></div><p class="brand-kicker">Runmesh</p><h1>Runmesh</h1><p class="subtitle">Agent Control Plane</p><p class="lede">${escapeHtml(message)}</p><p><a class="button secondary" href="/">Return</a></p></section></main>${adminScript()}</body></html>`, cookies.length === 0 ? [] : cookies); return new Response(response.body, { status, headers: response.headers }); }
function methodNotAllowed(allow: string): Response { return new Response("Method not allowed", { status: 405, headers: { allow } }); }
function notFound(): Response { return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } }); }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] as string); }
function time(value: number | null): string { return value === null ? "Never" : new Date(value).toISOString(); }
async function json(response: Response): Promise<unknown> { try { return await response.json(); } catch { return undefined; } }
function arrayField(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function record(value: unknown): Record<string, unknown> | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
