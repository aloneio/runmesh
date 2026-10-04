import type { RegistryRoute } from "./request.js";
import type { ValidityWindow, ValidityStatus } from "../../validity.js";
import { validWindow } from "../../validity.js";
import { isSafeIdentifier } from "../../security.js";
import type { InternalInput, PermissionSet, WorkspaceRecord, RunnerRecord, EnrollmentRow, RunnerUpdateChannel, PolicyAcknowledgementResult } from "../records.js";
import { parseManagedWorkspace, parseRunnerVersionPolicy } from "../route-inputs.js";
import { registryInputError } from "../route-projections.js";
import { stringField, permissionSetField, requestedExpectedLifecycleId, mutationIdField, parsePathIdentifier } from "../values.js";

export interface RunnerPolicyRoutePorts {
  hasRunner(runnerId: string): boolean;
  listManagedWorkspaces(runnerId: string): WorkspaceRecord[];
  latestRunnerEnrollment(runnerId: string): Omit<EnrollmentRow, "verifier"> | undefined;
  runnerAccess(runnerId: string, nowMs?: number): { allowed: boolean; status: ValidityStatus | "missing" };
  setRunnerValidity(runnerId: string, validity: ValidityWindow, lifecycleId: string, nowMs?: number): boolean;
  createManagedWorkspace(runnerId: string, input: { workspace_id: string; display_name: string; root_path: string; enabled: boolean; permissions: PermissionSet }, nowMs: number, mutationId?: string): WorkspaceRecord | undefined;
  getManagedWorkspace(runnerId: string, workspaceId: string): WorkspaceRecord | undefined;
  updateManagedWorkspace(runnerId: string, workspaceId: string, input: { display_name: string; root_path: string; enabled: boolean; permissions: PermissionSet }, nowMs: number, mutationId?: string): WorkspaceRecord | undefined;
  deleteManagedWorkspace(runnerId: string, workspaceId: string, nowMs: number, mutationId?: string): boolean;
  setRunnerVersionPolicy(runnerId: string, input: { update_channel: RunnerUpdateChannel; desired_runner_version?: string; latest_runner_version?: string }, nowMs: number): RunnerRecord | undefined;
  setRunnerPermissions(runnerId: string, permissions: PermissionSet, nowMs: number, mutationId?: string): RunnerRecord | undefined;
  emergencyLockRunner(runnerId: string, confirmation: string, nowMs: number, mutationId?: string): RunnerRecord | undefined;
  policyAcknowledgementFromInput(runnerId: string, input: InternalInput, nowMs: number): PolicyAcknowledgementResult | undefined;
}

