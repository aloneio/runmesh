import { IdentifierSchema, RunnerMetadataSchema, RunnerSyncSchema } from "@aloneio/runmesh-protocol";
import type { InternalInput } from "./records.js";

export interface RunnerRouteRequest {
  method: string;
  runnerId: string;
  action: string | undefined;
  itemId: string | undefined;
  input: InternalInput;
  nowMs: number;
  url: URL;
}
import { MAX_SYNC_ITEMS } from "./records.js";
import { parseTransportIdentity, uniqueIds, stringField, integerField, permissionSetField, validVerifier, validMutationId, mutationIdField, scopesField } from "./values.js";

/** Pure route parsing: no state, transactions or authorization decisions. */
function invalidInput(error: string, status: number) {
  return {
    ok: false as const,
    error,
    status
  };
}
export function parseRunnerConnection(input: InternalInput) {
  const identity = parseTransportIdentity(input);
  const credentialVersion = integerField(input, "credential_version");
  const nowMs = integerField(input, "now_ms");
  const metadata = RunnerMetadataSchema.safeParse(input.metadata);
  const protocolMin = integerField(input, "min_protocol_version");
  const protocolMax = integerField(input, "max_protocol_version");
  if (!metadata.success || !identity.valid || credentialVersion === undefined || nowMs === undefined || protocolMin === undefined || protocolMax === undefined || protocolMin < 1 || protocolMin > protocolMax || protocolMax > 1_000) return invalidInput("invalid connection metadata", 400);
  return {
    ok: true as const,
    value: {
      sessionId: identity.sessionId,
      lifecycleId: identity.lifecycleId,
      credentialVersion,
      nowMs,
      metadata,
      protocolMin,
      protocolMax
    } as const
  };
}
export function parseRunnerHeartbeat(input: InternalInput) {
  const epoch = integerField(input, "epoch");
  const credentialVersion = integerField(input, "credential_version");
  const nowMs = integerField(input, "now_ms");
  const identity = parseTransportIdentity(input);
  if (epoch === undefined || credentialVersion === undefined || nowMs === undefined || !identity.valid) return invalidInput("invalid heartbeat", 400);
  return {
    ok: true as const,
    value: {
      epoch,
      credentialVersion,
      nowMs,
      identity
    } as const
  };
}
export function parseRunnerSession(input: InternalInput) {
  const epoch = integerField(input, "epoch");
  const credentialVersion = integerField(input, "credential_version");
  const identity = parseTransportIdentity(input);
  if (epoch === undefined || credentialVersion === undefined || !identity.valid) return invalidInput("invalid session identity", 400);
  return {
    ok: true as const,
    value: {
      epoch,
      credentialVersion,
      identity
    } as const
  };
}
export function parseRunnerDisconnect(input: InternalInput) {
  const epoch = integerField(input, "epoch");
  const credentialVersion = integerField(input, "credential_version");
  const nowMs = integerField(input, "now_ms");
  const identity = parseTransportIdentity(input);
  if (epoch === undefined || credentialVersion === undefined || nowMs === undefined || input.state !== "offline" && input.state !== "stale" || !identity.valid) return invalidInput("invalid disconnect", 400);
  return {
    ok: true as const,
    value: {
      epoch,
      credentialVersion,
      nowMs,
      identity,
      state: input.state
    } as const
  };
}
export function parseRunnerSync(input: InternalInput, runnerId: string) {
  const epoch = integerField(input, "epoch");
  const credentialVersion = integerField(input, "credential_version");
  const nowMs = integerField(input, "now_ms");
  const message = RunnerSyncSchema.safeParse(input.message);
  const identity = parseTransportIdentity(input);
  if (!message.success || epoch === undefined || credentialVersion === undefined || nowMs === undefined || !identity.valid || message.data.runner_id !== runnerId || message.data.workspaces.length > MAX_SYNC_ITEMS || message.data.jobs.length > MAX_SYNC_ITEMS || !uniqueIds(message.data.workspaces.map(workspace => workspace.workspace_id)) || !uniqueIds(message.data.jobs.map(job => job.job_id))) return invalidInput("invalid sync", 400);
  return {
    ok: true as const,
    value: {
      epoch,
      credentialVersion,
      nowMs,
      message,
      identity
    } as const
  };
}
export function parseJobFilters(url: URL) {
  const workspaceId = url.searchParams.get("workspace_id") ?? undefined;
  const status = url.searchParams.get("status") ?? undefined;
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? undefined : /^\d+$/.test(rawLimit) ? Number(rawLimit) : undefined;
  if (workspaceId !== undefined && !IdentifierSchema.safeParse(workspaceId).success || status !== undefined && !["queued", "running", "cancelling", "cancelled", "succeeded", "failed", "unknown", "interrupted"].includes(status) || rawLimit !== null && (limit === undefined || limit < 1 || limit > 100)) return invalidInput("invalid job filters", 400);
  return {
    ok: true as const,
    value: {
      workspaceId,
      status,
      limit
    } as const
  };
}
export function parseMcpCallFilters(url: URL) {
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? undefined : /^\d+$/.test(rawLimit) ? Number(rawLimit) : undefined;
  if (rawLimit !== null && (limit === undefined || limit < 1 || limit > 100)) return invalidInput("invalid MCP call filters", 400);
  return {
    ok: true as const,
    value: {
      limit
    } as const
  };
}
export function parseMcpCall(input: InternalInput) {
  const epoch = integerField(input, "epoch");
  const credentialVersion = integerField(input, "credential_version");
  const nowMs = integerField(input, "now_ms");
  const identity = parseTransportIdentity(input);
  const callId = stringField(input, "call_id", 128);
  const clientId = stringField(input, "client_id", 128);
  const methodName = stringField(input, "method", 128);
  const status = input.status === "ok" || input.status === "error" ? input.status : undefined;
  const startedAtMs = integerField(input, "started_at_ms");
  const completedAtMs = integerField(input, "completed_at_ms");
  const durationMs = integerField(input, "duration_ms");
  const errorCode = input.error_code === undefined || input.error_code === null ? null : stringField(input, "error_code", 128);
  const workspaceId = input.workspace_id === undefined || input.workspace_id === null ? null : stringField(input, "workspace_id", 128);
  const jobId = input.job_id === undefined || input.job_id === null ? null : stringField(input, "job_id", 128);
  if (epoch === undefined || credentialVersion === undefined || nowMs === undefined || !identity.valid || callId === undefined || !validMutationId(callId) || clientId === undefined || methodName === undefined || status === undefined || startedAtMs === undefined || completedAtMs === undefined || durationMs === undefined || (errorCode === null ? false : errorCode === undefined) || (workspaceId === null ? false : workspaceId === undefined) || (jobId === null ? false : jobId === undefined)) return invalidInput("invalid MCP call", 400);
  if (completedAtMs - startedAtMs !== durationMs) return invalidInput("invalid MCP call duration", 400);
  return {
    ok: true as const,
    value: {
      epoch,
      credentialVersion,
      nowMs,
      identity,
      callId,
      clientId,
      methodName,
      status,
      startedAtMs,
      completedAtMs,
      durationMs,
      errorCode,
      workspaceId,
      jobId
    } as const
  };
}
export function parseAdminSession(input: InternalInput, nowMs: number) {
  const sessionHash = stringField(input, "session_hash", 64);
  const csrfHash = stringField(input, "csrf_hash", 64);
  const expires = integerField(input, "expires_at_ms");
  const expectedVersion = integerField(input, "expected_session_version");
  if (sessionHash === undefined || csrfHash === undefined || expires === undefined || expectedVersion === undefined || expectedVersion < 1 || !validVerifier(sessionHash) || !validVerifier(csrfHash) || expires <= nowMs) return invalidInput("invalid session", 400);
  return {
    ok: true as const,
    value: {
      sessionHash,
      csrfHash,
      expires,
      expectedVersion
    } as const
  };
}
export function parseMcpIdentity(input: InternalInput) {
  if (input.identity_version !== 2 || input.scopes !== undefined) return invalidInput("invalid identity version or mixed scope fields", 400);
  const id = stringField(input, "client_id", 128),
    label = stringField(input, "label", 256);
  const verifier = stringField(input, "secret_verifier", 64),
    prefix = stringField(input, "secret_prefix", 16);
  const scopes = Array.isArray(input.native_scopes) && input.native_scopes.length === 0 ? [] : scopesField(input.native_scopes);
  if (id === undefined || label === undefined || verifier === undefined || prefix === undefined || scopes === undefined) return invalidInput("invalid identity", 400);
  return {
    ok: true as const,
    value: {
      id,
      label,
      verifier,
      prefix,
      scopes
    } as const
  };
}
export function parseNativeMcpClient(input: InternalInput) {
  const id = stringField(input, "client_id", 128);
  const label = stringField(input, "label", 256);
  const verifier = stringField(input, "secret_verifier", 64);
  const prefix = stringField(input, "secret_prefix", 16);
  const scopes = scopesField(input.scopes);
  if (id === undefined || label === undefined || verifier === undefined || prefix === undefined || scopes === undefined) return invalidInput("invalid client", 400);
  return {
    ok: true as const,
    value: {
      id,
      label,
      verifier,
      prefix,
      scopes
    } as const
  };
}
export function parseManagedWorkspace(input: InternalInput) {
  const workspaceId = stringField(input, "workspace_id", 128);
  const displayName = stringField(input, "display_name", 256);
  const rootPath = stringField(input, "root_path", 4_096);
  const permissions = permissionSetField(input.permissions);
  const mutationId = mutationIdField(input);
  if (workspaceId === undefined || displayName === undefined || rootPath === undefined || permissions === undefined || mutationId === undefined || typeof input.enabled !== "boolean") return invalidInput("invalid workspace mutation", 400);
  return {
    ok: true as const,
    value: {
      workspaceId,
      displayName,
      rootPath,
      permissions,
      mutationId,
      enabled: input.enabled
    } as const
  };
}
export function parseRunnerVersionPolicy(input: InternalInput) {
  const channel = input.update_channel;
  const desired = input.desired_runner_version;
  const latest = input.latest_runner_version;
  if (channel !== "stable" && channel !== "pinned" || desired !== undefined && typeof desired !== "string" || latest !== undefined && typeof latest !== "string") return invalidInput("invalid runner version policy", 400);
  return {
    ok: true as const,
    value: {
      channel,
      desired,
      latest
    } as const
  };
}
