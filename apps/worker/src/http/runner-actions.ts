import { createRunnerFromControlPlane, rotateRunnerFromControlPlane, revokeRunnerFromControlPlane, browserRunnerAdministrationError, regenerateEnrollmentFromControlPlane } from "./runner-administration.js";
import type { DevelopmentReleaseRefreshScheduler } from "../distribution/release.js";
import { deleteRunnerFromControlPlane } from "./runner-deletion.js";
import { adminRunnerError } from "./responses.js";
import { adminUpstreamError } from "./responses.js";
import { configuredWorkspacePreset } from "./input.js";
import { enrollmentWindowFromForm } from "./input.js";
import { executionModeForExistingRunner } from "./input.js";
import { executionModeFromForm } from "./input.js";
import { formEnrollmentTtl } from "./input.js";
import { isAbsolutePath } from "./input.js";
import { isFullHostPath } from "../admin/host-path-label.js";
import { isSafeIdentifier } from "../security.js";
import { mutateRunnerPolicy } from "./runner-policy.js";
import { permissionsFromForm } from "./input.js";
import { redirect } from "./html-response.js";
import { registryPost } from "../platform/control-plane.js";
import { runnerEnrollmentPage } from "./admin-presentation.js";
import { runnerExecutionSnapshot } from "../application/runner-queries.js";
import { runnerRegistryRequest } from "../platform/control-plane.js";
import { runnerReleaseDescriptor, resolveRunnerReleaseDescriptor } from "../distribution/release.js";
import { runnerWindowFromForm } from "./input.js";
import { validLabel } from "./input.js";
import { validRunnerVersion } from "./input.js";
import type { WorkerEnv } from "../platform/env.js";
import { developmentReleaseDependencies } from "./release-cache.js";

/**
 * Render mode fields for an authenticated action. Unconfigured rows render an
 * unselected mode so the administrator must make an explicit choice; configured rows carry the server-owned choice through the
 * form. The enrollment result uses the non-interactive variant only to bind
 * the form to the mode observed when that one-time code was rendered; the
 * destination mode is never replayed from a hidden field.
 */
export async function createBrowserRunner(env: WorkerEnv, form: FormData, baseUrl: string, scheduleRefresh?: DevelopmentReleaseRefreshScheduler): Promise<Response> {
  const submittedId = form.get("runner_id"); const displayName = form.get("display_name");
  const selection = executionModeFromForm(form);
  if (selection === undefined) return adminRunnerError(400, "Runner execution mode or privileged-host confirmation is invalid.");
  const runnerValidity = runnerWindowFromForm(form);
  const enrollmentWindow = enrollmentWindowFromForm(form); const enrollmentTtlMs = formEnrollmentTtl(form);
  if (runnerValidity === undefined || enrollmentWindow === undefined || enrollmentTtlMs === undefined) return adminRunnerError(400, "Runner or enrollment validity settings are invalid.");
  const runnerId = typeof submittedId === "string" && submittedId.trim().length > 0 ? submittedId : `runner-${crypto.randomUUID().replaceAll("-", "")}`;
  if (!isSafeIdentifier(runnerId) || typeof displayName !== "string" || !validLabel(displayName)) return adminRunnerError(400, "Runner identifier or display name is invalid.");
  const result = await createRunnerFromControlPlane(env, runnerId, { displayName, selection, validity: runnerValidity, ttlMs: enrollmentTtlMs, window: enrollmentWindow });
  if (result.state === "failed") return browserRunnerAdministrationError("create", result);
  return runnerEnrollmentPage(env, await resolveRunnerReleaseDescriptor(env, developmentReleaseDependencies(env), scheduleRefresh), baseUrl, runnerId, result.enrollment.code, String(form.get("csrf_token") ?? ""), false, selection.mode, selection.confirmed, result.enrollment);
}

