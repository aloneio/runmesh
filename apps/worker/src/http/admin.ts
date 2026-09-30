import { matchIdentifierPath } from "./path-identifiers.js";
import { developmentReleaseDependencies } from "./release-cache.js";
import type { DevelopmentReleaseRefreshScheduler } from "../distribution/release.js";
import { ADMIN_CSRF_COOKIE } from "./constants.js";
import { ADMIN_SESSION_COOKIE } from "./constants.js";
import { adminDocument } from "../admin/layout.js";
import { centralPage } from "../admin/central-view.js";
import { adminError } from "./responses.js";
import { adminClientError, adminRunnerError, adminSectionError, adminUpstreamError } from "./responses.js";
import { boundedJsonResponse } from "../bounded-json.js";
import { adminPage } from "./admin-presentation.js";
import { adminSession } from "./session.js";
import { changePassword } from "./auth.js";
import { clearCookie } from "./session.js";
import { clientDetailPage } from "../admin/client-views.js";
import { configuredPublicOrigin } from "./origin.js";
import { constantTimeEqual } from "../security.js";
import { cookieValue } from "./session.js";
import { createBrowserRunner } from "./runner-actions.js";
import { DAY_MS } from "../domain/execution-mode.js";
import { discardBody } from "./request.js";
import { formData } from "./request.js";
import { handleBrowserRunnerAction } from "./runner-actions.js";
import { historyView } from "../history-ui.js";
import { html } from "./html-response.js";
import { installerOriginUnavailable } from "./distribution.js";
import { isSafeIdentifier } from "../security.js";
import { loadAdminJobPage } from "../admin-jobs.js";
import { loadClientDetailData, loadAdminPageData } from "./admin-query.js";
import { loadFeatureNotices } from "./admin-query.js";
import { loadRunnerDetailData } from "./runner-detail-query.js";
import { MAX_VALIDITY_DAYS } from "../domain/execution-mode.js";
import { methodNotAllowed } from "./responses.js";
import { notFound } from "./responses.js";
import { parseJobHistorySettings } from "../job-history-settings.js";
import { permissionsFromForm } from "./input.js";
import { policyReadiness } from "../application/runner-queries.js";
import { randomBase64Url } from "../security.js";
import { record } from "../values.js";
import { redirect } from "./html-response.js";
import { registryGet } from "../platform/control-plane.js";
import { registryPost } from "../platform/control-plane.js";
import { registryRequest } from "../platform/control-plane.js";
import { resolveConnectionOrigin } from "./origin.js";
import { runnerConfiguredExecutionMode } from "../domain/execution-mode.js";
import { runnerDetailPage } from "../admin/runner-detail-view.js";
import { runnerEnvironment } from "../application/runner-queries.js";
import { resolveRunnerReleaseDescriptor } from "../distribution/release.js";
import { runnerReportedExecutionMode } from "../domain/execution-mode.js";
import { runnerRpc } from "../platform/control-plane.js";
import { secretCreatedPage } from "../admin/auth-views.js";
import { settingsPage } from "../admin/dashboard-views.js";
import { selectedScopes } from "./input.js";
import { sha256Hex } from "../security.js";
import { validLabel } from "./input.js";
import { verifyAdminPost } from "./session.js";
import type { WorkerEnv } from "../platform/env.js";

