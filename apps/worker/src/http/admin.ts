import { developmentReleaseDependencies } from "./release-cache.js";
import type { DevelopmentReleaseRefreshScheduler } from "../distribution/release.js";
import { runnerSummary, runnerDetail as projectRunnerDetail, clientDetail as projectClientDetail } from "../application/admin-projections.js";
import { ADMIN_CSRF_COOKIE } from "./constants.js";
import { ADMIN_SESSION_COOKIE } from "./constants.js";
import { adminDocument } from "../admin/layout.js";
import { adminError } from "./responses.js";
import { adminPage } from "./admin-presentation.js";
import { adminSession } from "./session.js";
import { arrayField } from "../values.js";
import { changePassword } from "./auth.js";
import { clearCookie } from "./session.js";
import { clientDetailPage } from "../admin/client-views.js";
import { configuredPublicOrigin } from "./origin.js";
import { constantTimeEqual } from "../security.js";
import { controlPlaneUnavailableResponse } from "../control-plane-errors.js";
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
import { json } from "../platform/control-plane.js";
import { loadAdminJobPage } from "../admin-jobs.js";
import { loadDashboardData } from "./admin-query.js";
import { loadFeatureNotices } from "./admin-query.js";
import { loadLiveJobs } from "../application/runner-queries.js";
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
import type { RunnerSummaryViewModel } from "../contracts/admin-views.js";
import { resolveRunnerReleaseDescriptor } from "../distribution/release.js";
import { registryDevelopmentReleaseCache } from "./release-cache.js";
import { runnerReportedExecutionMode } from "../domain/execution-mode.js";
import { runnerRpc } from "../platform/control-plane.js";
import { secretCreatedPage } from "../admin/auth-views.js";
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
    let runners: RunnerSummaryViewModel[] = [];
    let overrides: Record<string, unknown>[] = [];
    try { runners = runnersResponse.ok ? arrayField(record(await json(runnersResponse))?.runners).filter(record) as RunnerSummaryViewModel[] : []; } catch { runners = []; }
    try { overrides = overridesResponse.ok ? arrayField(record(await json(overridesResponse))?.overrides).flatMap((item) => { const value = record(item); return value === undefined ? [] : [value]; }) : []; } catch { overrides = []; }
    return client === undefined ? adminError(404, "MCP client was not found.") : html(adminDocument(`${typeof client.label === "string" ? client.label : clientDetail[1]} · MCP Client`, await clientDetailPage(projectClientDetail(client), runners.map(runnerSummary), overrides as Record<string, unknown>[], csrf), "clients", notices));
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
      resolveRunnerReleaseDescriptor(env, developmentReleaseDependencies(registryDevelopmentReleaseCache(env)), scheduleRefresh),
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
    return runner === undefined ? adminError(404, "Runner was not found.") : html(adminDocument(`${typeof runner.display_name === "string" ? runner.display_name : runnerId} · Runner`, runnerDetailPage({ configuredMode: runnerConfiguredExecutionMode(runner), reportedMode: runnerReportedExecutionMode(runner), maxValidityDays: MAX_VALIDITY_DAYS, dayMs: DAY_MS }, projectRunnerDetail(runner), workspaces, jobs, environment, csrf, releaseResponse, policyVersions, enrollment, mcpCalls, view, settings), "runners", notices));
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
  if (url.pathname === "/admin/runners") return createBrowserRunner(env, form, publicOrigin, scheduleRefresh);
  const runnerMatch = /^\/admin\/runners\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/(rename|rotate|revoke|delete|enrollment|validity|permissions|version-policy|emergency-lock|workspace-create|workspace-update|workspace-delete)$/.exec(url.pathname);
  if (runnerMatch !== null) return handleBrowserRunnerAction(env, form, publicOrigin, runnerMatch[1] as string, runnerMatch[2] as "rename" | "rotate" | "revoke" | "delete" | "enrollment" | "validity" | "permissions" | "version-policy" | "emergency-lock" | "workspace-create" | "workspace-update" | "workspace-delete", scheduleRefresh);
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

function secretUrl(base: string, secret: string): string { const url = new URL(base); url.pathname = `/${secret}/mcp`; url.search = ""; return url.toString(); }
