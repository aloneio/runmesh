import { enrollmentDocument } from "./admin/enrollment-view.js";
import { runnerDetailPage } from "./admin/runner-detail-view.js";
import { runnersPage } from "./admin/runner-list-view.js";
import { escapeHtml, arrayField, record } from "./admin/format.js";
import { BRAND_LOGO_ASSET, meshMarkSvg, languageSwitch } from "./admin/brand.js";
import { adminScript } from "./admin/client-script.js";
import { type AdminNotice, type AdminData } from "./admin/view-models.js";

import { isFullHostPath } from "./admin/host-path-label.js";

import { adminDocument } from "./admin/layout.js";
import { authEntryDocument, secretCreatedPage } from "./admin/auth-views.js";
import { clientDetailPage, clientsPage } from "./admin/client-views.js";
import { overviewPage, settingsPage } from "./admin/dashboard-views.js";
import { html, htmlHeaders, redirect, credentialHeaders } from "./http/html-response.js";
import { MCP_CATALOG_SUMMARY } from "./mcp/catalog-contract.js";
import { resolveRuntimeConfiguration } from "./runtime-config.js";
import { localizeHtmlResponse } from "./ui-locale.js";
import { ProtectedRpcMethodSchema } from "@aloneio/runmesh-protocol";
import { rpcPermissionRequirement } from "./mcp-authorization.js";
import { PRODUCT_VERSION } from "./generated-version.js";
import { historyView } from "./history-ui.js";
import { parseJobHistorySettings } from "./job-history-settings.js";
import { PackedJobHistory } from "./job-history-store.js";
import { ExternalAuditHistory } from "./external-audit.js";
import { PROTOCOL_CURRENT_VERSION, PROTOCOL_MIN_VERSION } from "@aloneio/runmesh-protocol";
import { RegistryDO, RegistryDOv2, DEFAULT_RUNNER_ENROLLMENT_TTL_MS, RUNNER_ENROLLMENT_TTL_OPTIONS_MS, type McpClientRecord, type RegistryFeatureHealth, type RunnerExecutionMode, type RunnerPublicInfo, type RunnerRecord, type VerifiedMcpClient } from "./registry.js";
import { RunnerDO } from "./runner-do.js";
import type { WorkerEnv } from "./platform/env.js";
import type { McpAuth } from "./mcp/server.js";
import type { CodingScope } from "./registry.js";
import {
  ADMIN_SESSION_TTL_MS,
  SETUP_CSRF_TTL_MS,
  bearerToken,
  containsControlCharacter,
  constantTimeEqual,
  generateRunnerToken,
  hmacHex,
  internalHeaders,
  isConfiguredSecret,
  isSafeIdentifier,
  passwordVerifier,
  randomBase64Url,
  runnerTokenVerifier,
  sha256Hex,
  verifyInternalRequest,
  verifyPassword,
} from "./security.js";
import { readCappedBytes, readCappedFormData, readCappedText as readBodyText } from "./body.js";
import { FIXED_RELEASE_VERSION, canonicalPublicOrigin, fixedReleaseDescriptor, renderPosixInstaller, renderPowerShellInstaller, renderPosixUninstaller, renderPowerShellUninstaller, resolvePublicOrigin, signedReleaseIsAvailable, type FixedReleaseDescriptor } from "./installer.js";
import { validTimestamp, type ValidityWindow } from "./validity.js";
import { loadLoginSettings } from "./auth-settings.js";
import { loadAdminJobPage } from "./admin-jobs.js";
import { adminStyles } from "./admin-styles.js";
import { ControlPlaneUnavailableError, controlPlaneUnavailableResponse } from "./control-plane-errors.js";

// v2 Durable Object classes intentionally use fresh namespaces. The current
// release is a clean schema break: persisted data from the retired namespace
// must never be opened or migrated in place.
export { RegistryDO, RegistryDOv2, RunnerDO };
export class RunnerDOv2 extends RunnerDO {}

const MAX_ADMIN_BODY_BYTES = 16_384;
const MAX_INTERNAL_RPC_BODY_BYTES = 1_048_576;
const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_VALIDITY_DAYS = 3_650;
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

export interface RunnerReleaseDescriptor extends FixedReleaseDescriptor {
  readonly protocol: { readonly min_version: number; readonly max_version: number };
}

export interface ReleaseGateDiagnostics {
  readonly acknowledgement_matches_fixed_release: boolean;
  readonly canonical_public_origin_configured: boolean;
  readonly test_mode_disabled: boolean;
}

export default {
  async scheduled(_event: ScheduledController, env: WorkerEnv): Promise<void> {
    env = resolveRuntimeConfiguration(env);
    if (env.HISTORY_DB === undefined) return;
    // Deriving an ID does not instantiate a DO or touch its SQLite storage.
    const history = new ExternalAuditHistory(env.HISTORY_DB, env.REGISTRY.idFromName("registry").toString());
    if (env.RUNMESH_AUDIT_BACKEND === "d1") await history.cleanup();
    if (env.RUNMESH_JOB_HISTORY_BACKEND === "d1") await new PackedJobHistory(env.HISTORY_DB,env.REGISTRY.idFromName("registry").toString()).cleanup();
  },
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    env = resolveRuntimeConfiguration(env, request);
    try { return localizeHtmlResponse(request, await handleRequest(request, env, ctx)); }
    catch (error) {
      if (error instanceof ControlPlaneUnavailableError) return controlPlaneUnavailableResponse();
      throw error;
    }
  },
} satisfies ExportedHandler<WorkerEnv>;

async function handleRequest(request: Request, env: WorkerEnv, _ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      await discardBody(request);
      return methodNotAllowed("GET, HEAD");
    }
    return Response.json({
      ok: true,
      service: "runmesh-agent-control-plane",
      worker_version: PRODUCT_VERSION,
      mcp_catalog: MCP_CATALOG_SUMMARY,
      runtime_configuration: { schema: "minimal-v1", required_secrets: ["INTERNAL_CONTROL_SECRET", "RUNNER_TOKEN_PEPPER"], manual_public_origin_required: false },
      ui: { locale_rendering: "server-v1", refresh: "explicit" },
      job_queue: { protocol: 1, default_capacity: 32, default_per_client: 8, requires_compatible_runner: true },
      release_readiness: { contract: "release-chain-audit-v1", rpc_authorization_complete: ProtectedRpcMethodSchema.options.every((method) => rpcPermissionRequirement(method) !== undefined) },
      worker_id: env.WORKER_ID,
      deployment: { branch: env.RUNMESH_DEPLOYMENT_BRANCH === "main" || env.RUNMESH_DEPLOYMENT_BRANCH === "dev" ? env.RUNMESH_DEPLOYMENT_BRANCH : null, commit: /^[a-f0-9]{40}$/.test(env.RUNMESH_DEPLOYMENT_COMMIT ?? "") ? env.RUNMESH_DEPLOYMENT_COMMIT : null },
      release_gate: releaseGateDiagnostics(env),
      job_history: { backend: env.RUNMESH_JOB_HISTORY_BACKEND === "d1" ? "packed_d1" : "sqlite", protocol: 1, default_interval_seconds: 300, max_snapshot_jobs: 500 },
      audit_history: { backend: env.RUNMESH_AUDIT_BACKEND === "d1" ? "d1" : "durable_object", binding_configured: env.RUNMESH_AUDIT_BACKEND !== "d1" || env.HISTORY_DB !== undefined },
    });
  }
  if (url.pathname === "/assets/logo.png" || url.pathname === BRAND_LOGO_ASSET || url.pathname === "/assets/favicon.png") return asset(request, env);
  if (url.pathname === "/runner/uninstall.sh" || url.pathname === "/runner/uninstall.ps1") return runnerUninstallScript(request, env, url.pathname.endsWith(".ps1"));
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
  /** Test-harness-only switch; never configured by a deployment. */
  readonly RUNMESH_TEST_MODE?: string;
}

export function releaseGateDiagnostics(env: RunnerReleaseEnvironment): ReleaseGateDiagnostics {
  let canonicalPublicOriginConfigured = false;
  try { canonicalPublicOriginConfigured = env.RUNMESH_PUBLIC_ORIGIN !== undefined && canonicalPublicOrigin(env.RUNMESH_PUBLIC_ORIGIN).length > 0; } catch { canonicalPublicOriginConfigured = false; }
  return {
    acknowledgement_matches_fixed_release: signedReleaseIsAvailable(env.RUNMESH_SIGNED_RELEASE_AVAILABLE),
    canonical_public_origin_configured: canonicalPublicOriginConfigured,
    test_mode_disabled: env.RUNMESH_TEST_MODE !== "1",
  };
}

