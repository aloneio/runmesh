import type { RegistryRoute } from "./request.js";
import type { ClientIdentity } from "../../contracts/identity.js";
import type { McpClientActiveRunner, McpRunnerSelectionResult } from "../../contracts/runner-selection.js";
import { isSafeIdentifier } from "../../security.js";
import type { CodingScope, McpClientRecord, VerifiedMcpClient, PermissionSet } from "../records.js";
import { parseMcpIdentity, parseNativeMcpClient } from "../route-inputs.js";
import { registryInputError } from "../route-projections.js";
import { stringField, scopesField, permissionSetField, parsePathIdentifier } from "../values.js";

export interface ClientsRoutePorts {
  listMcpClients(): McpClientRecord[];
  createMcpIdentity(input: { client_id: string; label: string; secret_verifier: string; secret_prefix: string; native_scopes: readonly CodingScope[] }, nowMs: number): ClientIdentity | undefined;
  createMcpClient(input: { client_id: string; label: string; secret_verifier: string; secret_prefix: string; scopes: readonly CodingScope[] }, nowMs: number): McpClientRecord | undefined;
  setJobRecording(clientId: string, enabled: boolean, nowMs: number): McpClientRecord | undefined;
  renameMcpClient(clientId: string, label: string, nowMs: number): McpClientRecord | undefined;
  rotateMcpClient(clientId: string, secretVerifier: string, secretPrefix: string, nowMs: number): McpClientRecord | undefined;
  revokeMcpClient(clientId: string, nowMs: number): McpClientRecord | undefined;
  updateMcpClientScopes(clientId: string, scopes: readonly CodingScope[], nowMs: number): McpClientRecord | undefined;
  hasMcpClient(clientId: string): boolean;
  listClientRunnerOverrides(clientId: string): Array<{ runner_id: string; permissions: PermissionSet }>;
  deleteClientRunnerOverride(clientId: string, runnerId: string): boolean;
  setClientRunnerOverride(clientId: string, runnerId: string, permissions: PermissionSet, nowMs: number): boolean;
  effectivePermissions(clientId: string, runnerId: string, workspaceId: string): PermissionSet | undefined;
  getMcpClientActiveRunner(clientId: string): McpClientActiveRunner | undefined;
  resetMcpClientRunner(clientId: string, nowMs: number): McpClientActiveRunner | undefined;
  revalidateMcpClient(clientId: unknown, secretVersion: unknown, includeJobRecording?: boolean): VerifiedMcpClient | undefined;
  selectMcpClientRunner(clientId: string, runnerId: string, confirmSwitch: boolean, nowMs: number): McpRunnerSelectionResult;
  autoSelectOnlyRunner(clientId: string, nowMs: number): McpRunnerSelectionResult | undefined;
  effectiveWorkspaceList(clientId: string, runnerId: string): { runner_id: string; revision: number; checksum: string; workspaces: Array<{ workspace_id: string; enabled: boolean; permissions: PermissionSet }> } | undefined;
}