export async function handleBrowserAdmin(request: Request, env: WorkerEnv, url: URL, scheduleRefresh?: DevelopmentReleaseRefreshScheduler): Promise<Response> {
  const admission = await adminSession(request, env);
  if (admission.state === "unavailable") { await discardBody(request); return adminError(503, "Authentication service unavailable. Try again."); }
  if (admission.state !== "allowed") { if (request.method !== "GET") await discardBody(request); return redirect("/", [clearCookie(ADMIN_SESSION_COOKIE), clearCookie(ADMIN_CSRF_COOKIE)]); }
  const session = admission.session;
  // Copy, never mutate a shared deployment environment. Every later Registry
  // mutation carries this session inside its authenticated request target.
  env = { ...env, adminSessionHash: session.hash };
  if (request.method === "GET" && url.pathname === "/admin/central") {
    const csrf = cookieValue(request, ADMIN_CSRF_COOKIE);
    if (csrf === undefined || !constantTimeEqual(await sha256Hex(csrf), session.csrf_hash)) return redirect("/", [clearCookie(ADMIN_SESSION_COOKIE), clearCookie(ADMIN_CSRF_COOKIE)]);
    return html(adminDocument("MCP & Skill", centralPage(csrf, env.CAPABILITIES !== undefined, env.CENTRAL_SKILLS_ENABLED === "1"), "central"));
  }
  if (request.method === "GET" && ["/admin", "/admin/runners", "/admin/clients", "/admin/settings"].includes(url.pathname)) {
    const csrf = cookieValue(request, ADMIN_CSRF_COOKIE);
    if (csrf === undefined || !constantTimeEqual(await sha256Hex(csrf), session.csrf_hash)) return redirect("/", [clearCookie(ADMIN_SESSION_COOKIE), clearCookie(ADMIN_CSRF_COOKIE)]);
    if (url.pathname === "/admin/settings") return html(adminDocument("Settings", settingsPage(csrf), "settings", await loadFeatureNotices(env)));
    const section = url.pathname === "/admin" ? "dashboard" : url.pathname === "/admin/runners" ? "runners" : "clients";
    const data = await loadAdminPageData(env, section);
    if (data === undefined) return adminSectionError(503, "Console data could not be loaded. Try again.", section);
    return html(adminPage(url.pathname, data, csrf, env.CAPABILITIES !== undefined));
  }
  const runnerDetail = matchIdentifierPath(/^\/admin\/runners\/([^/]+)$/, url.pathname);
  const jobDetail = matchIdentifierPath(/^\/admin\/runners\/([^/]+)\/jobs\/([^/]+)$/, url.pathname, [1, 2]);
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
    return page.ok ? html(adminDocument(page.title, page.body, "runners")) : adminRunnerError(page.status, page.message);
  }
  const clientDetail = matchIdentifierPath(/^\/admin\/clients\/([^/]+)(?:\/scopes\/detail)?$/, url.pathname);
  if (request.method === "GET" && clientDetail !== null) {
    const csrf = cookieValue(request, ADMIN_CSRF_COOKIE);
    if (csrf === undefined || !constantTimeEqual(await sha256Hex(csrf), session.csrf_hash)) return redirect("/", [clearCookie(ADMIN_SESSION_COOKIE), clearCookie(ADMIN_CSRF_COOKIE)]);
    const data = await loadClientDetailData(env, clientDetail[1] as string);
    if (data.state === "unavailable") return adminClientError(503, "Client details could not be loaded. Try again.");
    if (data.state === "missing") return adminClientError(404, "MCP client was not found.");
    const { client, runners, overrides, notices } = data;
    return html(adminDocument(`${typeof client.label === "string" ? client.label : clientDetail[1]} · MCP Client`, clientDetailPage(client, runners, overrides, csrf), "clients", notices));
  }

  if (request.method === "GET" && runnerDetail !== null) {
    const csrf = cookieValue(request, ADMIN_CSRF_COOKIE);
    if (csrf === undefined || !constantTimeEqual(await sha256Hex(csrf), session.csrf_hash)) return redirect("/", [clearCookie(ADMIN_SESSION_COOKIE), clearCookie(ADMIN_CSRF_COOKIE)]);
    const runnerId = runnerDetail[1] as string;
    const view = historyView(url);
    if (view === undefined) return adminRunnerError(400,"Invalid history query.");
    const [data, environment, releaseResponse, notices] = await Promise.all([
      loadRunnerDetailData(env, runnerId, view),
      runnerEnvironment(env, runnerId),
      resolveRunnerReleaseDescriptor(env, developmentReleaseDependencies(env), scheduleRefresh),
      loadFeatureNotices(env),
    ]);
    if (data.state === "missing") return adminRunnerError(404, "Runner was not found.");
    if (data.state === "unavailable") return adminRunnerError(503, "Runner details could not be loaded. Try again.");
    const { runner, workspaces, jobs, mcpCalls, policyVersions, enrollment, settings } = data;
    return html(adminDocument(`${typeof runner.display_name === "string" ? runner.display_name : runnerId} · Runner`, runnerDetailPage({ configuredMode: runnerConfiguredExecutionMode(runner), reportedMode: runnerReportedExecutionMode(runner), maxValidityDays: MAX_VALIDITY_DAYS, dayMs: DAY_MS }, runner, workspaces, jobs, environment, csrf, releaseResponse, policyVersions, enrollment, mcpCalls, view, settings), "runners", notices));
  }
  if (request.method !== "POST") { await discardBody(request); return methodNotAllowed("GET, POST"); }
  const form = await formData(request);
  if (form === undefined || !await verifyAdminPost(request, form, session, env)) return adminError(403, "Administrative request was rejected.");
  const finalAdmission = await adminSession(request, env);
  if (finalAdmission.state === "unavailable") return adminError(503, "Authentication service unavailable. Try again.");
  if (finalAdmission.state !== "allowed" || finalAdmission.session.hash !== session.hash) return adminError(403, "Administrative request was rejected.");
  // Generated enrollment/MCP URLs must use the deployment's canonical public
  // origin when configured. Local development intentionally has no config and
  // may use HTTP; copied manual commands still quote this derived origin.
  let publicOrigin: string;
  try {
    publicOrigin = resolveConnectionOrigin(request, configuredPublicOrigin(env));
  } catch { return installerOriginUnavailable(); }
  if (url.pathname === "/admin/logout") {
    const response = await registryPost(env, "/auth/sessions/logout", { session_hash: session.hash });
    if (response.status !== 204) {
      void response.body?.cancel().catch(() => undefined);
      return adminError(503, "Authentication service unavailable. Try again.");
    }
    return redirect("/", [clearCookie(ADMIN_SESSION_COOKIE), clearCookie(ADMIN_CSRF_COOKIE)]);
  }
  const historyAction = matchIdentifierPath(/^\/admin\/runners\/([^/]+)\/history-settings$/, url.pathname);
  if (historyAction !== null) {
    const settings = parseJobHistorySettings({mode:form.get("mode"),interval_seconds:Number(form.get("interval_seconds")),retention_days:Number(form.get("retention_days")),local_retention_days:Number(form.get("local_retention_days"))});
    if (settings === undefined || (settings.local_retention_days > 0 && form.get("confirm_local_cleanup") !== "true")) return adminRunnerError(400,"Invalid settings or local cleanup not confirmed.");
    const response = await registryPost(env,`/runners/${encodeURIComponent(historyAction[1]!)}/history-settings`,{...settings});
    return response.ok ? redirect(`/admin/runners/${encodeURIComponent(historyAction[1]!)}`) : adminRunnerError(response.status === 404 ? 404 : 503,"History settings could not be saved.");
  }
  if (url.pathname === "/admin/password") return changePassword(env, form);
  if (url.pathname === "/admin/clients") return createClient(env, form, publicOrigin);
  if (url.pathname === "/admin/runners") return createBrowserRunner(env, form, publicOrigin, scheduleRefresh);
  const runnerMatch = matchIdentifierPath(/^\/admin\/runners\/([^/]+)\/(rename|rotate|revoke|delete|enrollment|validity|permissions|version-policy|emergency-lock|workspace-create|workspace-update|workspace-delete)$/, url.pathname);
  if (runnerMatch !== null) return handleBrowserRunnerAction(env, form, publicOrigin, runnerMatch[1] as string, runnerMatch[2] as "rename" | "rotate" | "revoke" | "delete" | "enrollment" | "validity" | "permissions" | "version-policy" | "emergency-lock" | "workspace-create" | "workspace-update" | "workspace-delete", scheduleRefresh);
  const clientMatch = matchIdentifierPath(/^\/admin\/clients\/([^/]+)\/(rename|rotate|revoke|delete|reset-runner|select-runner|active-runner|override|reset-override|scopes|recording)$/, url.pathname);
  if (clientMatch === null) return notFound();
  const clientId = clientMatch[1] as string; const action = clientMatch[2] as "rename" | "rotate" | "revoke" | "delete" | "reset-runner" | "select-runner" | "active-runner" | "override" | "reset-override" | "scopes" | "recording";
  if (action === "recording") {
    const value = form.get("record_jobs");
    if (value !== "true" && value !== "false") return adminClientError(400, "Recording preference is invalid.");
    const response = await registryPost(env, `/auth/clients/${encodeURIComponent(clientId)}/recording`, { record_jobs: value === "true" });
    return adminMutationResponse(response, `/admin/clients/${encodeURIComponent(clientId)}`, "Recording preference could not be updated.");
  }
  if (action === "scopes") {
    const scopes = selectedScopes(form);
    if (scopes === undefined) return adminClientError(400, "Client scopes are invalid.");
    const response = await registryPost(env, `/auth/clients/${encodeURIComponent(clientId)}/scopes`, { scopes });
    return adminMutationResponse(response, `/admin/clients/${encodeURIComponent(clientId)}`, "Client scopes could not be updated.");
  }
  if (action === "reset-runner") {
    const response = await registryPost(env, `/auth/clients/${encodeURIComponent(clientId)}/active-runner/reset`, {});
    return adminMutationResponse(response, "/admin/clients", "Runner selection could not be reset.");
  }
  if (action === "select-runner" || action === "active-runner") {
    const runnerId = form.get("runner_id");
    if (typeof runnerId !== "string" || !isSafeIdentifier(runnerId)) return adminClientError(400, "Runner identifier is invalid.");
    const confirmValue = form.get("confirm_switch");
    const confirmSwitch = confirmValue === "true" || confirmValue === "on" || confirmValue === "1";
    const response = await registryPost(env, `/auth/clients/${encodeURIComponent(clientId)}/active-runner`, { runner_id: runnerId, confirm_switch: confirmSwitch });
    if (response.status === 200) { void response.body?.cancel().catch(() => undefined); return redirect(`/admin/clients/${encodeURIComponent(clientId)}`); }
    if (response.status === 409) {
      let code: unknown;
      try { code = record(await response.json())?.code; } catch { code = undefined; }
      return adminClientError(409, code === "runner_unavailable" ? "The selected Runner is unavailable or has not completed enrollment." : "A different Runner is already selected. Check Confirm switch and try again.");
    }
    return adminUpstreamError(response, "Runner selection could not be updated.", 400, adminClientError);
  }
  if (action === "override" || action === "reset-override") {
    const runnerId = form.get("runner_id");
    if (typeof runnerId !== "string" || !isSafeIdentifier(runnerId)) return adminClientError(400, "Runner identifier is invalid.");
    const path = `/auth/clients/${encodeURIComponent(clientId)}/runner-overrides/${encodeURIComponent(runnerId)}`;
    if (action === "reset-override") {
      const response = await registryRequest(env, path, "DELETE", "");
      return adminMutationResponse(response, `/admin/clients/${encodeURIComponent(clientId)}`, "Runner restriction could not be reset.", 204);
    }
    const permissions = permissionsFromForm(form);
    if (permissions === undefined) return adminClientError(400, "Runner restriction is invalid.");
    const response = await registryPost(env, path, { permissions });
    return adminMutationResponse(response, `/admin/clients/${encodeURIComponent(clientId)}`, "Runner restriction could not be saved.", 204);
  }
  if (action === "rename") {
    const label = form.get("label");
    if (typeof label !== "string" || !validLabel(label)) return adminClientError(400, "Client name is invalid.");
    const response = await registryPost(env, `/auth/clients/${encodeURIComponent(clientId)}/rename`, { label });
    return adminMutationResponse(response, "/admin", "Client update failed.");
  }
  if (action === "delete") {
    const response = await registryRequest(env, "/auth/clients/" + encodeURIComponent(clientId), "DELETE", "");
    return adminMutationResponse(response, "/admin/clients", "Client deletion failed.", 204);
  }
  if (action === "revoke") {
    const response = await registryPost(env, `/auth/clients/${encodeURIComponent(clientId)}/revoke`, {});
    return adminMutationResponse(response, "/admin/clients", "Client revoke failed.");
  }
  const secret = randomBase64Url();
  const failure = await persistClientCredential(env, `/auth/clients/${encodeURIComponent(clientId)}/rotate`, clientId, secret);
  if (failure !== undefined) return failure;
  return html(secretCreatedPage("MCP client rotated", secretUrl(publicOrigin, secret), env.CAPABILITIES !== undefined ? clientId : undefined));
}