export async function handleBrowserRunnerAction(env: WorkerEnv, form: FormData, baseUrl: string, runnerId: string, action: "rename" | "rotate" | "revoke" | "delete" | "enrollment" | "validity" | "permissions" | "version-policy" | "emergency-lock" | "workspace-create" | "workspace-update" | "workspace-delete", scheduleRefresh?: DevelopmentReleaseRefreshScheduler): Promise<Response> {
  const enrollmentWindow = action === "rotate" || action === "enrollment" ? enrollmentWindowFromForm(form) : undefined;
  const enrollmentTtlMs = action === "rotate" || action === "enrollment" ? formEnrollmentTtl(form) : undefined;
  if ((action === "rotate" || action === "enrollment") && (enrollmentWindow === undefined || enrollmentTtlMs === undefined)) return adminRunnerError(400, "Enrollment validity settings are invalid.");
  if (action === "validity") {
    const window = runnerWindowFromForm(form);
    if (window === undefined) return adminRunnerError(400, "Runner authorization validity settings are invalid.");
    const state = await runnerExecutionSnapshot(env, runnerId);
    if (state.snapshot === undefined) return adminRunnerError(state.status === 404 ? 404 : 503, "Runner authorization could not read the Runner state.");
    const response = await registryPost(env, `/auth/runners/${encodeURIComponent(runnerId)}/validity`, { valid_from_ms: window.valid_from_ms, valid_until_ms: window.valid_until_ms, expected_lifecycle_id: state.snapshot.lifecycleId });
    return response.ok ? redirect(`/admin/runners/${encodeURIComponent(runnerId)}`) : adminUpstreamError(response, "Runner authorization validity could not be updated.", response.status === 409 ? 409 : 400, adminRunnerError);
  }
  if (action === "version-policy") {
    const updateChannel = form.get("update_channel"); const desired = form.get("desired_runner_version");
    if ((updateChannel !== "stable" && updateChannel !== "pinned") || (typeof desired !== "string" && desired !== null)) return adminRunnerError(400, "Runner update policy is invalid.");
    const latest = runnerReleaseDescriptor(env).distributable ? runnerReleaseDescriptor(env).package_version : null;
    const payload = { update_channel: updateChannel, ...(updateChannel === "pinned" && typeof desired === "string" && desired.length > 0 ? { desired_runner_version: desired } : {}), ...(updateChannel === "stable" && latest !== null ? { latest_runner_version: latest } : {}) };
    if (updateChannel === "pinned" && !(typeof desired === "string" && validRunnerVersion(desired))) return adminRunnerError(400, "Pinned Runner version must be an exact version.");
    const response = await registryPost(env, `/auth/runners/${encodeURIComponent(runnerId)}/version-policy`, payload);
    return response.ok ? redirect(`/admin/runners/${encodeURIComponent(runnerId)}`) : adminUpstreamError(response, "Runner update policy could not be updated.", 400, adminRunnerError);
  }
  if (action === "permissions") {
    const permissions = permissionsFromForm(form);
    if (permissions === undefined) return adminRunnerError(400, "Runner permissions are invalid.");
    const response = await mutateRunnerPolicy(env, runnerId, { path: `/auth/runners/${encodeURIComponent(runnerId)}/permissions`, method: "POST", payload: { permissions } });
    return response.ok ? redirect(`/admin/runners/${encodeURIComponent(runnerId)}`) : adminUpstreamError(response, "Runner permission profile could not be updated.", 400, adminRunnerError);
  }
  if (action === "emergency-lock") {
    if (form.get("confirmation") !== runnerId) return adminRunnerError(400, "Type the Runner ID to confirm emergency lock.");
    const response = await mutateRunnerPolicy(env, runnerId, { path: `/auth/runners/${encodeURIComponent(runnerId)}/emergency-lock`, method: "POST", payload: { confirmation: runnerId } });
    return response.ok ? redirect(`/admin/runners/${encodeURIComponent(runnerId)}`) : adminUpstreamError(response, "Emergency lock could not be applied.", 400, adminRunnerError);
  }
  if (action.startsWith("workspace-")) return handleBrowserWorkspaceAction(env, form, runnerId, action as "workspace-create" | "workspace-update" | "workspace-delete");
  if (action === "rename") {
    const displayName = form.get("display_name");
    if (typeof displayName !== "string" || !validLabel(displayName)) return adminRunnerError(400, "Runner display name is invalid.");
    const response = await runnerRegistryRequest(env, runnerId, "/rename", "POST", JSON.stringify({ display_name: displayName }));
    return response.ok ? redirect("/admin") : adminUpstreamError(response, "Runner rename failed.", 400, adminRunnerError);
  }
  if (action === "delete") {
    const result = await deleteRunnerFromControlPlane(env, runnerId, form.get("confirmation"));
    if (result.state === "deleted") return redirect("/admin");
    if (result.state === "rejected") return result.reason === "confirmation"
      ? adminRunnerError(400, "Type the Runner ID to confirm deletion.")
      : adminRunnerError(result.status === 404 ? 404 : 400, "Runner delete failed.");
    if (result.state === "unavailable") return adminRunnerError(503, "Could not start deleting the Runner. Try again.");
    if (result.reason === "cancel") return adminRunnerError(503, "Runner deletion failed; Runner remains locked.");
    if (result.reason === "recovery") return adminRunnerError(503, "Runner deletion state is uncertain; Runner remains locked.");
    return adminRunnerError(503, "Runner deletion outcome is uncertain; Runner remains locked.");
  }
  if (action === "revoke") {
    if (form.get("confirmation") !== runnerId) return adminRunnerError(400, "Type the Runner ID to confirm revocation.");
    const result = await revokeRunnerFromControlPlane(env, runnerId);
    return result.state === "completed" ? redirect("/admin") : browserRunnerAdministrationError("revoke", result);
  }
  if (action === "rotate") {
    const initialState = await runnerExecutionSnapshot(env, runnerId);
    if (initialState.snapshot === undefined) return adminRunnerError(initialState.status === 404 ? 404 : 503, initialState.status === 404 ? "Runner was not found." : "Runner credential rotation could not read the Runner state.");
    const selection = executionModeForExistingRunner(form, initialState.snapshot.runner);
    if (selection === undefined) return adminRunnerError(400, "Runner execution mode must be selected explicitly; privileged-host mode also requires confirmation.");
    const result = await rotateRunnerFromControlPlane(env, runnerId, initialState.snapshot, { selection, ttlMs: enrollmentTtlMs, window: enrollmentWindow });
    if (result.state === "failed") return browserRunnerAdministrationError("rotate", result);
    return runnerEnrollmentPage(env, await resolveRunnerReleaseDescriptor(env, developmentReleaseDependencies(env), scheduleRefresh), baseUrl, runnerId, result.enrollment.code, String(form.get("csrf_token") ?? ""), true, selection.mode, selection.confirmed, result.enrollment);
  }
  if (action === "enrollment") {
    const initialState = await runnerExecutionSnapshot(env, runnerId);
    if (initialState.snapshot === undefined) return adminRunnerError(initialState.status === 404 ? 404 : 503, initialState.status === 404 ? "Runner was not found." : "Runner enrollment could not read the Runner state.");
    const selection = executionModeForExistingRunner(form, initialState.snapshot.runner);
    if (selection === undefined) return adminRunnerError(400, "Runner execution mode must be selected explicitly; privileged-host mode also requires confirmation.");
    const result = await regenerateEnrollmentFromControlPlane(env, runnerId, initialState.snapshot, { selection, ttlMs: enrollmentTtlMs, window: enrollmentWindow });
    if (result.state === "failed") {
      if (result.reason === "cleanup") return enrollmentCleanupUnavailable(result.diagnostic);
      if (result.reason === "changed" || result.reason === "enrollment_rejected") return adminRunnerError(result.cause === "missing" ? 404 : 409, result.cause === "missing" ? "Runner was not found." : "Runner state changed; reload the Runner page and retry.");
      const message = result.reason === "fence" ? "Could not start Runner registration. Try again." : result.reason === "recovery" ? "Runner enrollment state is uncertain; Runner remains locked." : result.reason === "enrollment_recovery" ? "Enrollment code state is uncertain; Runner remains locked." : "Enrollment code creation is uncertain; Runner remains locked.";
      return adminRunnerError(503, message);
    }
    return runnerEnrollmentPage(env, await resolveRunnerReleaseDescriptor(env, developmentReleaseDependencies(env), scheduleRefresh), baseUrl, runnerId, result.enrollment.code, String(form.get("csrf_token") ?? ""), true, selection.mode, selection.confirmed, result.enrollment);
  }
  return adminRunnerError(404, "Runner enrollment action is not available.");
}

