import type { ActiveSelectionCall } from "./contracts.js";
import { asToolResult } from "./results/envelope.js";
import { checkAnyReadPermission } from "./authorization.js";
import { fail } from "./results/envelope.js";
import { failWithDetails } from "./results/envelope.js";
import { isRecord } from "./results/primitives.js";
import { isSafeNonnegativeInteger } from "./results/primitives.js";
import type { McpClientActiveRunner } from "../contracts/runner-selection.js";
import type { McpRequestEnv } from "./contracts.js";
import { registryCall } from "./transport.js";
import { registryPostCall } from "./transport.js";
import { runnerFailure } from "./results/envelope.js";
import { runnerSuccess } from "./results/envelope.js";
import { safeJobIdentifier } from "./results/primitives.js";
import { safeWorkspaceMetadata } from "./results/selection.js";
import type { SelectionCall } from "./contracts.js";
import { success } from "./results/envelope.js";

/** Validate the complete sticky identity before using it to choose a host.
 * A malformed snapshot must not look like an empty selection or a fallback. */
function selectionSnapshot(value: unknown): McpClientActiveRunner | undefined {
  if (!isRecord(value)) return undefined;
  const runnerId = value.active_runner_id === null ? null : safeJobIdentifier(value.active_runner_id);
  const updated = value.active_runner_updated_at_ms;
  if (runnerId === undefined || (updated !== null && !isSafeNonnegativeInteger(updated))) return undefined;
  if (value.runner === null) return { active_runner_id: runnerId, active_runner_updated_at_ms: updated, runner: null };
  const context = value.runner;
  if (runnerId === null || !isRecord(context) || context.runner_id !== runnerId || typeof context.available !== "boolean"
    || (context.updated_at_ms !== null && !isSafeNonnegativeInteger(context.updated_at_ms))) return undefined;
  const state = context.state;
  if (state !== "online" && state !== "offline" && state !== "stale" && state !== "unavailable") return undefined;
  if (context.available !== (state === "online")) return undefined;
  return { active_runner_id: runnerId, active_runner_updated_at_ms: updated,
    runner: { runner_id: runnerId, state, available: context.available, updated_at_ms: context.updated_at_ms } };
}

function invalidSelectionReceipt(operationState: "not_started" | "unknown"): ReturnType<typeof fail> {
  return fail("registry_unavailable", "The Registry returned an invalid or mismatched Runner selection.", "Inspect runner_current after the control plane recovers; do not select or retry a command automatically.", operationState);
}

export async function getActiveRunnerSelection(env: McpRequestEnv, clientId: string): Promise<SelectionCall> {
  const call = await registryCall(env, `/auth/clients/${encodeURIComponent(clientId)}/active-runner`);
  if (!call.ok) return call;
  const selection = selectionSnapshot(call.value);
  return selection === undefined ? invalidSelectionReceipt("not_started") : { ok: true, value: selection };
}

export async function selectActiveRunner(env: McpRequestEnv, clientId: string, runnerId: string, confirmSwitch: boolean): Promise<SelectionCall> {
  const call = await registryPostCall(env, `/auth/clients/${encodeURIComponent(clientId)}/active-runner`, { runner_id: runnerId, confirm_switch: confirmSwitch });
  if (call.ok) {
    const result = call.value;
    if (!isRecord(result) || typeof result.ok !== "boolean") return invalidSelectionReceipt("unknown");
    const selection = selectionSnapshot(result.selection);
    if (result.ok) {
      if (selection === undefined || selection.active_runner_id !== runnerId || typeof result.changed !== "boolean") return invalidSelectionReceipt("unknown");
      return { ok: true, value: { ok: true, selection, changed: result.changed } };
    }
    if (result.code !== "client_not_found" && result.code !== "runner_not_found" && result.code !== "runner_unavailable" && result.code !== "runner_switch_confirmation_required") return invalidSelectionReceipt("unknown");
    if (result.selection !== undefined && selection === undefined) return invalidSelectionReceipt("unknown");
    if (result.code === "runner_switch_confirmation_required") {
      if (selection === undefined) return invalidSelectionReceipt("unknown");
      return failWithDetails(result.code, "Switching the active runner requires confirmation.", "Retry with confirm_switch=true to switch runners.", selection);
    }
    return fail(result.code, "The runner selection could not be changed.", "Call runner_list and choose an available runner.");
  }
  return call;
}