async function createClient(env: WorkerEnv, form: FormData, baseUrl: string): Promise<Response> {
  const label = form.get("label");
  const mode = form.get("access_mode");
  const centralOnly = mode === "central";
  const scopes = centralOnly ? [] : selectedScopes(form);
  if ((mode !== null && mode !== "central" && mode !== "native") || (centralOnly && env.CAPABILITIES === undefined)
    || typeof label !== "string" || !validLabel(label) || scopes === undefined) return adminClientError(400, "Client name or scopes are invalid.");
  const secret = randomBase64Url();
  const clientId = `client-${crypto.randomUUID().replaceAll("-", "")}`;
  const failure = await persistClientCredential(env, "/auth/clients", clientId, secret, centralOnly
    ? { identity_version: 2, client_id: clientId, label, native_scopes: [] }
    : { client_id: clientId, label, scopes });
  if (failure !== undefined) return failure;
  return html(secretCreatedPage("MCP client created", secretUrl(baseUrl, secret), env.CAPABILITIES !== undefined ? clientId : undefined));
}

function secretUrl(base: string, secret: string): string { const url = new URL(base); url.pathname = `/${secret}/mcp`; url.search = ""; return url.toString(); }

function adminMutationResponse(response: Response, location: string, message: string, completedStatus = 200): Response {
  if (response.status !== completedStatus) return adminUpstreamError(response, message, 400, adminClientError);
  void response.body?.cancel().catch(() => undefined);
  return redirect(location);
}