/** Report the failed phase without exposing provider messages, enrollment codes or tokens. */
function enrollmentCleanupUnavailable(diagnostic?: string): Response {
  const code = diagnostic ?? "cleanup_unavailable";
  const response = adminRunnerError(503, `Runner setup could not finish. Generate a new enrollment code to try again. Diagnostic: ${code}.`);
  response.headers.set("x-runmesh-error-code", code);
  response.headers.set("x-runmesh-error-phase", "enrollment_fence_release");
  return response;
}

async function handleBrowserWorkspaceAction(env: WorkerEnv, form: FormData, runnerId: string, action: "workspace-create" | "workspace-update" | "workspace-delete"): Promise<Response> {
  const returnToDetail = `/admin/runners/${encodeURIComponent(runnerId)}`;
  const workspaceId = form.get("workspace_id");
  if (typeof workspaceId !== "string" || !isSafeIdentifier(workspaceId)) return adminRunnerError(400, "Workspace identifier is invalid.");
  if (action === "workspace-delete") {
    if (form.get("confirmation") !== workspaceId) return adminRunnerError(400, "Type the Workspace ID to confirm deletion.");
    const response = await mutateRunnerPolicy(env, runnerId, { path: `/auth/runners/${encodeURIComponent(runnerId)}/managed-workspaces/${encodeURIComponent(workspaceId)}`, method: "DELETE", payload: { confirmation: workspaceId } });
    if (!response.ok) return adminUpstreamError(response, "Workspace could not be deleted.", 400, adminRunnerError);
    return redirect(returnToDetail);
  }
  const displayName = form.get("display_name"); const rootPath = form.get("root_path");
  if (typeof displayName !== "string" || !validLabel(displayName) || typeof rootPath !== "string" || !isAbsolutePath(rootPath)) return adminRunnerError(400, "Workspace name or absolute root path is invalid.");
  if (isFullHostPath(rootPath) && !form.getAll("confirm_full_host").includes("true")) return adminRunnerError(400, "Full Host Workspace requires explicit confirmation.");
  const configured = configuredWorkspacePreset(form.get("profile"));
  const permissions = configured ?? permissionsFromForm(form);
  if (permissions === undefined) return adminRunnerError(400, "Workspace permission profile is invalid.");
  const enabled = form.get("enabled") === "true";
  const payload = { workspace_id: workspaceId, display_name: displayName, root_path: rootPath, enabled, permissions };
  const response = await mutateRunnerPolicy(env, runnerId, { path: action === "workspace-create" ? `/auth/runners/${encodeURIComponent(runnerId)}/managed-workspaces` : `/auth/runners/${encodeURIComponent(runnerId)}/managed-workspaces/${encodeURIComponent(workspaceId)}`, method: action === "workspace-create" ? "POST" : "PUT", payload });
  if (!response.ok) return adminUpstreamError(response, "Workspace could not be saved.", 400, adminRunnerError);
  return redirect(returnToDetail);
}