export async function resolveActiveRunner(env: McpRequestEnv, clientId: string, allowOfflineSnapshot = false): Promise<ActiveSelectionCall> {
  const initial = await getActiveRunnerSelection(env, clientId);
  if (!initial.ok) return initial;
  let state = initial.value as McpClientActiveRunner;
  let automatic = false;
  if (state.active_runner_id === null) {
    const runners = await registryCall(env, "/runners");
    if (!runners.ok) return runners;
    const list = isRecord(runners.value) && Array.isArray(runners.value.runners) ? runners.value.runners : [];
    if (list.length === 0) {
      return fail("no_runners_available", "No registered runners are available.", "Register a runner, then call runner_list and runner_select.");
    }
    if (list.length !== 1 || !isRecord(list[0]) || typeof list[0].runner_id !== "string") {
      return fail("runner_not_selected", "No active runner is selected.", "Call runner_list, then runner_select with the desired runner_id.");
    }
    const selected = await selectActiveRunner(env, clientId, list[0].runner_id, false);
    if (!selected.ok) return selected;
    state = (selected.value as { selection: McpClientActiveRunner }).selection;
    automatic = true;
  }
  const context = state.runner;
  if (context === null || context.state === "unavailable") {
    return failWithDetails("runner_unavailable", "The selected runner is unavailable.", "Call runner_current to inspect the selection; select another runner explicitly if needed.", { runner_context: { ...(context ?? { runner_id: state.active_runner_id, state: "unavailable", available: false, updated_at_ms: state.active_runner_updated_at_ms }), automatic_selection: automatic } });
  }
  if (context.state !== "online" && !allowOfflineSnapshot) {
    return failWithDetails("runner_offline", "The selected runner is not connected.", "Confirm the selected runner is connected, then retry.", { runner_context: { ...context, automatic_selection: automatic } }, "not_started");
  }
  return { ok: true, value: { runnerId: context.runner_id, context: { ...context, automatic_selection: automatic } } };
}

export async function activeWorkspaceList(env: McpRequestEnv, clientId: string): Promise<unknown> {
  const selected = await resolveActiveRunner(env, clientId, true);
  if (!selected.ok) return asToolResult(selected);
  // The Registry projects the policy and effective intersection in one event
  // turn: the workspace's permission ceiling is not the caller's permission.
  const call = await registryCall(env, `/auth/clients/${encodeURIComponent(clientId)}/effective-workspaces/${encodeURIComponent(selected.value.runnerId)}`);
  if (!call.ok) return runnerFailure(call.error, selected.value);
  if (!isRecord(call.value) || !Array.isArray(call.value.workspaces) || call.value.workspaces.some(workspace => safeWorkspaceMetadata(workspace) === undefined)) {
    return runnerFailure(fail("registry_unavailable", "The Registry workspace response is invalid.", "Retry after the control plane returns a valid workspace catalog.", "not_started").error, selected.value);
  }
  const value = call.value;
  const workspaces = call.value.workspaces;
  const projected: Record<string, unknown> = { workspaces: workspaces.flatMap((workspace) => { const safe = safeWorkspaceMetadata(workspace); return safe === undefined ? [] : [safe]; }) };
  const runnerId = safeJobIdentifier(value.runner_id);
  if (runnerId !== undefined) projected.runner_id = runnerId;
  if (isSafeNonnegativeInteger(value.revision)) projected.revision = value.revision;
  if (typeof value.checksum === "string" && /^[a-f0-9]{64}$/u.test(value.checksum)) projected.checksum = value.checksum;
  if (selected.value.context.state !== "online") { projected.source = "registry_snapshot"; projected.runner_state = "offline"; }
  return runnerSuccess(projected, selected.value);
}

export async function gatedRunnerList(env: McpRequestEnv, clientId: string): Promise<unknown> {
  const call = await registryCall(env, "/runners");
  if (!call.ok) return asToolResult(call);
  const runners = isRecord(call.value) && Array.isArray(call.value.runners) ? call.value.runners : [];
  const visible: unknown[] = [];
  for (const runner of runners) {
    if (!isRecord(runner) || typeof runner.runner_id !== "string") continue;
    const permission = await checkAnyReadPermission(env, clientId, runner.runner_id);
    if (permission?.error.code === "registry_unavailable" || permission?.error.code === "service_unavailable") return asToolResult(permission);
    if (permission === undefined) visible.push(runner);
  }
  return runnerListToolValue(visible);
}

function runnerListToolValue(value: readonly unknown[]): unknown {
  const runners = value.filter(isRecord).map((runner) => {
    const runnerId = safeJobIdentifier(runner.runner_id) ?? "unknown";
    const displayName = typeof runner.display_name === "string" && runner.display_name.length > 0 && runner.display_name.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(runner.display_name) ? runner.display_name : runnerId;
    const state = runner.state === "online" || runner.state === "offline" || runner.state === "stale" ? runner.state : "unavailable";
    return { runner_id: runnerId, display_name: displayName, state, available: state === "online", updated_at_ms: isSafeNonnegativeInteger(runner.updated_at_ms) ? runner.updated_at_ms : null };
  });
  return success({ runners });
}