export function runnerReleaseDescriptor(env: RunnerReleaseEnvironment): RunnerReleaseDescriptor {
  const gate = releaseGateDiagnostics(env);
  const distributable = gate.acknowledgement_matches_fixed_release && gate.canonical_public_origin_configured && gate.test_mode_disabled;
  return { ...fixedReleaseDescriptor(distributable), protocol: { min_version: PROTOCOL_MIN_VERSION, max_version: PROTOCOL_CURRENT_VERSION } };
}
function runnerRelease(request: Request, env: WorkerEnv): Response {
  if (request.method !== "GET" && request.method !== "HEAD") { void discardBody(request); return methodNotAllowed("GET, HEAD"); }
  const descriptor = runnerReleaseDescriptor(env);
  return new Response(JSON.stringify({ ...descriptor, schema_version: 1, published_at: null }), { headers: publicInstallerHeaders("application/json; charset=utf-8") });
}
function runnerInstallScript(request: Request, url: URL, env: RunnerReleaseEnvironment): Response {
  if (request.method !== "GET" && request.method !== "HEAD") { void discardBody(request); return methodNotAllowed("GET, HEAD"); }
  const modes = url.searchParams.getAll("execution_mode");
  const mode = modes[0] ?? "privileged_host";
  if (modes.length > 1 || (mode !== "dedicated_user" && mode !== "privileged_host")) return new Response("invalid installer execution mode", { status: 400, headers: { "cache-control": "no-store" } });
  const descriptor = runnerReleaseDescriptor(env);
  let content: string;
  if (descriptor.distributable) {
    try { content = renderPosixInstaller(resolvePublicOrigin(request, configuredPublicOrigin(env)), mode); }
    catch { return installerOriginUnavailable(); }
  } else {
    content =
`#!/usr/bin/env sh
set -eu
printf '%s\\n' 'error: The fixed signed Runmesh v${FIXED_RELEASE_VERSION} release is not enabled on this deployment.' 'Use the manual verified portable-artifact route until the exact immutable release is available.' >&2
exit 1
`;
  }
  return new Response(content, { headers: publicInstallerHeaders("text/x-shellscript; charset=utf-8") });
}
function runnerInstallPowerShell(request: Request, url: URL, env: RunnerReleaseEnvironment): Response {
  if (request.method !== "GET" && request.method !== "HEAD") { void discardBody(request); return methodNotAllowed("GET, HEAD"); }
  const modes = url.searchParams.getAll("execution_mode");
  const mode = modes[0] ?? "privileged_host";
  if (modes.length > 1 || (mode !== "dedicated_user" && mode !== "privileged_host")) return new Response("invalid installer execution mode", { status: 400, headers: { "cache-control": "no-store" } });
  const descriptor = runnerReleaseDescriptor(env);
  let content: string;
  if (descriptor.distributable) {
    try { content = renderPowerShellInstaller(resolvePublicOrigin(request, configuredPublicOrigin(env)), mode); }
    catch { return installerOriginUnavailable(); }
  } else {
    content = `$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Write-Error 'The fixed signed Runmesh v${FIXED_RELEASE_VERSION} release is not enabled on this deployment. Use the manual verified portable-artifact route until the exact immutable release is available.'
exit 1
`;
  }
  return new Response(content, { headers: publicInstallerHeaders("text/plain; charset=utf-8") });
}
function runnerUninstallScript(request: Request, env: RunnerReleaseEnvironment, windows: boolean): Response {
  if (request.method !== "GET" && request.method !== "HEAD") { void discardBody(request); return methodNotAllowed("GET, HEAD"); }
  if (!runnerReleaseDescriptor(env).distributable) return new Response("Runmesh maintenance download is not enabled on this deployment", { status: 503, headers: { "cache-control": "no-store" } });
  try {
    const origin = resolvePublicOrigin(request, configuredPublicOrigin(env));
    const script = windows ? renderPowerShellUninstaller(origin) : renderPosixUninstaller(origin);
    const headers = publicInstallerHeaders(windows ? "text/plain; charset=utf-8" : "text/x-shellscript; charset=utf-8");
    headers.set("cache-control", "no-store");
    return new Response(script, { headers });
  } catch { return installerOriginUnavailable(); }
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
  if (code === undefined || publicInfo === undefined || !isConfiguredSecret(env.RUNNER_TOKEN_PEPPER) || !isConfiguredSecret(env.INTERNAL_CONTROL_SECRET)) return enrollmentError();
  // Resolve the endpoint that will be persisted before consuming the one-time
  // code. This prevents a successful enrollment from returning an attacker-
  // controlled or unusable reconnect URL when the request arrived through a
  // misconfigured proxy.
  let publicOrigin: string;
  try { publicOrigin = resolveConnectionOrigin(request, configuredPublicOrigin(env)); } catch { return installerOriginUnavailable(); }
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
    if (state?.mutation_committed === true) { try { await revokeRunnerTransport(env, runnerId, mutationId, true); } catch { /* fail closed */ } }
    return enrollmentUnavailable();
  }
  if (!response.ok) {
    const state = await runnerMutationState(env, runnerId, mutationId).catch(() => undefined);
    if (state?.mutation_committed === true) {
      try { await revokeRunnerTransport(env, runnerId, mutationId, true); } catch { /* Registry credential is authoritative */ }
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
  try { await revokeRunnerTransport(env, runnerId, mutationId, true); }
  catch { return enrollmentUnavailable(); }
  const connectUrl = new URL("/runner/connect", publicOrigin).toString();
  return Response.json({ runner_id: runnerId, server_url: connectUrl, token }, { headers: credentialHeaders("application/json; charset=utf-8") });
}
function runnerPublicInfo(value: unknown): RunnerPublicInfo | undefined {
  const item = record(value);
  if (item === undefined || !safeDisplayText(item.platform, 128) || !safeDisplayText(item.architecture, 128) || !safeDisplayText(item.hostname, 256) || !safeDisplayText(item.runner_version, 256) || typeof item.protocol_version !== "number") return undefined;
  const info: RunnerPublicInfo = {
    platform: item.platform,
    architecture: item.architecture,
    hostname: item.hostname,
    runner_version: item.runner_version,
    protocol_version: item.protocol_version,
    ...(item.execution_mode === "dedicated_user" || item.execution_mode === "privileged_host" ? { execution_mode: item.execution_mode } : {}),
    ...(typeof item.service_identity === "string" && safeDisplayText(item.service_identity, 512) ? { service_identity: item.service_identity } : {}),
    ...(item.privilege_state === "privileged" || item.privilege_state === "restricted" || item.privilege_state === "mismatch" || item.privilege_state === "unknown" ? { privilege_state: item.privilege_state } : {}),
  };
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
  let forwarded: Request;
  if (request.method === "POST") {
    const body = await readCappedBytes(request, MAX_MCP_BODY_BYTES);
    if (body === undefined) return new Response("request body too large", { status: 413, headers: publicInstallerHeaders("text/plain; charset=utf-8") });
    forwarded = new Request(rewritten, { method: request.method, headers: request.headers, body: body.buffer as ArrayBuffer });
  } else {
    forwarded = new Request(rewritten, request);
  }
  const auth: McpAuth = {
    // AuthInfo needs an opaque token but no component needs the raw URL secret.
    token: verified.client_id,
    clientId: verified.client_id,
    scopes: [...verified.scopes],
    extra: { client_label: verified.label, secret_version: verified.secret_version },
  };
  const [{ createMcpHandler }, { createCodingMcpServer }] = await Promise.all([
    import("agents/mcp/server"),
    import("./mcp/server.js"),
  ]);
  const handler = createMcpHandler(
    () => createCodingMcpServer(env, auth),
    {
      route: "/mcp",
      // Safe identity only. The raw secret is intentionally absent.
      authContext: { props: { client_id: verified.client_id, client_label: verified.label, scopes: [...verified.scopes], secret_version: verified.secret_version } },
      legacy: "stateless",
    },
  );
  const response = await handler.fetch(forwarded, { authInfo: auth });
  // The MCP credential is carried in the request path.  Do not allow an SDK
  // response (or an intermediary) to cache that path or disclose it through
  // a referrer when a client follows a response link.  These headers also
  // keep the JSON/SSE endpoint from becoming an embeddable cross-origin
  // document if a future SDK response changes its content type.
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
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
  if (!sessionResponse.ok) return adminError(503, "Login could not be completed. Try again.");
  return redirect("/admin", [sessionCookie(rawSession), csrfCookie(rawCsrf), clearCookie(LOGIN_CSRF_COOKIE)]);
}

async function handleBrowserAdmin(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const session = await adminSession(request, env);
  if (session === undefined) { if (request.method !== "GET") await discardBody(request); return redirect("/", [clearCookie(ADMIN_SESSION_COOKIE), clearCookie(ADMIN_CSRF_COOKIE)]); }
  if (request.method === "GET" && ["/admin", "/admin/runners", "/admin/clients", "/admin/settings"].includes(url.pathname)) {
    const csrf = cookieValue(request, ADMIN_CSRF_COOKIE);
    if (csrf === undefined || !constantTimeEqual(await sha256Hex(csrf), session.csrf_hash)) return redirect("/", [clearCookie(ADMIN_SESSION_COOKIE), clearCookie(ADMIN_CSRF_COOKIE)]);
    const data = await loadDashboardData(env, url.pathname === "/admin" && url.searchParams.get("history") === "1" && env.RUNMESH_JOB_HISTORY_BACKEND !== "d1");
    return html(adminPage(url.pathname, data, csrf));
  }
  const runnerDetail = /^\/admin\/runners\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/.exec(url.pathname);
  const jobDetail = /^\/admin\/runners\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/jobs\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/.exec(url.pathname);
  if (request.method === "GET" && jobDetail !== null) {
    const csrf = cookieValue(request, ADMIN_CSRF_COOKIE);
    if (csrf === undefined || !constantTimeEqual(await sha256Hex(csrf), session.csrf_hash)) return redirect("/", [clearCookie(ADMIN_SESSION_COOKIE), clearCookie(ADMIN_CSRF_COOKIE)]);
    const runnerId = jobDetail[1] as string;
    const page = await loadAdminJobPage(url, runnerId, jobDetail[2] as string, (path) => registryGet(env, path), async (params) => {
      const readiness = await policyReadiness(env, runnerId);
      return readiness.ok ? runnerRpc(env, runnerId, "job.logs", params, readiness.value.applied_revision, readiness.value.active_checksum) : undefined;
    }, async (params) => {
      const readiness = await policyReadiness(env,runnerId);
      return readiness.ok ? runnerRpc(env,runnerId,"job.get",params,readiness.value.applied_revision,readiness.value.active_checksum) : undefined;
    });
    return page.ok ? html(adminDocument(page.title, page.body, "runners")) : adminError(page.status, page.message);
  }
  const clientDetail = /^\/admin\/clients\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})(?:\/scopes\/detail)?$/.exec(url.pathname);
  if (request.method === "GET" && clientDetail !== null) {
    const csrf = cookieValue(request, ADMIN_CSRF_COOKIE);
    if (csrf === undefined || !constantTimeEqual(await sha256Hex(csrf), session.csrf_hash)) return redirect("/", [clearCookie(ADMIN_SESSION_COOKIE), clearCookie(ADMIN_CSRF_COOKIE)]);
    const [clientResponse, runnersResponse, overridesResponse, notices] = await Promise.all([
      registryGet(env, `/auth/clients`),
      registryGet(env, "/runners"),
      registryGet(env, `/auth/clients/${encodeURIComponent(clientDetail[1] as string)}/runner-overrides`),
      loadFeatureNotices(env),
    ]);
    let clients: unknown[] = [];
    try { clients = clientResponse.ok ? arrayField(record(await json(clientResponse))?.clients) : []; } catch { clients = []; }
    const client = clients.map(record).find((item) => item?.client_id === clientDetail[1]);
    let runners: RunnerRecord[] = [];
    let overrides: Record<string, unknown>[] = [];
    try { runners = runnersResponse.ok ? arrayField(record(await json(runnersResponse))?.runners).filter(record) as RunnerRecord[] : []; } catch { runners = []; }
    try { overrides = overridesResponse.ok ? arrayField(record(await json(overridesResponse))?.overrides).flatMap((item) => { const value = record(item); return value === undefined ? [] : [value]; }) : []; } catch { overrides = []; }
    return client === undefined ? adminError(404, "MCP client was not found.") : html(adminDocument(`${typeof client.label === "string" ? client.label : clientDetail[1]} · MCP Client`, await clientDetailPage(client, runners, overrides as Record<string, unknown>[], csrf), "clients", notices));
  }

  if (request.method === "GET" && runnerDetail !== null) {
    const csrf = cookieValue(request, ADMIN_CSRF_COOKIE);
    if (csrf === undefined || !constantTimeEqual(await sha256Hex(csrf), session.csrf_hash)) return redirect("/", [clearCookie(ADMIN_SESSION_COOKIE), clearCookie(ADMIN_CSRF_COOKIE)]);
    const runnerId = runnerDetail[1] as string;
    const view = historyView(url);
    if (view === undefined) return adminError(400,"Invalid history query.");
    const [runnerResponse, workspaceResponse, jobsResponse, mcpCallsResponse, policyVersionsResponse, enrollmentResponse, environment, releaseResponse, notices, historyResponse] = await Promise.all([
      registryGet(env, `/runners/${encodeURIComponent(runnerId)}`),
      registryGet(env, `/auth/runners/${encodeURIComponent(runnerId)}/managed-workspaces`),
      view.scope === "live" ? loadLiveJobs(env,runnerId,view.workspace!,view.limit) : (view.scope === "jobs" || view.scope === "all") ? registryGet(env, `/runners/${encodeURIComponent(runnerId)}/jobs?limit=${view.limit}`) : Promise.resolve(new Response(null,{status:204})),
      (view.scope === "audit" || view.scope === "all") ? registryGet(env, `/runners/${encodeURIComponent(runnerId)}/mcp-calls?limit=${view.limit}`) : Promise.resolve(new Response(null,{status:204})),
      registryGet(env, `/runners/${encodeURIComponent(runnerId)}/policy-versions`),
      registryGet(env, `/auth/runners/${encodeURIComponent(runnerId)}/enrollments`),
      runnerEnvironment(env, runnerId),
      Promise.resolve(runnerReleaseDescriptor(env)),
      loadFeatureNotices(env),
      registryGet(env, `/runners/${encodeURIComponent(runnerId)}/history-settings`),
    ]);
    const settings = historyResponse.ok ? parseJobHistorySettings(await json(historyResponse)) : undefined;
    let runner: Record<string, unknown> | undefined;
    let workspaces: unknown[] = [];
    let jobs: unknown[] | undefined;
    let mcpCalls: unknown[] | undefined;
    let policyVersions: unknown[] = [];
    let enrollment: Record<string, unknown> | undefined;
    try { runner = runnerResponse.ok ? record(await json(runnerResponse)) : undefined; } catch { runner = undefined; }
    try { workspaces = workspaceResponse.ok ? arrayField(record(await json(workspaceResponse))?.workspaces) : []; } catch { workspaces = []; }
    try { const value = jobsResponse.ok ? record(await json(jobsResponse))?.jobs : undefined; jobs = Array.isArray(value) ? value : undefined; } catch { jobs = undefined; }
    try { mcpCalls = mcpCallsResponse.ok ? arrayField(record(await json(mcpCallsResponse))?.calls) : undefined; } catch { mcpCalls = undefined; }
    try { policyVersions = policyVersionsResponse.ok ? arrayField(record(await json(policyVersionsResponse))?.versions) : []; } catch { policyVersions = []; }
    try { enrollment = enrollmentResponse.ok ? record(record(await json(enrollmentResponse))?.enrollment) : undefined; } catch { enrollment = undefined; }
    return runner === undefined ? adminError(404, "Runner was not found.") : html(adminDocument(`${typeof runner.display_name === "string" ? runner.display_name : runnerId} · Runner`, runnerDetailPage({ configuredMode: runnerConfiguredExecutionMode(runner), reportedMode: runnerReportedExecutionMode(runner), maxValidityDays: MAX_VALIDITY_DAYS, dayMs: DAY_MS }, runner, workspaces, jobs, environment, csrf, releaseResponse, policyVersions, enrollment, mcpCalls, view, settings), "runners", notices));
  }
  if (request.method !== "POST") { await discardBody(request); return methodNotAllowed("GET, POST"); }
  const form = await formData(request);
  if (form === undefined || !await verifyAdminPost(request, form, session, env)) return adminError(403, "Administrative request was rejected.");
  // Generated enrollment/MCP URLs must use the deployment's canonical public
  // origin when configured. Local development intentionally has no config and
  // may use HTTP; copied manual commands still quote this derived origin.
  let publicOrigin: string;
  try {
    publicOrigin = resolveConnectionOrigin(request, configuredPublicOrigin(env));
  } catch { return installerOriginUnavailable(); }
  if (url.pathname === "/admin/logout") {
    await registryPost(env, "/auth/sessions/logout", { session_hash: session.hash });
    return redirect("/", [clearCookie(ADMIN_SESSION_COOKIE), clearCookie(ADMIN_CSRF_COOKIE)]);
  }
  const historyAction = /^\/admin\/runners\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/history-settings$/.exec(url.pathname);
  if (historyAction !== null) {
    const settings = parseJobHistorySettings({mode:form.get("mode"),interval_seconds:Number(form.get("interval_seconds")),retention_days:Number(form.get("retention_days")),local_retention_days:Number(form.get("local_retention_days"))});
    if (settings === undefined || (settings.local_retention_days > 0 && form.get("confirm_local_cleanup") !== "true")) return adminError(400,"Invalid settings or local cleanup not confirmed.");
    const response = await registryPost(env,`/runners/${encodeURIComponent(historyAction[1]!)}/history-settings`,{...settings});
    return response.ok ? redirect(`/admin/runners/${encodeURIComponent(historyAction[1]!)}`) : adminError(response.status === 404 ? 404 : 503,"History settings could not be saved.");
  }
  if (url.pathname === "/admin/password") return changePassword(env, form);
  if (url.pathname === "/admin/clients") return createClient(env, form, publicOrigin);
  if (url.pathname === "/admin/runners") return createBrowserRunner(env, form, publicOrigin);
  const runnerMatch = /^\/admin\/runners\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/(rename|rotate|revoke|delete|enrollment|validity|permissions|version-policy|emergency-lock|workspace-create|workspace-update|workspace-delete)$/.exec(url.pathname);
  if (runnerMatch !== null) return handleBrowserRunnerAction(env, form, publicOrigin, runnerMatch[1] as string, runnerMatch[2] as "rename" | "rotate" | "revoke" | "delete" | "enrollment" | "validity" | "permissions" | "version-policy" | "emergency-lock" | "workspace-create" | "workspace-update" | "workspace-delete");
  const clientMatch = /^\/admin\/clients\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/(rename|rotate|revoke|reset-runner|select-runner|active-runner|override|reset-override|scopes|recording)$/.exec(url.pathname);
  if (clientMatch === null) return notFound();
  const clientId = clientMatch[1] as string; const action = clientMatch[2] as "rename" | "rotate" | "revoke" | "reset-runner" | "select-runner" | "active-runner" | "override" | "reset-override" | "scopes" | "recording";
  if (action === "recording") {
    const value = form.get("record_jobs");
    if (value !== "true" && value !== "false") return adminError(400, "Recording preference is invalid.");
    const response = await registryPost(env, `/auth/clients/${encodeURIComponent(clientId)}/recording`, { record_jobs: value === "true" });
    if (response.status >= 500 || response.status === 429) return controlPlaneUnavailableResponse(response);
    return response.ok ? redirect(`/admin/clients/${encodeURIComponent(clientId)}`) : adminError(response.status === 404 ? 404 : 400, "Recording preference could not be updated.");
  }
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
  if (action === "select-runner" || action === "active-runner") {
    const runnerId = form.get("runner_id");
    if (typeof runnerId !== "string" || !isSafeIdentifier(runnerId)) return adminError(400, "Runner identifier is invalid.");
    const confirmValue = form.get("confirm_switch");
    const confirmSwitch = confirmValue === "true" || confirmValue === "on" || confirmValue === "1";
    const response = await registryPost(env, `/auth/clients/${encodeURIComponent(clientId)}/active-runner`, { runner_id: runnerId, confirm_switch: confirmSwitch });
    if (response.ok) return redirect(`/admin/clients/${encodeURIComponent(clientId)}`);
    if (response.status === 409) {
      let code: unknown;
      try { code = record(await response.json())?.code; } catch { code = undefined; }
      return adminError(409, code === "runner_unavailable" ? "The selected Runner is unavailable or has not completed enrollment." : "A different Runner is already selected. Check Confirm switch and try again.");
    }
    return adminError(response.status === 404 ? 404 : 400, "Runner selection could not be updated.");
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

type ConsoleExecutionMode = RunnerExecutionMode;
type ExecutionModeSelection = { readonly mode: ConsoleExecutionMode; readonly confirmed: boolean };
type RunnerExecutionSnapshot = {
  readonly runner: Record<string, unknown>;
  readonly configuredMode: ConsoleExecutionMode | null;
  readonly lifecycleId: string;
};
type RunnerExecutionSnapshotResult = { readonly status: number; readonly snapshot?: RunnerExecutionSnapshot };
type RunnerExecutionExpectation = { readonly configuredMode: ConsoleExecutionMode | null; readonly lifecycleId: string };
type EnrollmentWindow = { readonly not_before_ms?: number; readonly expires_at_ms?: number };
type EnrollmentCodeResult =
  | { readonly ok: true; readonly code: string; readonly created_at_ms: number; readonly not_before_ms: number; readonly expires_at_ms: number }
  | { readonly ok: false; readonly status: number; readonly deterministic: boolean };

function expectedConfiguredMode(snapshot: RunnerExecutionSnapshot): ConsoleExecutionMode | null {
  return snapshot.configuredMode;
}

function formDays(form: FormData, name: string): number | null | undefined {
  const value = form.get(name);
  if (value === null) return undefined;
  if (value === "") return null;
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return undefined;
  const days = Number(value);
  return Number.isSafeInteger(days) && days <= MAX_VALIDITY_DAYS ? days : undefined;
}
function runnerWindowFromForm(form: FormData): ValidityWindow | undefined {
  if (!form.has("runner_valid_days")) return { valid_from_ms: null, valid_until_ms: null };
  const days = formDays(form, "runner_valid_days");
  if (days === undefined) return undefined;
  return { valid_from_ms: null, valid_until_ms: days === null || days === 0 ? null : Date.now() + days * DAY_MS };
}
function enrollmentWindowFromForm(form: FormData): EnrollmentWindow | undefined {
  if (!form.has("code_valid_days")) return {};
  const days = formDays(form, "code_valid_days");
  if (days === undefined) return undefined;
  return days === null || days < 1 ? undefined : { expires_at_ms: Date.now() + days * DAY_MS };
}
function formEnrollmentTtl(form: FormData): number | undefined {
  const value = form.get("enrollment_ttl_ms");
  if (value === null || value === "") return DEFAULT_RUNNER_ENROLLMENT_TTL_MS;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && (RUNNER_ENROLLMENT_TTL_OPTIONS_MS as readonly number[]).includes(parsed) ? parsed : undefined;
}

/**
 * Parse a fresh administrator service-mode choice at the authenticated form
 * boundary. New Runner records must always carry an explicit mode.
 */
function executionModeFromForm(form: FormData): ExecutionModeSelection | undefined {
  const raw = form.get("execution_mode");
  let mode: ConsoleExecutionMode;
  if (raw === "dedicated_user" || raw === "privileged_host") mode = raw;
  else return undefined;
  const confirmed = form.getAll("confirm_privileged_host").some((value) => value === "true");
  if (mode === "privileged_host" && !confirmed) return undefined;
  return { mode, confirmed: mode === "privileged_host" && confirmed };
}

/**
 * Resolve an action form against the server-owned Registry choice. The
 * execution mode is configuration, not Runner-authored telemetry. Reusing an existing privileged choice is
 * intentional—the administrator already acknowledged that high-risk mode at
 * installation/migration—so credential rotation and code regeneration do not
 * become a second privilege prompt.  A fresh transition to privileged_host
 * still requires the acknowledgement in the submitted form.
 */
function executionModeForExistingRunner(form: FormData, runner: { readonly configured_execution_mode?: unknown; readonly metadata?: unknown; readonly public_info?: unknown }): ExecutionModeSelection | undefined {
  const configured = runnerConfiguredExecutionMode(runner);
  const raw = form.get("execution_mode");
  const confirmed = form.getAll("confirm_privileged_host").some((value) => value === "true");
  const expectedRaw = form.get("expected_execution_mode");
  const expected = expectedRaw === "" ? null
    : expectedRaw === "dedicated_user" || expectedRaw === "privileged_host" ? expectedRaw
      : expectedRaw === null ? "missing" : "invalid";
  if (expected === "invalid" || expected === "missing" || expected !== configured) return undefined;
  if (raw === null) {
    return configured === null ? undefined : { mode: configured, confirmed: configured === "privileged_host" };
  }
  if (raw !== "dedicated_user" && raw !== "privileged_host") return undefined;
  if (raw === "privileged_host" && !confirmed && configured !== "privileged_host") return undefined;
  return { mode: raw, confirmed: raw === "privileged_host" };
}

/**
 * Read the server-owned administrator choice. `metadata` and `public_info`
 * are Runner-authored values, so they remain diagnostics only and can never
 * authorize a privileged installation. A null value means the record is not
 * ready for an administrative action until a mode is selected.
 */
export function runnerConfiguredExecutionMode(_runner: { readonly configured_execution_mode?: unknown; readonly metadata?: unknown; readonly public_info?: unknown }): ConsoleExecutionMode | null {
  return _runner.configured_execution_mode === "dedicated_user" || _runner.configured_execution_mode === "privileged_host"
    ? _runner.configured_execution_mode : null;
}

/** Runner-authored evidence is useful for diagnostics, but is not config. */
function runnerReportedExecutionMode(runner: { readonly metadata?: unknown; readonly public_info?: unknown }): ConsoleExecutionMode | "unknown" {
  const metadata = record(runner.metadata);
  if (metadata?.execution_mode === "dedicated_user" || metadata?.execution_mode === "privileged_host") return metadata.execution_mode;
  const info = record(runner.public_info);
  if (info?.execution_mode === "dedicated_user" || info?.execution_mode === "privileged_host") return info.execution_mode;
  return "unknown";
}

/**
 * Read the Registry-owned mode together with the opaque lifecycle identity
 * used by transport fencing.  The Registry returns both from one Durable
 * Object turn so a delete/recreate cannot be interleaved between the two
 * values.  The ordinary Runner projection intentionally omits lifecycle_id;
 * this authenticated internal seam never exposes it to dashboard/MCP callers.
 */
async function runnerExecutionSnapshot(env: WorkerEnv, runnerId: string): Promise<RunnerExecutionSnapshotResult> {
  let runnerResponse: Response;
  try { runnerResponse = await runnerRegistryRequest(env, runnerId, "/execution-state", "GET", ""); }
  catch { return { status: 503 }; }
  if (!runnerResponse.ok) return { status: runnerResponse.status };
  let body: Record<string, unknown> | undefined;
  try { body = record(await json(runnerResponse)); }
  catch { return { status: 502 }; }
  const runner = record(body?.runner);
  const lifecycleId = body?.lifecycle_id;
  if (runner === undefined || runner.runner_id !== runnerId || typeof lifecycleId !== "string" || lifecycleId.length === 0) return { status: 502 };
  return { status: 200, snapshot: { runner, configuredMode: runnerConfiguredExecutionMode(runner), lifecycleId } };
}

/** Release a pre-commit fence when a stale action is rejected before it can
 * touch Registry credentials or enrollment state.  If cancellation cannot be
 * proven, callers deliberately keep the fence and return a safe 503. */
async function releaseUncommittedRunnerFence(env: WorkerEnv, runnerId: string, mutationId: string): Promise<boolean> {
  try {
    const cancelled = await cancelRunnerPolicyMutation(env, runnerId, mutationId);
    return cancelled.ok;
  } catch { return false; }
}

/** Action forms remain fail-closed until the Registry has a trusted mode. */

/**
 * Render mode fields for an authenticated action. Unconfigured rows render an
 * unselected mode so the administrator must make an explicit choice; configured rows carry the server-owned choice through the
 * form. The enrollment result uses the non-interactive variant only to bind
 * the form to the mode observed when that one-time code was rendered; the
 * destination mode is never replayed from a hidden field.
 */

async function createBrowserRunner(env: WorkerEnv, form: FormData, baseUrl: string): Promise<Response> {
  const submittedId = form.get("runner_id"); const displayName = form.get("display_name");
  const selection = executionModeFromForm(form);
  if (selection === undefined) return adminError(400, "Runner execution mode or privileged-host confirmation is invalid.");
  const runnerValidity = runnerWindowFromForm(form);
  const enrollmentWindow = enrollmentWindowFromForm(form); const enrollmentTtlMs = formEnrollmentTtl(form);
  if (runnerValidity === undefined || enrollmentWindow === undefined || enrollmentTtlMs === undefined) return adminError(400, "Runner or enrollment validity settings are invalid.");
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
  try { response = await runnerRegistryRequest(env, runnerId, "/add", "POST", JSON.stringify({ display_name: displayName, mutation_id: mutationId, execution_mode: selection.mode, confirm_privileged_host: selection.confirmed, valid_from_ms: runnerValidity.valid_from_ms, valid_until_ms: runnerValidity.valid_until_ms })); }
  catch { response = new Response("registry unavailable", { status: 503 }); }
  if (!response.ok) {
    const settled = await settleRunnerMutation(env, runnerId, mutationId, true);
    if (settled === "uncertain") return adminError(503, "Runner creation outcome is uncertain; Runner remains safely fenced.");
    return adminError(response.status >= 500 ? 503 : response.status === 409 ? 409 : 400, "Runner could not be added.");
  }
  const committed = await runnerMutationState(env, runnerId, mutationId).catch(() => undefined);
  if (committed?.mutation_committed !== true) return adminError(503, "Runner creation outcome is uncertain; Runner remains safely fenced.");
  const lifecycleId = typeof committed.lifecycle_id === "string" && committed.lifecycle_id.length > 0 ? committed.lifecycle_id : undefined;
  if (lifecycleId === undefined) return adminError(503, "Runner enrollment state is uncertain; Runner remains safely fenced.");
  const codeResult = await createEnrollmentCode(env, runnerId, selection, { configuredMode: selection.mode, lifecycleId }, enrollmentTtlMs, enrollmentWindow);
  if (!codeResult.ok) {
    if (codeResult.deterministic) {
      const settled = await settleRunnerMutation(env, runnerId, mutationId, true);
      if (settled === "uncertain") return adminError(503, "Runner enrollment code state is uncertain; Runner remains safely fenced.");
      return adminError(codeResult.status === 404 ? 404 : 409, codeResult.status === 404 ? "Runner enrollment target was not found." : "Runner state changed; reload the Runner page and retry.");
    }
    return adminError(503, "Runner enrollment code could not be created; Runner remains safely fenced.");
  }
  const code = codeResult.code;
  // /add creates an offline central row (credential_version 0), so revoke is
  // used here as a transport finalizer: it closes any stale sockets and clears
  // the fence without changing the central row or its enrollment semantics.
  // Keep the fence while creating the enrollment code; a concurrent delete or
  // rotation must not slip between finalization and code issuance.
  try { await revokeRunnerTransport(env, runnerId, mutationId, true); }
  catch { return adminError(503, "Runner creation cleanup is uncertain; Runner remains safely fenced."); }
  return runnerEnrollmentPage(env, baseUrl, runnerId, code, String(form.get("csrf_token") ?? ""), false, selection.mode, selection.confirmed, codeResult);
}
async function handleBrowserRunnerAction(env: WorkerEnv, form: FormData, baseUrl: string, runnerId: string, action: "rename" | "rotate" | "revoke" | "delete" | "enrollment" | "validity" | "permissions" | "version-policy" | "emergency-lock" | "workspace-create" | "workspace-update" | "workspace-delete"): Promise<Response> {
  const enrollmentWindow = action === "rotate" || action === "enrollment" ? enrollmentWindowFromForm(form) : undefined;
  const enrollmentTtlMs = action === "rotate" || action === "enrollment" ? formEnrollmentTtl(form) : undefined;
  if ((action === "rotate" || action === "enrollment") && (enrollmentWindow === undefined || enrollmentTtlMs === undefined)) return adminError(400, "Enrollment validity settings are invalid.");
  if (action === "validity") {
    const window = runnerWindowFromForm(form);
    if (window === undefined) return adminError(400, "Runner authorization validity settings are invalid.");
    const state = await runnerExecutionSnapshot(env, runnerId);
    if (state.snapshot === undefined) return adminError(state.status === 404 ? 404 : 503, "Runner authorization could not read the Runner state.");
    const response = await registryPost(env, `/auth/runners/${encodeURIComponent(runnerId)}/validity`, { valid_from_ms: window.valid_from_ms, valid_until_ms: window.valid_until_ms, expected_lifecycle_id: state.snapshot.lifecycleId });
    return response.ok ? redirect(`/admin/runners/${encodeURIComponent(runnerId)}`) : adminError(response.status === 404 ? 404 : response.status === 409 ? 409 : 400, "Runner authorization validity could not be updated.");
  }
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
    const initialState = await runnerExecutionSnapshot(env, runnerId);
    if (initialState.snapshot === undefined) return adminError(initialState.status === 404 ? 404 : 503, initialState.status === 404 ? "Runner was not found." : "Runner credential rotation could not read the Runner state.");
    const selection = executionModeForExistingRunner(form, initialState.snapshot.runner);
    if (selection === undefined) return adminError(400, "Runner execution mode must be selected explicitly; privileged-host mode also requires confirmation.");
    // Registry state can lag a live RunnerDO/socket (for example after a
    // heartbeat timeout). Acquire the fence after resolving the trusted mode
    // so a stale browser form cannot mutate configuration first.
    const fenced = await fenceRunnerTransport(env, runnerId, mutationId);
    if (!fenced.ok) return adminError(503, "Runner credential rotation could not fence the Runner.");
    const fencedState = await runnerExecutionSnapshot(env, runnerId);
    if (fencedState.snapshot === undefined || fencedState.snapshot.lifecycleId !== initialState.snapshot.lifecycleId || fencedState.snapshot.configuredMode !== initialState.snapshot.configuredMode) {
      const released = await releaseUncommittedRunnerFence(env, runnerId, mutationId);
      if (!released) return adminError(503, "Runner credential rotation state is uncertain; Runner remains safely fenced.");
      return adminError(fencedState.status === 404 ? 404 : 409, fencedState.status === 404 ? "Runner was not found." : "Runner state changed; reload the Runner page and retry.");
    }
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
    const codeResult = await createEnrollmentCode(env, runnerId, selection, { configuredMode: expectedConfiguredMode(fencedState.snapshot), lifecycleId: fencedState.snapshot.lifecycleId }, enrollmentTtlMs, enrollmentWindow);
    if (!codeResult.ok) {
      if (codeResult.deterministic) {
        const settled = await settleRunnerMutation(env, runnerId, mutationId, true);
        if (settled === "uncertain") return adminError(503, "Enrollment code state is uncertain; Runner remains safely fenced.");
        return adminError(codeResult.status === 404 ? 404 : 409, codeResult.status === 404 ? "Runner was not found." : "Runner state changed; reload the Runner page and retry.");
      }
      return adminError(503, "Enrollment code could not be generated; Runner remains safely fenced.");
    }
    const code = codeResult.code;
    try { await revokeRunnerTransport(env, runnerId, mutationId, true); }
    catch { return adminError(503, "Runner credential cleanup is uncertain; Runner remains safely fenced."); }
    return runnerEnrollmentPage(env, baseUrl, runnerId, code, String(form.get("csrf_token") ?? ""), true, selection.mode, selection.confirmed, codeResult);
  }
  if (action === "enrollment") {
    const mutationId = `runner-enrollment-${crypto.randomUUID()}`;
    const initialState = await runnerExecutionSnapshot(env, runnerId);
    if (initialState.snapshot === undefined) return adminError(initialState.status === 404 ? 404 : 503, initialState.status === 404 ? "Runner was not found." : "Runner enrollment could not read the Runner state.");
    const selection = executionModeForExistingRunner(form, initialState.snapshot.runner);
    if (selection === undefined) return adminError(400, "Runner execution mode must be selected explicitly; privileged-host mode also requires confirmation.");
    // Enrollment-code regeneration does not change the credential generation,
    // but it is still a capability mutation. Hold the RunnerDO fence while
    // replacing the one-time code so a concurrent delete/rotate cannot make
    // the page describe a different lifecycle. Since no credential ledger
    // marker is committed by createEnrollmentCode, release this policy-style
    // fence with cancel rather than the credential-only /revoke finalizer.
    let fenced: Response;
    try { fenced = await beginRunnerPolicyMutation(env, runnerId, mutationId); }
    catch { return adminError(503, "Runner enrollment could not fence the Runner."); }
    if (!fenced.ok) return adminError(503, "Runner enrollment could not fence the Runner.");
    const fencedState = await runnerExecutionSnapshot(env, runnerId);
    if (fencedState.snapshot === undefined || fencedState.snapshot.lifecycleId !== initialState.snapshot.lifecycleId || fencedState.snapshot.configuredMode !== initialState.snapshot.configuredMode) {
      const released = await releaseUncommittedRunnerFence(env, runnerId, mutationId);
      if (!released) return adminError(503, "Runner enrollment state is uncertain; Runner remains safely fenced.");
      return adminError(fencedState.status === 404 ? 404 : 409, fencedState.status === 404 ? "Runner was not found." : "Runner state changed; reload the Runner page and retry.");
    }
    let codeResult: EnrollmentCodeResult;
    try { codeResult = await createEnrollmentCode(env, runnerId, selection, { configuredMode: expectedConfiguredMode(fencedState.snapshot), lifecycleId: fencedState.snapshot.lifecycleId }, enrollmentTtlMs, enrollmentWindow); }
    catch { codeResult = { ok: false, status: 503, deterministic: false }; }
    // A failed/ambiguous Registry response may still have committed the
    // one-time code. Do not release the fence in that case: no code is shown,
    // and a later reconciliation can safely determine the outcome.
    if (!codeResult.ok) {
      if (codeResult.deterministic) {
        const released = await releaseUncommittedRunnerFence(env, runnerId, mutationId);
        if (!released) return adminError(503, "Enrollment code state is uncertain; Runner remains safely fenced.");
        return adminError(codeResult.status === 404 ? 404 : 409, codeResult.status === 404 ? "Runner was not found." : "Runner state changed; reload the Runner page and retry.");
      }
      return adminError(503, "Enrollment code creation is uncertain; Runner remains safely fenced.");
    }
    const code = codeResult.code;
    try {
      const cancelled = await cancelRunnerPolicyMutation(env, runnerId, mutationId);
      if (!cancelled.ok) return enrollmentCleanupUnavailable(cancelled);
    } catch { return enrollmentCleanupUnavailable(); }
    return runnerEnrollmentPage(env, baseUrl, runnerId, code, String(form.get("csrf_token") ?? ""), true, selection.mode, selection.confirmed, codeResult);
  }
  return adminError(404, "Runner enrollment action is not available.");
}
/** Report the failed phase without exposing provider messages, enrollment codes or tokens. */
async function enrollmentCleanupUnavailable(upstream?: Response): Promise<Response> {
  const value = upstream === undefined ? undefined : record(await json(upstream));
  const candidate = record(value?.error)?.code;
  const safe = new Set(["mutation_state_changed", "mutation_mismatch", "mutation_committed", "mutation_uncertain", "no_active_mutation", "runner_unavailable", "registry_unavailable", "control_plane_unavailable"]);
  const code = typeof candidate === "string" && safe.has(candidate) ? candidate : "cleanup_unavailable";
  const response = adminError(503, `Enrollment code was created, but the temporary Runner safety lock could not be released. Diagnostic: ${code}. No enrollment code was disclosed. Regeneration does not require deleting or reinstalling the Runner.`);
  response.headers.set("x-runmesh-error-code", code);
  response.headers.set("x-runmesh-error-phase", "enrollment_fence_release");
  return response;
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

async function registryRequest(env: WorkerEnv, path: string, method: string, body: string, signal?: AbortSignal): Promise<Response> {
  const headers = await signedInternalHeaders(env, method, path, body);
  if (headers === undefined) return controlPlaneUnavailable();
  try {
    const init: RequestInit = { method, headers, ...(signal === undefined ? {} : { signal }), ...(body.length === 0 || method === "GET" || method === "HEAD" ? {} : { body }) };
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
  if (value === "edit_only") return { read: true, edit: true, shell: false, job_control: false };
  if (value === "controlled_exec" || value === "coding") return { read: true, edit: true, shell: true, job_control: true };
  if (value === "custom" || value === null) return undefined;
  return undefined;
}
function permissionsFromForm(form: FormData): { read: boolean; edit: boolean; shell: boolean; job_control: boolean } | undefined {
  const value = (name: string): boolean | undefined => { const entry = form.get(name); return entry === "true" ? true : entry === "false" ? false : undefined; };
  const read = value("read"); const edit = value("edit"); const shell = value("shell"); const jobControl = value("job_control");
  return read === undefined || edit === undefined || shell === undefined || jobControl === undefined ? undefined : { read, edit, shell, job_control: jobControl };
}

function isAbsolutePath(value: string): boolean { return value.length > 0 && value.length <= 4_096 && !value.includes("\0") && (/^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)); }

async function createEnrollmentCode(env: WorkerEnv, runnerId: string, selection?: ExecutionModeSelection, expected?: RunnerExecutionExpectation, enrollmentTtlMs = DEFAULT_RUNNER_ENROLLMENT_TTL_MS, window: EnrollmentWindow = {}): Promise<EnrollmentCodeResult> {
  const code = randomBase64Url();
  const response = await runnerRegistryRequest(env, runnerId, "/enrollments", "POST", JSON.stringify({
    enrollment_id: randomBase64Url(), verifier: await sha256Hex(code),
    enrollment_ttl_ms: enrollmentTtlMs, ...window,
    ...(selection === undefined ? {} : { execution_mode: selection.mode, confirm_privileged_host: selection.confirmed }),
    ...(expected === undefined ? {} : { expected_execution_mode: expected.configuredMode, expected_lifecycle_id: expected.lifecycleId }),
  }));
  if (!response.ok) return { ok: false, status: response.status, deterministic: [400, 404, 409].includes(response.status) };
  try {
    const value = record(await json(response));
    if (typeof value?.created_at_ms !== "number" || typeof value.not_before_ms !== "number" || typeof value.expires_at_ms !== "number" || !validTimestamp(value.created_at_ms) || !validTimestamp(value.not_before_ms) || !validTimestamp(value.expires_at_ms)) throw new Error("invalid enrollment response");
    return { ok: true, code, created_at_ms: value.created_at_ms, not_before_ms: value.not_before_ms, expires_at_ms: value.expires_at_ms };
  } catch { return { ok: false, status: 502, deterministic: false }; }
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
  if (!sameOrigin(request, configuredPublicOrigin(env))) return false;
  const supplied = form.get("csrf_token"); const cookie = cookieValue(request, ADMIN_CSRF_COOKIE);
  return typeof supplied === "string" && typeof cookie === "string" && constantTimeEqual(supplied, cookie) && constantTimeEqual(await sha256Hex(supplied), session.csrf_hash);
}
async function verifyPreAuthCsrf(request: Request, form: FormData, name: string, env: WorkerEnv): Promise<boolean> {
  if (!sameOrigin(request, configuredPublicOrigin(env))) return false;
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

function configuredPublicOrigin(env: { RUNMESH_PUBLIC_ORIGIN?: string; RUNMESH_TEST_MODE?: string }): string | undefined {
  return env.RUNMESH_TEST_MODE === "1" ? undefined : env.RUNMESH_PUBLIC_ORIGIN;
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

const FEATURE_LABELS: Record<RegistryFeatureHealth["feature"], string> = {
  job_recording: "Job recording",
  mcp_audit: "MCP call audit",
  mcp_usage_tracking: "MCP usage tracking",
  auth_throttle: "Login protection",
  maintenance_alarm: "Maintenance alarm",
};
const FEATURE_NOTICE_TEXT: Record<RegistryFeatureHealth["feature"], AdminNotice> = {
  job_recording: {
    title: "Job recording paused",
    message: "Job history and MCP call recording are temporarily disabled.",
  },
  mcp_audit: {
    title: "MCP call audit paused",
    message: "MCP call recording is temporarily disabled.",
  },
  mcp_usage_tracking: {
    title: "MCP usage tracking paused",
    message: "MCP authentication remains available; last-used telemetry is temporarily disabled.",
  },
  auth_throttle: {
    title: "Login protection paused",
    message: "Administrator login remains available; persistent login throttling is temporarily disabled.",
  },
  maintenance_alarm: {
    title: "Maintenance alarm paused",
    message: "Background cleanup and stale-runner checks are temporarily disabled.",
  },
};
const FEATURE_STATUS_UNAVAILABLE_NOTICE: AdminNotice = {
  title: "Feature health status unavailable",
  message: "Core Runner and MCP paths remain available; retry the console shortly.",
};
async function loadDashboardData(env: WorkerEnv, includeJobs = true): Promise<AdminData> {
  // The dashboard includes persisted job summaries. Other top-level pages do
  // not need job queries, and no page load performs a live Runner job scan.
  const [clientsResponse, snapshotResponse, notices] = await Promise.all([
    registryGet(env, "/auth/clients"), registryGet(env, includeJobs ? "/dashboard" : "/runners"), loadFeatureNotices(env),
  ]);
  let clients: McpClientRecord[] = [];
  try { clients = clientsResponse.ok ? ((record(await json(clientsResponse))?.clients ?? []) as McpClientRecord[]) : []; } catch { clients = []; }
  let snapshotBody: Record<string, unknown> | undefined;
  try { snapshotBody = snapshotResponse.ok ? record(await json(snapshotResponse)) : undefined; } catch { snapshotBody = undefined; }
  const runners = Array.isArray(snapshotBody?.runners) ? snapshotBody.runners as RunnerRecord[] : [];
  const jobs = includeJobs && Array.isArray(snapshotBody?.jobs) ? snapshotBody.jobs.filter(record) as Record<string, unknown>[] : [];
  const snapshotUnavailable = includeJobs && !Array.isArray(snapshotBody?.jobs);
  return { clients, runners, jobs, snapshot: snapshotBody ?? {}, notices: snapshotUnavailable ? [...notices, { title: "Job snapshot unavailable", message: "Job metadata is temporarily unavailable." }] : notices };
}
async function loadFeatureNotices(env: WorkerEnv): Promise<readonly AdminNotice[]> {
  const response = await registryGet(env, "/status/features");
  if (!response.ok) return [FEATURE_STATUS_UNAVAILABLE_NOTICE];
  try { return registryFeatureNotices(record(await json(response))); } catch { return [FEATURE_STATUS_UNAVAILABLE_NOTICE]; }
}
function registryFeatureNotices(value: Record<string, unknown> | undefined): readonly AdminNotice[] {
  const features = arrayField(value?.features).map(record).filter((feature): feature is Record<string, unknown> => feature !== undefined);
  const now = Date.now();
  return features.flatMap((feature) => {
    const key = typeof feature.feature === "string" && keyIsFeature(feature.feature) ? feature.feature : undefined;
    const disabledUntilMs = typeof feature.disabled_until_ms === "number" && Number.isSafeInteger(feature.disabled_until_ms) ? feature.disabled_until_ms : null;
    if (key === undefined || disabledUntilMs === null || disabledUntilMs <= now) return [];
    const label = FEATURE_LABELS[key];
    const lastError = typeof feature.last_error === "string" && feature.last_error.length > 0 ? feature.last_error : undefined;
    return [lastError === undefined ? FEATURE_NOTICE_TEXT[key] : { ...FEATURE_NOTICE_TEXT[key], code: `${label}: ${lastError}` }];
  });
}
function keyIsFeature(value: string): value is RegistryFeatureHealth["feature"] {
  return value === "job_recording" || value === "mcp_audit" || value === "mcp_usage_tracking" || value === "auth_throttle" || value === "maintenance_alarm";
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

function adminPage(pathname: string, data: AdminData, csrf: string): string {
  const active = pathname === "/admin" ? "dashboard" : pathname.slice("/admin/".length) as "runners" | "clients" | "settings";
  const body = active === "runners" ? runnersPage({ configuredModes: new Map(data.runners.map(runner => [runner.runner_id, runnerConfiguredExecutionMode(runner)])), maxValidityDays: MAX_VALIDITY_DAYS }, data, csrf) : active === "clients" ? clientsPage(data, csrf) : active === "settings" ? settingsPage(csrf) : overviewPage(data, csrf);
  return adminDocument(active[0]?.toUpperCase() + active.slice(1), body, active, data.notices);
}

export function runnerEnrollmentPage(env: RunnerReleaseEnvironment, baseUrl: string, runnerId: string, code: string | undefined, csrf: string, reEnroll = false, executionMode: ConsoleExecutionMode = "dedicated_user", confirmPrivilegedHost = false, enrollment?: Pick<Extract<EnrollmentCodeResult, { readonly ok: true }>, "created_at_ms" | "not_before_ms" | "expires_at_ms">): Response {
  if (code === undefined) return adminError(503, "Enrollment code could not be generated.");
  if (executionMode !== "dedicated_user" && executionMode !== "privileged_host") return adminError(400, "Runner execution mode is invalid.");
  if (executionMode === "privileged_host" && !confirmPrivilegedHost) return adminError(400, "Privileged-host enrollment requires the one-time risk acknowledgement.");
  const release = runnerReleaseDescriptor(env);
  const bootstrap = release.distributable;
  // Validate the origin for both the hosted and manual paths.  The manual
  // fallback still emits a server URL into a copyable command; deriving it
  // with `new URL(...).origin` alone would allow a forged Host header to send
  // the operator's one-time code to an attacker-controlled endpoint.
  let publicBase: string;
  try {
    const parsed = new URL(baseUrl);
    if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "" || parsed.username !== "" || parsed.password !== "") throw new Error("enrollment base URL must be an origin");
    const headers = new Headers({ host: parsed.host });
    publicBase = resolveConnectionOrigin(new Request(parsed.toString(), { headers }), configuredPublicOrigin(env));
    if (bootstrap) publicBase = canonicalPublicOrigin(publicBase);
  } catch {
    return installerOriginUnavailable();
  }
  // Keep the original bare URL for privileged installs; the explicit query
  // selects a reviewed restricted template, never an implicit privilege upgrade.
  return html(enrollmentDocument({ publicBase, runnerId, code, csrf, reEnroll, bootstrap, executionMode, maxValidityDays: MAX_VALIDITY_DAYS, enrollment }));
}

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
  const requestedMode = input?.execution_mode;
  if (requestedMode !== undefined && requestedMode !== "dedicated_user" && requestedMode !== "privileged_host") return Response.json({ error: "execution_mode must be dedicated_user or privileged_host" }, { status: 400 });
  if (requestedMode === "privileged_host" && input?.confirm_privileged_host !== true) return Response.json({ error: "privileged_host requires confirmation" }, { status: 400 });
  const token = typeof supplied === "string" ? supplied : generateRunnerToken(); const pepper = env.RUNNER_TOKEN_PEPPER;
  if (!isConfiguredSecret(pepper) || !isConfiguredSecret(env.INTERNAL_CONTROL_SECRET)) return new Response("admin control plane is not configured", { status: 503 });
  const mutationId = `credential-rotated-${crypto.randomUUID()}`;
  let existingResponse: Response;
  try { existingResponse = await runnerRegistryRequest(env, runnerId, "", "GET", ""); } catch { return new Response("registry unavailable", { status: 503 }); }
  if (!existingResponse.ok && existingResponse.status !== 404) return new Response("registry unavailable", { status: 503 });
  if (existingResponse.status === 404 && requestedMode === undefined) return Response.json({ error: "execution_mode is required when creating a Runner" }, { status: 400 });
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
    response = await runnerRegistryRequest(env, runnerId, "", "PUT", JSON.stringify({ token_verifier: await runnerTokenVerifier(token, pepper), mutation_id: mutationId, ...(requestedMode === undefined ? {} : { execution_mode: requestedMode }) }));
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
  try { response = await registryPost(env, "/auth/mcp/verify", { secret_verifier: secretVerifier }); } catch { throw new ControlPlaneUnavailableError(); }
  // Only an authoritative credential rejection means the secret is invalid.
  // Quota errors, a failed DO constructor and malformed upstream replies do
  // not prove revocation and must never turn a working MCP URL into a 404.
  if (response.status === 401 || response.status === 403) return undefined;
  if (response.status === 404) {
    const rejected = record(await json(response));
    if (record(rejected?.error)?.code === "invalid_mcp_credential") return undefined;
  }
  if (!response.ok) throw new ControlPlaneUnavailableError();
  const body = record(await json(response));
  if (body === undefined || typeof body.client_id !== "string" || typeof body.label !== "string" || !Number.isSafeInteger(body.secret_version) || (body.secret_version as number) < 1 || !Array.isArray(body.scopes) || body.scopes.some((scope) => scope !== "coding:read" && scope !== "coding:write" && scope !== "coding:exec")) throw new ControlPlaneUnavailableError();
  return { client_id: body.client_id, label: body.label, secret_version: body.secret_version as number, scopes: body.scopes as CodingScope[] };
}
async function registryGet(env: WorkerEnv, path: string): Promise<Response> { return registryRequest(env, path, "GET", ""); }
async function registryPost(env: WorkerEnv, path: string, payload: Record<string, unknown>): Promise<Response> { return registryRequest(env, path, "POST", JSON.stringify(payload)); }
type PreAuthThrottle = { readonly allowed: boolean; readonly retry_after_ms: number };
async function authSourceHash(env: WorkerEnv, request: Request): Promise<string> {
  // Trust only Cloudflare's edge-populated address, never X-Forwarded-For.
  // Non-edge/local requests share a conservative unattributed source bucket.
  const address = request.headers.get("cf-connecting-ip");
  const source = address !== null && /^[0-9a-f:.]{3,64}$/iu.test(address) ? address.toLowerCase() : "unattributed";
  if (!isConfiguredSecret(env.INTERNAL_CONTROL_SECRET)) throw new Error("internal control is not configured");
  return hmacHex(env.INTERNAL_CONTROL_SECRET, `runmesh-auth-source:v1:${source}`);
}
async function authThrottleCheck(env: WorkerEnv, kind: "login" | "setup", request: Request): Promise<PreAuthThrottle | undefined> {
  const response = await registryPost(env, "/auth/throttle/check", { kind, source_hash: await authSourceHash(env, request) });
  const body = response.ok ? record(await json(response)) : undefined;
  return body !== undefined && typeof body.allowed === "boolean" && typeof body.retry_after_ms === "number" && Number.isSafeInteger(body.retry_after_ms) && body.retry_after_ms >= 0
    ? { allowed: body.allowed, retry_after_ms: body.retry_after_ms }
    : undefined;
}
async function authThrottleRecord(env: WorkerEnv, kind: "login" | "setup", success: boolean, request: Request): Promise<void> {
  // The request includes only outcome metadata; passwords/verifiers never enter logs.
  try { await registryPost(env, "/auth/throttle/record", { kind, source_hash: await authSourceHash(env, request), success }); } catch { /* authentication result remains authoritative */ }
}
function throttleError(retryAfterMs: number): Response {
  const response = html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><link rel="icon" href="/assets/favicon.png" type="image/png"><title>Runmesh · Agent Control Plane</title>${adminStyles()}</head><body class="auth-body">${languageSwitch()}<main class="auth-shell"><section class="auth-card error-card"><div class="secret-brand-row">${meshMarkSvg("error-mesh-mark")}<span class="brand-name">Runmesh</span></div><p class="brand-kicker">Runmesh</p><h1>Runmesh</h1><p class="subtitle">Agent Control Plane</p><p class="lede">Invalid administrator password.</p><p class="muted">Please try again shortly.</p><p><a class="button secondary" href="/">Return</a></p></section></main>${adminScript()}</body></html>`);
  const headers = new Headers(response.headers);
  headers.set("retry-after", String(Math.max(1, Math.ceil(retryAfterMs / 1_000))));
  return new Response(response.body, { status: 403, headers });
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

function adminError(status: number, message: string, cookies: readonly string[] = []): Response { const response = html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><link rel="icon" href="/assets/favicon.png" type="image/png"><title>Runmesh · Agent Control Plane</title>${adminStyles()}</head><body class="auth-body">${languageSwitch()}<main class="auth-shell"><section class="auth-card error-card"><div class="secret-brand-row">${meshMarkSvg("error-mesh-mark")}<span class="brand-name">Runmesh</span></div><p class="brand-kicker">Runmesh</p><h1>Runmesh</h1><p class="subtitle">Agent Control Plane</p><p class="lede">${escapeHtml(message)}</p><p><a class="button secondary" href="/">Return</a></p></section></main>${adminScript()}</body></html>`, cookies.length === 0 ? [] : cookies); return new Response(response.body, { status, headers: response.headers }); }
function methodNotAllowed(allow: string): Response { return new Response("Method not allowed", { status: 405, headers: { allow } }); }
function notFound(): Response { return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } }); }

async function json(response: Response): Promise<unknown> { try { return await response.json(); } catch { return undefined; } }

async function loadLiveJobs(env: WorkerEnv, runnerId: string, workspaceId: string, limit: number): Promise<Response> {
  const readiness = await policyReadiness(env,runnerId);
  if (!readiness.ok) return new Response("policy unavailable",{status:503});
  const response = await runnerRpc(env,runnerId,"job.list",{workspace_id:workspaceId,limit},readiness.value.applied_revision,readiness.value.active_checksum);
  const payload = response?.ok ? record(await json(response)) : undefined;
  const jobs = Array.isArray(payload?.result) ? payload.result : record(payload?.result)?.jobs;
  if (!Array.isArray(jobs) || jobs.some((job) => record(job)?.workspace_id !== workspaceId)) return new Response("live Jobs unavailable",{status:503});
  return Response.json({jobs:jobs.slice(0,limit),source:"runner_live"});
}