async function persistClientCredential(env: WorkerEnv, path: string, clientId: string, secret: string, fields: Record<string, unknown> = {}): Promise<Response | undefined> {
  const prefix = secret.slice(0, 8);
  const payload = JSON.stringify({ ...fields, secret_verifier: await sha256Hex(secret), secret_prefix: prefix });
  const response = await boundedJsonResponse(signal => registryRequest(env, path, "POST", payload, signal));
  const receipt = record(response?.value);
  // Display a credential only after its synchronous write returned a matching
  // committed record. An accepted, truncated or unrelated receipt is uncertain.
  if (response?.status === 200 && receipt?.client_id === clientId && receipt.secret_prefix === prefix
    && Number.isSafeInteger(receipt.secret_version) && (receipt.secret_version as number) >= 1 && receipt.revoked_at_ms === null) return undefined;
  if (fields.identity_version === 2 && response?.status === 200 && receipt?.schema_version === 2
    && receipt.client_id === clientId && receipt.secret_version === 1
    && Array.isArray(receipt.native_scopes) && receipt.native_scopes.length === 0) {
    // Identity receipts omit credential metadata. Confirm the committed record
    // separately; never retry creation after an uncertain write.
    const readback = await boundedJsonResponse(signal => registryRequest(env, "/auth/clients", "GET", "", signal));
    const clients = record(readback?.value)?.clients;
    const client = Array.isArray(clients) ? clients.map(record).find(item => item?.client_id === clientId) : undefined;
    if (readback?.status === 200 && client?.secret_prefix === prefix && client.secret_version === 1
      && client.revoked_at_ms === null && Array.isArray(client.scopes) && client.scopes.length === 0) return undefined;
  }
  return adminClientError(response?.status === 404 ? 404 : response?.status === 409 ? 409 : 503, "MCP credential could not be confirmed. Refresh the client state before trying again.");
}
