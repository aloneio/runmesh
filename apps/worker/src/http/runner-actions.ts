import { deleteRunnerFromControlPlane } from "./runner-deletion.js";
import { adminError } from "./responses.js";
import { beginRunnerPolicyMutation } from "../application/runner-policy.js";
import { cancelRunnerPolicyMutation } from "../application/runner-policy.js";
import { configuredWorkspacePreset } from "./input.js";
import { createEnrollmentCode } from "../application/enrollment.js";
import type { EnrollmentCodeResult } from "../contracts/runner-admin.js";
import { enrollmentWindowFromForm } from "./input.js";
import { executionModeForExistingRunner } from "./input.js";
import { executionModeFromForm } from "./input.js";
import { expectedConfiguredMode } from "../domain/execution-mode.js";
import { fenceRunnerTransport } from "../application/runner-lifecycle.js";
import { formEnrollmentTtl } from "./input.js";
import { isAbsolutePath } from "./input.js";
import { isFullHostPath } from "../admin/host-path-label.js";
import { isSafeIdentifier } from "../security.js";
import { json } from "../platform/control-plane.js";
import { mutateRunnerPolicy } from "../application/runner-policy.js";
import { permissionsFromForm } from "./input.js";
import { record } from "../values.js";
import { redirect } from "./html-response.js";
import { registryPost } from "../platform/control-plane.js";
import { releaseUncommittedRunnerFence } from "../application/runner-lifecycle.js";
import { revokeRunnerTransport } from "../application/runner-lifecycle.js";
import { runnerEnrollmentPage } from "./admin-presentation.js";
import { runnerExecutionSnapshot } from "../application/runner-queries.js";
import { runnerMutationState } from "../application/runner-lifecycle.js";
import { runnerRegistryRequest } from "../platform/control-plane.js";
import { runnerReleaseDescriptor } from "../distribution/release.js";
import { runnerWindowFromForm } from "./input.js";
import { settleRunnerMutation } from "../application/runner-lifecycle.js";
import { validLabel } from "./input.js";
import { validRunnerVersion } from "./input.js";
import type { WorkerEnv } from "../platform/env.js";

/**
 * Render mode fields for an authenticated action. Unconfigured rows render an
 * unselected mode so the administrator must make an explicit choice; configured rows carry the server-owned choice through the
 * form. The enrollment result uses the non-interactive variant only to bind
 * the form to the mode observed when that one-time code was rendered; the
 * destination mode is never replayed from a hidden field.
 */
export async function createBrowserRunner(env: WorkerEnv, form: FormData, baseUrl: string): Promise<Response> {
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

export async function handleBrowserRunnerAction(env: WorkerEnv, form: FormData, baseUrl: string, runnerId: string, action: "rename" | "rotate" | "revoke" | "delete" | "enrollment" | "validity" | "permissions" | "version-policy" | "emergency-lock" | "workspace-create" | "workspace-update" | "workspace-delete"): Promise<Response> {
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
    const result = await deleteRunnerFromControlPlane(env, runnerId, form.get("confirmation"));
    if (result.state === "deleted") return redirect("/admin");
    if (result.state === "rejected") return result.reason === "confirmation"
      ? adminError(400, "Type the Runner ID to confirm deletion.")
      : adminError(result.status === 404 ? 404 : 400, "Runner delete failed.");
    if (result.state === "unavailable") return adminError(503, "Runner deletion could not fence the Runner.");
    if (result.reason === "cancel") return adminError(503, "Runner deletion failed; Runner remains safely fenced.");
    if (result.reason === "recovery") return adminError(503, "Runner deletion state is uncertain; Runner remains safely fenced.");
    return adminError(503, "Runner deletion outcome is uncertain; Runner remains safely fenced.");
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
