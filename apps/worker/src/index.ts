import { BRAND_LOGO_ASSET } from "./admin/brand.js";
import { ControlPlaneUnavailableError } from "./control-plane-errors.js";
import { controlPlaneUnavailableResponse } from "./control-plane-errors.js";
import { deploymentProvenance } from "./deployment-provenance.js";
import { discardBody } from "./http/request.js";
import { ExternalAuditHistory } from "./external-audit.js";
import { forwardRunnerRpc } from "./http/runner-api.js";
import { handleBrowserAdmin } from "./http/admin.js";
import { handleCentralAdmin } from "./http/central.js";
import { handleLanding } from "./http/auth.js";
import { handleMcpSecret } from "./http/mcp.js";
import { handleRunnerAdmin } from "./http/runner-api.js";
import { handleRunnerEnrollment } from "./http/enrollment.js";
import { isConfiguredSecret } from "./security.js";
import { isMcpPath } from "./http/mcp.js";
import { isRunnerAdminRequest } from "./http/session.js";
import { isSafeIdentifier } from "./security.js";
import { localizeHtmlResponse } from "./ui-locale.js";
import { MCP_CATALOG_SUMMARY } from "./mcp/catalog-contract.js";
import { methodNotAllowed } from "./http/responses.js";
import { notFound } from "./http/responses.js";
import { PackedJobHistory } from "./job-history-store.js";
import { PRODUCT_VERSION } from "./generated-version.js";
import { ProtectedRpcMethodSchema } from "@aloneio/runmesh-protocol";
import { RegistryDO } from "./registry.js";
import { RegistryDOv2 } from "./registry.js";
import { releaseGateDiagnostics } from "./distribution/release.js";
import { requiresInternalControl } from "./http/mcp.js";
import { resolveRuntimeConfiguration } from "./runtime-config.js";
import { rpcPermissionRequirement } from "./mcp-authorization.js";
import { RunnerDO } from "./runner-do.js";
import { runnerInstallPowerShell } from "./http/distribution.js";
import { runnerInstallScript } from "./http/distribution.js";
import { runnerRelease } from "./http/distribution.js";
import { runnerUninstallScript } from "./http/distribution.js";
import type { WorkerEnv } from "./platform/env.js";

// must never be opened or migrated in place.
export { RegistryDO, RegistryDOv2, RunnerDO };
export { CapabilitiesDOv1 } from "./capabilities-do.js";

export class RunnerDOv2 extends RunnerDO {}

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
  const scheduleReleaseRefresh = (work: Promise<void>): void => _ctx.waitUntil(work);
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
      deployment: deploymentProvenance(env),
      release_gate: releaseGateDiagnostics(env),
      job_history: { backend: env.RUNMESH_JOB_HISTORY_BACKEND === "d1" ? "packed_d1" : "sqlite", protocol: 1, default_interval_seconds: 300, max_snapshot_jobs: 500 },
      audit_history: { backend: env.RUNMESH_AUDIT_BACKEND === "d1" ? "d1" : "durable_object", binding_configured: env.RUNMESH_AUDIT_BACKEND !== "d1" || env.HISTORY_DB !== undefined },
    }, { headers: { "cache-control": "no-store" } });
  }
  if (url.pathname === "/assets/logo.png" || url.pathname === BRAND_LOGO_ASSET || url.pathname === "/assets/favicon.png") return asset(request, env);
  if (url.pathname === "/runner/uninstall.sh" || url.pathname === "/runner/uninstall.ps1") return runnerUninstallScript(request, env, url.pathname.endsWith(".ps1"), scheduleReleaseRefresh);
  if (url.pathname === "/runner/install.sh") return runnerInstallScript(request, url, env, scheduleReleaseRefresh);
  if (url.pathname === "/runner/install.ps1") return runnerInstallPowerShell(request, url, env, scheduleReleaseRefresh);
  if (url.pathname === "/runner/releases/latest") return runnerRelease(request, env, "selected", scheduleReleaseRefresh);
  if (url.pathname === "/runner/releases/stable") return runnerRelease(request, env, "stable", scheduleReleaseRefresh);
  if (url.pathname === "/runner/releases/dev") return runnerRelease(request, env, "dev", scheduleReleaseRefresh);
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
    return isRunnerAdminRequest(request, env) ? handleRunnerAdmin(request, env, url) : handleBrowserAdmin(request, env, url, scheduleReleaseRefresh);
  }
  if (url.pathname === "/" || url.pathname === "/setup" || url.pathname === "/login") return handleLanding(request, env, url);
  if (url.pathname.startsWith("/admin/central/")) return handleCentralAdmin(request, env, url);
  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return handleBrowserAdmin(request, env, url, scheduleReleaseRefresh);
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

export type { RunnerReleaseDescriptor } from "./distribution/release.js";
export type { ReleaseGateDiagnostics } from "./distribution/release.js";
export type { RunnerReleaseEnvironment } from "./distribution/release.js";
export { releaseGateDiagnostics } from "./distribution/release.js";
export { runnerReleaseDescriptor } from "./distribution/release.js";
export { runnerConfiguredExecutionMode } from "./domain/execution-mode.js";
export { runnerEnrollmentPage } from "./http/admin-presentation.js";
export { pushRunnerPolicy } from "./application/runner-policy.js";
