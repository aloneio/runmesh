import type { RunnerRouteRequest } from "./route-inputs.js";
import type { PackedHistoryPort, AuditHistoryPort } from "./history-ports.js";
import { parseRunnerSync, parseJobFilters, parseMcpCallFilters, parseMcpCall } from "./route-inputs.js";
import { registryInputError, projectCombinedMcpCalls } from "./route-projections.js";
import type { JobHistorySettings } from "@aloneio/runmesh-protocol";
import { controlPlaneUnavailableResponse } from "../control-plane-errors.js";
import type { JobMetadata } from "@aloneio/runmesh-protocol";
import { IdentifierSchema } from "@aloneio/runmesh-protocol";
import { projectMcpAuditMetadata } from "../audit-metadata.js";
import type { RegistryFeatureKey, McpClientRecord, RunnerRow } from "./records.js";
import { parseTransportIdentity, parseJobEvent, integerField } from "./values.js";
export interface RunnerHistoryPorts {
  runnerRow(runnerId: string): RunnerRow | undefined;
  jobHistorySettings(runnerId: string, lifecycleId?: string): JobHistorySettings;
  setJobHistorySettings(runnerId: string, value: unknown): boolean;
  syncRunner(runnerId: string, epoch: number, credentialVersion: number, _workspaces: readonly {
    readonly workspace_id: string;
  }[], jobs: readonly {
    readonly job_id: string;
    readonly runner_id?: string | undefined;
    readonly updated_at_ms?: number;
  }[], syncSequence: number, nowMs: number, requireOnline: boolean, lifecycleId: string, sessionId: string): boolean;
  sessionIsCurrent(runnerId: string, epoch: number, credentialVersion: number, requireOnline: boolean, lifecycleId: string, sessionId: string): boolean;
  recordJobEvent(runnerId: string, epoch: number, credentialVersion: number, message: unknown, nowMs: number, requireOnline: boolean, lifecycleId: string, sessionId: string): boolean;
  listJobs(runnerId: string, filters?: {
    readonly workspace_id?: string;
    readonly status?: string;
    readonly limit?: number;
  }): unknown[];
  listMcpCalls(runnerId: string, limit?: number): unknown[];
  featureHealthDisabled(feature: RegistryFeatureKey, nowMs?: number): boolean;
  recordMcpCall(runnerId: string, epoch: number, credentialVersion: number, call: Record<string, unknown>, nowMs: number, requireOnline: boolean, lifecycleId: string, sessionId: string, captureAudit?: (metadata: Record<string, unknown>) => void): boolean;
  recordsJobActivity(clientId: string): boolean;
  getJob(runnerId: string, jobId: string): unknown | undefined;
  runnerMatchesTransportFence(current: RunnerRow | undefined, epoch: number, credentialVersion: number, requireOnline: boolean, lifecycleId: string, sessionId: string): current is RunnerRow;
  getMcpClient(clientId: string): McpClientRecord | undefined;
  readonly packedHistory: boolean;
  readonly externalAuditing: boolean;
  readonly packedJobs: PackedHistoryPort | undefined;
  readonly externalAudit: AuditHistoryPort | undefined;
}