/** Parsing and responses only; authority and transactions stay with RegistryDO. */
export function createRunnerPolicyRoutes(ports: RunnerPolicyRoutePorts): RegistryRoute {
  return ({ method, segments, input, nowMs }) => {
    const action = segments[0]; const runnerId = parsePathIdentifier(segments[1]);
    if (action !== "runners" || runnerId === undefined) return undefined;
    const workspaceId = parsePathIdentifier(segments[3]);
    if (method === "GET" && action === "runners" && runnerId !== undefined && segments[2] === "managed-workspaces" && segments[3] === undefined) {
      if (!isSafeIdentifier(runnerId)) return new Response("not found", { status: 404 });
      return !ports.hasRunner(runnerId)
        ? new Response("not found", { status: 404 })
        : Response.json({ runner_id: runnerId, workspaces: ports.listManagedWorkspaces(runnerId) });
    }
    if (method === "GET" && action === "runners" && runnerId !== undefined && segments[2] === "enrollments" && segments[3] === undefined) {
      return !isSafeIdentifier(runnerId) || !ports.hasRunner(runnerId) ? new Response("not found", { status: 404 }) : Response.json({ enrollment: ports.latestRunnerEnrollment(runnerId) ?? null });
    }
    if (method === "GET" && action === "runners" && runnerId !== undefined && segments[2] === "access" && segments[3] === undefined) {
      return !isSafeIdentifier(runnerId) ? new Response("not found", { status: 404 }) : Response.json(ports.runnerAccess(runnerId));
    }
    if (method === "POST" && action === "runners" && runnerId !== undefined && segments[2] === "validity" && segments[3] === undefined) {
      if (!isSafeIdentifier(runnerId)) return new Response("not found", { status: 404 });
      const validity = { valid_from_ms: input.valid_from_ms, valid_until_ms: input.valid_until_ms } as ValidityWindow;
      const lifecycleId = requestedExpectedLifecycleId(input);
      if (!validWindow(validity) || typeof lifecycleId !== "string") return new Response("invalid validity window", { status: 400 });
      return ports.setRunnerValidity(runnerId, validity, lifecycleId, nowMs) ? new Response(null, { status: 204 }) : new Response("runner state changed", { status: 409 });
    }
    if (method === "POST" && action === "runners" && runnerId !== undefined && segments[2] === "managed-workspaces" && segments[3] === undefined) {
      if (!isSafeIdentifier(runnerId)) return new Response("not found", { status: 404 });
      const parsed = parseManagedWorkspace(input);
      if (!parsed.ok) return registryInputError(parsed);
      const { workspaceId, displayName, rootPath, permissions, mutationId, enabled } = parsed.value;
      const workspace = ports.createManagedWorkspace(runnerId, { workspace_id: workspaceId, display_name: displayName, root_path: rootPath, enabled, permissions }, nowMs, mutationId);
      return workspace === undefined ? new Response("conflict", { status: 409 }) : Response.json(workspace);
    }
    if (action === "runners" && runnerId !== undefined && segments[2] === "managed-workspaces" && workspaceId !== undefined && isSafeIdentifier(runnerId)) {
      if (method === "GET") { const workspace = ports.getManagedWorkspace(runnerId, workspaceId); return workspace === undefined ? new Response("not found", { status: 404 }) : Response.json(workspace); }
      if (method === "PUT") {
        const displayName = stringField(input, "display_name", 256); const rootPath = stringField(input, "root_path", 4_096); const permissions = permissionSetField(input.permissions); const mutationId = mutationIdField(input);
        if (displayName === undefined || rootPath === undefined || permissions === undefined || mutationId === undefined || typeof input.enabled !== "boolean") return Response.json({ error: "invalid workspace mutation" }, { status: 400 });
        const workspace = ports.updateManagedWorkspace(runnerId, workspaceId, { display_name: displayName, root_path: rootPath, enabled: input.enabled, permissions }, nowMs, mutationId);
        return workspace === undefined ? new Response("not found", { status: 404 }) : Response.json(workspace);
      }
      if (method === "DELETE") {
        const confirmation = stringField(input, "confirmation", 128); const mutationId = mutationIdField(input);
        return confirmation === workspaceId && mutationId !== undefined && ports.deleteManagedWorkspace(runnerId, workspaceId, nowMs, mutationId) ? new Response(null, { status: 204 }) : new Response("not found", { status: 404 });
      }
    }
    if (method === "POST" && action === "runners" && runnerId !== undefined && segments[2] === "version-policy" && isSafeIdentifier(runnerId)) {
      const parsed = parseRunnerVersionPolicy(input);
      if (!parsed.ok) return registryInputError(parsed);
      const { channel, desired, latest } = parsed.value;
      const runner = ports.setRunnerVersionPolicy(runnerId, { update_channel: channel, ...(typeof desired === "string" ? { desired_runner_version: desired } : {}), ...(typeof latest === "string" ? { latest_runner_version: latest } : {}) }, nowMs);
      return runner === undefined ? new Response("not found", { status: 404 }) : Response.json(runner);
    }
    if (method === "POST" && action === "runners" && runnerId !== undefined && segments[2] === "permissions" && isSafeIdentifier(runnerId)) {
      const permissions = permissionSetField(input.permissions);
      const mutationId = mutationIdField(input);
      if (mutationId === undefined) return Response.json({ error: "mutation_id is required" }, { status: 400 });
      if (permissions === undefined) return Response.json({ error: "invalid runner permissions" }, { status: 400 });
      const runner = ports.setRunnerPermissions(runnerId, permissions, nowMs, mutationId);
      return runner === undefined ? new Response("not found", { status: 404 }) : Response.json(runner);
    }
    if (method === "POST" && action === "runners" && runnerId !== undefined && segments[2] === "emergency-lock" && isSafeIdentifier(runnerId)) {
      const confirmation = stringField(input, "confirmation", 128); const mutationId = mutationIdField(input);
      const runner = confirmation === runnerId && mutationId !== undefined ? ports.emergencyLockRunner(runnerId, confirmation, nowMs, mutationId) : undefined;
      return runner === undefined ? new Response("not found", { status: 404 }) : Response.json(runner);
    }
    if (method === "POST" && action === "runners" && runnerId !== undefined && segments[2] === "policy-ack" && isSafeIdentifier(runnerId)) {
      const ack = ports.policyAcknowledgementFromInput(runnerId, input, nowMs);
      if (ack === undefined) return Response.json({ error: "invalid policy acknowledgement" }, { status: 409 });
      return Response.json({ ack_result: ack });
    }
    return undefined;
  };
}