/** Parsing and responses only; authority and transactions stay with RegistryDO. */
export function createClientsRoutes(ports: ClientsRoutePorts): RegistryRoute {
  return ({ method, segments, input, nowMs, url }) => {
    const action = segments[0]; const clientId = parsePathIdentifier(segments[1]);
    if (action !== "clients" || (segments[1] !== undefined && clientId === undefined)) return undefined;
    const targetRunnerId = parsePathIdentifier(segments[3]);
    if (method === "GET" && action === "clients" && clientId === undefined) return Response.json({ clients: ports.listMcpClients() });
    if (method === "POST" && action === "clients" && clientId === undefined && input.identity_version !== undefined) {
      const parsed = parseMcpIdentity(input);
      if (!parsed.ok) return registryInputError(parsed);
      const { id, label, verifier, prefix, scopes } = parsed.value;
      const identity = ports.createMcpIdentity({ client_id: id, label, secret_verifier: verifier, secret_prefix: prefix, native_scopes: scopes }, nowMs);
      return identity === undefined ? new Response("conflict", { status: 409 }) : Response.json(identity);
    }
    if (method === "POST" && action === "clients" && clientId === undefined) {
      const parsed = parseNativeMcpClient(input);
      if (!parsed.ok) return registryInputError(parsed);
      const { id, label, verifier, prefix, scopes } = parsed.value;
      const client = ports.createMcpClient({ client_id: id, label, secret_verifier: verifier, secret_prefix: prefix, scopes }, nowMs);
      return client === undefined ? new Response("conflict", { status: 409 }) : Response.json(client);
    }
    if (action === "clients" && clientId !== undefined && isSafeIdentifier(clientId)) {
      const subaction = segments[2];
      if (method === "POST" && subaction === "recording") {
        if (typeof input.record_jobs !== "boolean") return Response.json({ error: "record_jobs must be boolean" }, { status: 400 });
        const client = ports.setJobRecording(clientId, input.record_jobs, nowMs);
        return client === undefined ? new Response("not found", { status: 404 }) : Response.json(client);
      }
      if (method === "POST" && subaction === "rename") { const label = stringField(input, "label", 256); const client = label === undefined ? undefined : ports.renameMcpClient(clientId, label, nowMs); return client === undefined ? new Response("not found", { status: 404 }) : Response.json(client); }
      if (method === "POST" && subaction === "rotate") { const verifier = stringField(input, "secret_verifier", 64); const prefix = stringField(input, "secret_prefix", 16); const client = verifier === undefined || prefix === undefined ? undefined : ports.rotateMcpClient(clientId, verifier, prefix, nowMs); return client === undefined ? new Response("not found", { status: 404 }) : Response.json(client); }
      if (method === "POST" && subaction === "revoke") { const client = ports.revokeMcpClient(clientId, nowMs); return client === undefined ? new Response("not found", { status: 404 }) : Response.json(client); }
      if (method === "POST" && subaction === "scopes") { const scopes = scopesField(input.scopes); const client = scopes === undefined ? undefined : ports.updateMcpClientScopes(clientId, scopes, nowMs); return client === undefined ? new Response("invalid client scopes", { status: ports.hasMcpClient(clientId) ? 400 : 404 }) : Response.json(client); }
    }
    if (method === "GET" && action === "clients" && clientId !== undefined && segments[2] === "runner-overrides" && segments[3] === undefined) {
      return !ports.hasMcpClient(clientId) ? new Response("not found", { status: 404 }) : Response.json({ client_id: clientId, overrides: ports.listClientRunnerOverrides(clientId) });
    }
    if (method === "DELETE" && action === "clients" && clientId !== undefined && segments[2] === "runner-overrides" && targetRunnerId !== undefined) {
      return ports.deleteClientRunnerOverride(clientId, targetRunnerId) ? new Response(null, { status: 204 }) : new Response("not found", { status: 404 });
    }
    if (method === "POST" && action === "clients" && clientId !== undefined && segments[2] === "runner-overrides" && targetRunnerId !== undefined) {
      const permissions = permissionSetField(input.permissions);
      return permissions !== undefined && ports.setClientRunnerOverride(clientId, targetRunnerId, permissions, nowMs) ? new Response(null, { status: 204 }) : new Response("not found", { status: 404 });
    }
    if (method === "GET" && action === "clients" && clientId !== undefined && segments[2] === "effective-permissions" && targetRunnerId !== undefined) {
      const workspaceId = url.searchParams.get("workspace_id");
      const permissions = workspaceId === null ? undefined : ports.effectivePermissions(clientId, targetRunnerId, workspaceId);
      return permissions === undefined ? new Response("not found", { status: 404 }) : Response.json({ permissions });
    }
    if (method === "GET" && action === "clients" && clientId !== undefined && segments[2] === "active-runner") {
      const selection = ports.getMcpClientActiveRunner(clientId);
      return selection === undefined ? new Response("not found", { status: 404 }) : Response.json(selection);
    }
    if (method === "POST" && action === "clients" && clientId !== undefined && segments[2] === "active-runner" && segments[3] === "reset") {
      const selection = ports.resetMcpClientRunner(clientId, nowMs);
      return selection === undefined ? new Response("not found", { status: 404 }) : Response.json(selection);
    }
    if (method === "POST" && action === "clients" && clientId !== undefined && segments[2] === "active-runner") {
      // Browser mutations were checked against their signed session above.
      // MCP selection must instead commit under the original credential's
      // generation, with no await between this check and the synchronous write.
      if (!url.searchParams.has("admin_session")) {
        const value = input.mcp_authorization;
        const principal = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
        const client = principal === undefined ? undefined : ports.revalidateMcpClient(principal.client_id, principal.secret_version);
        if (client === undefined || client.client_id !== clientId) return Response.json({ ok: false, code: "permission_denied" }, { status: 403 });
        if (!client.scopes.includes("coding:read")) return Response.json({ ok: false, code: "insufficient_scope" }, { status: 403 });
      }
      const runnerId = stringField(input, "runner_id", 128);
      const confirmSwitch = input.confirm_switch === true;
      if (runnerId === undefined) return Response.json({ error: "invalid runner" }, { status: 400 });
      const result = ports.selectMcpClientRunner(clientId, runnerId, confirmSwitch, nowMs);
      return result.ok ? Response.json(result) : (result.code === "runner_switch_confirmation_required" || result.code === "runner_unavailable") ? Response.json(result, { status: 409 }) : new Response("not found", { status: 404 });
    }
    if (method === "POST" && action === "clients" && clientId !== undefined && segments[2] === "auto-select-runner") {
      const result = ports.autoSelectOnlyRunner(clientId, nowMs);
      return result === undefined ? Response.json({ code: "runner_not_selected" }, { status: 409 }) : result.ok ? Response.json(result) : new Response("not found", { status: 404 });
    }
    if (method === "GET" && action === "clients" && clientId !== undefined && segments[2] === "effective-workspaces" && targetRunnerId !== undefined) {
      const value = ports.effectiveWorkspaceList(clientId, targetRunnerId);
      return value === undefined ? new Response("not found", { status: 404 }) : Response.json(value);
    }
    return undefined;
  };
}