/** Admitted requests only; authority remains with synchronous Registry operations. */
export function createRunnerHistoryRoutes(ports: RunnerHistoryPorts): (request: RunnerRouteRequest) => Promise<Response | undefined> {
  const currentHistorySettings = (runnerId: string, lifecycle: string): JobHistorySettings | undefined =>
    ports.runnerRow(runnerId)?.lifecycle_id === lifecycle ? ports.jobHistorySettings(runnerId, lifecycle) : undefined;
  return async ({
    method,
    runnerId,
    action,
    itemId,
    input,
    url
  }) => {
    if (action === "history-settings" && itemId === undefined) {
      if (ports.runnerRow(runnerId) === undefined) return new Response("not found", {
        status: 404
      });
      if (method === "GET") return Response.json(ports.jobHistorySettings(runnerId));
      if (method === "POST") {
        if (!ports.setJobHistorySettings(runnerId, input)) return new Response("invalid history settings", {
          status: 400
        });
        const settings = ports.jobHistorySettings(runnerId);
        const life = ports.runnerRow(runnerId)?.lifecycle_id;
        if (ports.packedJobs !== undefined && life !== undefined) {
          let pending = false;
          try {
            await ports.packedJobs.setRetention(runnerId, life, () => currentHistorySettings(runnerId, life));
          } catch {
            pending = true;
          }
          const current = currentHistorySettings(runnerId, life);
          if (current === undefined) return new Response("history identity changed", { status: 409 });
          return Response.json(pending ? { ...current, cleanup_update: "pending_next_upload" } : current, { status: pending ? 202 : 200 });
        }
        return Response.json(settings);
      }
    }
    if (method === "POST" && action === "sync") {
      const parsed = parseRunnerSync(input, runnerId);
      if (!parsed.ok) return registryInputError(parsed);
      const {
        epoch,
        credentialVersion,
        nowMs,
        message,
        identity
      } = parsed.value;
      if (ports.packedHistory) return storePackedJobs(runnerId, epoch, credentialVersion, identity.lifecycleId, identity.sessionId, message.data.jobs);
      const current = ports.runnerRow(runnerId);
      if (!ports.runnerMatchesTransportFence(current, epoch, credentialVersion, true, identity.lifecycleId, identity.sessionId)) {
        return new Response("stale sync session", { status: 409 });
      }
      const receipt = (status: "recorded" | "unchanged" | "disabled" | "degraded") =>
        message.data.extensions?.runmesh_history_ack === true
          ? Response.json({ history_status: status }, { status: status === "degraded" ? 202 : 200 })
          : new Response(null, { status: 204 });
      if (ports.jobHistorySettings(runnerId, identity.lifecycleId).mode === "off") return receipt("disabled");
      // WebSocket handlers can reach Registry out of order. An older snapshot
      // from the current session is already superseded, not a replaced session.
      if (current.last_sync_sequence !== null && message.data.sync_sequence <= current.last_sync_sequence) return receipt("unchanged");
      if (!ports.syncRunner(runnerId, epoch, credentialVersion, message.data.workspaces, message.data.jobs, message.data.sync_sequence, nowMs, true, identity.lifecycleId, identity.sessionId)) {
        return new Response("stale sync session", { status: 409 });
      }
      return receipt(ports.featureHealthDisabled("job_recording", nowMs) ? "degraded" : "recorded");
    }
    if (method === "POST" && action === "event") {
      const epoch = integerField(input, "epoch");
      const credentialVersion = integerField(input, "credential_version");
      const nowMs = integerField(input, "now_ms");
      const identity = parseTransportIdentity(input);
      if (epoch === undefined || credentialVersion === undefined || nowMs === undefined || !identity.valid) return Response.json({
        error: "invalid event identity"
      }, {
        status: 400
      });
      if (ports.packedHistory) {
        // Old Runners emit events AND snapshots. Only the complete snapshot
        // goes to optional history; no per-event nonce, Job or audit write.
        if (parseJobEvent(input.message) === undefined) return new Response("invalid event", {
          status: 400
        });
        return ports.sessionIsCurrent(runnerId, epoch, credentialVersion, true, identity.lifecycleId, identity.sessionId) ? new Response(null, {
          status: 204
        }) : new Response("stale session", {
          status: 409
        });
      }
      if (!ports.recordJobEvent(runnerId, epoch, credentialVersion, input.message, nowMs, true, identity.lifecycleId, identity.sessionId)) return new Response("stale session or invalid event", {
        status: 409
      });
      return new Response(null, {
        status: 204
      });
    }
    if (method === "GET" && action === "jobs" && itemId === undefined) {
      const parsed = parseJobFilters(url);
      if (!parsed.ok) return registryInputError(parsed);
      const {
        workspaceId,
        status,
        limit
      } = parsed.value;
      if (ports.packedHistory) {
        const current = ports.runnerRow(runnerId);
        if (current === undefined) return new Response("not found", {
          status: 404
        });
        try {
          if (ports.packedJobs === undefined) throw new Error("history unavailable");
          const result = await ports.packedJobs.list(runnerId, current.lifecycle_id, ports.jobHistorySettings(runnerId, current.lifecycle_id), {
            ...(workspaceId === undefined ? {} : {
              workspace_id: workspaceId
            }),
            ...(status === undefined ? {} : {
              status
            }),
            ...(limit === undefined ? {} : {
              limit
            })
          });
          if (ports.runnerRow(runnerId)?.lifecycle_id !== current.lifecycle_id) return new Response("history identity changed", {
            status: 409
          });
          return Response.json({
            runner_id: runnerId,
            source: "packed_d1_snapshot",
            ...result
          });
        } catch {
          return Response.json({
            error: {
              code: "job_history_unavailable",
              message: "Job history is unavailable; query the online Runner with workspace_id."
            }
          }, {
            status: 503,
            headers: {
              "cache-control": "no-store",
              "retry-after": "900"
            }
          });
        }
      }
      return Response.json({
        runner_id: runnerId,
        jobs: ports.listJobs(runnerId, {
          ...(workspaceId === undefined ? {} : {
            workspace_id: workspaceId
          }),
          ...(status === undefined ? {} : {
            status
          }),
          ...(limit === undefined ? {} : {
            limit
          })
        })
      });
    }
    if (method === "GET" && action === "mcp-calls" && itemId === undefined) {
      const parsed = parseMcpCallFilters(url);
      if (!parsed.ok) return registryInputError(parsed);
      const {
        limit
      } = parsed.value;
      if (ports.externalAuditing) {
        const current = ports.runnerRow(runnerId);
        if (current === undefined) return new Response("not found", {
          status: 404
        });
        try {
          if (ports.externalAudit === undefined) throw new Error("audit unavailable");
          const external = await ports.externalAudit.list(runnerId, current.lifecycle_id, limit);
          if (ports.runnerRow(runnerId)?.lifecycle_id !== current.lifecycle_id) return new Response("Runner identity changed", {
            status: 409
          });
          // Previously recorded DO rows retain their normal retention period.
          // No fallback is used when D1 fails: an empty success would lie.
          return Response.json(projectCombinedMcpCalls(runnerId, ports.listMcpCalls(runnerId, limit).map(projectMcpAuditMetadata), external, limit));
        } catch {
          return Response.json({
            error: {
              code: "audit_history_unavailable",
              message: "Cloud audit history is temporarily unavailable; this does not undo execution."
            }
          }, {
            status: 503,
            headers: {
              "cache-control": "no-store",
              "retry-after": "900"
            }
          });
        }
      }
      return Response.json({
        runner_id: runnerId,
        calls: ports.listMcpCalls(runnerId, limit)
      });
    }
    if (method === "POST" && action === "mcp-calls" && itemId === undefined) {
      const parsed = parseMcpCall(input);
      if (!parsed.ok) return registryInputError(parsed);
      const {
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
      } = parsed.value;
      const wasDegraded = ports.featureHealthDisabled("mcp_audit", nowMs);
      let captured: Record<string, unknown> | undefined;
      const capture = ports.externalAuditing ? (metadata: Record<string, unknown>) => {
        captured = metadata;
      } : undefined;
      const accepted = ports.recordMcpCall(runnerId, epoch, credentialVersion, {
        call_id: callId,
        client_id: clientId,
        method: methodName,
        workspace_id: workspaceId,
        job_id: jobId,
        result_runner_id: input.result_runner_id ?? null,
        status,
        error_code: errorCode,
        started_at_ms: startedAtMs,
        completed_at_ms: completedAtMs,
        duration_ms: durationMs
      }, nowMs, false, identity.lifecycleId, identity.sessionId, capture);
      if (!accepted) return new Response("stale session or invalid MCP call", {
        status: 409
      });
      const disabled = (methodName.startsWith("exec.") || methodName.startsWith("job.")) && !ports.recordsJobActivity(clientId);
      const externalSaved = capture === undefined || !disabled && captured !== undefined && (await ports.externalAudit?.append(captured)) === true;
      const auditStatus = disabled ? "disabled" : !externalSaved || wasDegraded || ports.featureHealthDisabled("mcp_audit", nowMs) ? "degraded" : "recorded";
      return Response.json({
        audit_status: auditStatus
      }, {
        status: auditStatus === "recorded" ? 200 : 202
      });
    }
    if (method === "GET" && action === "jobs" && itemId !== undefined && IdentifierSchema.safeParse(itemId).success) {
      const current = ports.runnerRow(runnerId);
      if (current === undefined) return new Response("not found", {
        status: 404
      });
      let job: unknown;
      if (ports.packedHistory) {
        if (ports.packedJobs === undefined) return controlPlaneUnavailableResponse();
        try {
          job = await ports.packedJobs.get(runnerId, current.lifecycle_id, itemId, ports.jobHistorySettings(runnerId, current.lifecycle_id));
        } catch {
          return Response.json({
            error: {
              code: "job_history_unavailable"
            }
          }, {
            status: 503
          });
        }
        if (ports.runnerRow(runnerId)?.lifecycle_id !== current.lifecycle_id) return new Response("history identity changed", {
          status: 409
        });
      } else job = ports.getJob(runnerId, itemId);
      return job === undefined ? Response.json({
        error: "job not yet archived; use workspace_id for live access"
      }, {
        status: 404
      }) : Response.json(job);
    }
    return undefined;
    async function storePackedJobs(runnerId: string, epoch: number, credentialVersion: number, lifecycle: string, session: string, jobs: readonly JobMetadata[]): Promise<Response> {
      const runner = ports.runnerRow(runnerId);
      if (!ports.runnerMatchesTransportFence(runner, epoch, credentialVersion, true, lifecycle, session)) return new Response("stale history session", {
        status: 409
      });
      const settings = ports.jobHistorySettings(runnerId, lifecycle);
      if (settings.mode === "off") return Response.json({
        history_status: "disabled"
      });
      const recordableNewJobIds = (batch: readonly JobMetadata[]): ReadonlySet<string> => {
        const clients = new Map<string, McpClientRecord | undefined>();
        return new Set(batch.filter(job => {
          if (job.created_by_client_id === undefined) return true;
          if (!clients.has(job.created_by_client_id)) clients.set(job.created_by_client_id, ports.getMcpClient(job.created_by_client_id));
          const client = clients.get(job.created_by_client_id);
          return client !== undefined && client.record_jobs !== false && job.created_at_ms >= (client.record_jobs_since_ms ?? 0);
        }).map(job => job.job_id));
      };
      // Empty updates are not deletions. A nonempty batch needs one bounded
      // snapshot read: an opted-out client can still update an archived Job.
      // Registry owns first-admission decisions; the sink knows which Jobs exist.
      if (jobs.length === 0) return Response.json({
        history_status: "unchanged"
      });
      try {
        if (ports.packedJobs === undefined) throw new Error("history unavailable");
        const saved = await ports.packedJobs.merge(runnerId, lifecycle, jobs, () => currentHistorySettings(runnerId, lifecycle), recordableNewJobIds);
        return Response.json({
          history_status: saved.recorded ? "recorded" : saved.deferred ? "deferred" : "unchanged",
          updated_at_ms: saved.updated_at_ms
        });
      } catch {
        return Response.json({
          history_status: "degraded"
        }, {
          status: 202
        });
      }
    }
  };
}
