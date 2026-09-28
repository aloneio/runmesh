import type { RunnerRouteRequest } from "./route-inputs.js";
import { parseRunnerConnection, parseRunnerDisconnect } from "./route-inputs.js";
import { registryInputError } from "./route-projections.js";
import type { RunnerConnectionState } from "../contracts/runner-selection.js";
import type { JobHistorySettings } from "../job-history-settings.js";
import type { RunnerMetadata } from "@aloneio/runmesh-protocol";
import type { RunnerPolicy } from "@aloneio/runmesh-protocol";
import { containsControlCharacter } from "../security.js";
import type { RunnerRow } from "./records.js";
import { validLifecycleId, stringField } from "./values.js";
export interface RunnerTransportPorts {
  authenticateRunner(runnerId: string, token: string): Promise<{
    credential_version: number;
  } | undefined>;
  beginConnection(runnerId: string, metadata: RunnerMetadata, protocol: {
    min_protocol_version: number;
    max_protocol_version: number;
  }, sessionId: string, credentialVersion: number, nowMs: number): number | undefined;
  runnerRow(runnerId: string): RunnerRow | undefined;
  desiredPolicy(runnerId: string): RunnerPolicy | undefined;
  scheduleMaintenanceAlarm(nowMs: number): Promise<void>;
  jobHistorySettings(runnerId: string, lifecycleId?: string): JobHistorySettings;
  markDisconnected(runnerId: string, epoch: number, credentialVersion: number, state: Exclude<RunnerConnectionState, "online">, nowMs: number, lifecycleId: string, sessionId: string): void;
  readonly packedHistory: boolean;
}

/** Admitted requests only; authority remains with synchronous Registry operations. */
export function createRunnerTransportRoutes(ports: RunnerTransportPorts): (request: RunnerRouteRequest) => Promise<Response | undefined> {
  return async ({
    method,
    runnerId,
    action,
    input,
    nowMs: admittedAtMs
  }) => {
    if (method === "POST" && action === "auth") {
      const token = stringField(input, "token", 512);
      if (token === undefined || /\s/.test(token) || containsControlCharacter(token)) return new Response("unauthorized", {
        status: 401
      });
      const authenticated = await ports.authenticateRunner(runnerId, token);
      return authenticated === undefined ? new Response("unauthorized", {
        status: 401
      }) : Response.json(authenticated);
    }
    if (method === "POST" && action === "connect") {
      const parsed = parseRunnerConnection(input);
      if (!parsed.ok) return registryInputError(parsed);
      const {
        sessionId,
        credentialVersion,
        nowMs,
        metadata,
        protocolMin,
        protocolMax
      } = parsed.value;
      const epoch = ports.beginConnection(runnerId, metadata.data, {
        min_protocol_version: protocolMin,
        max_protocol_version: protocolMax
      }, sessionId, credentialVersion, nowMs);
      const row = epoch === undefined ? undefined : ports.runnerRow(runnerId);
      const policy = epoch === undefined ? undefined : ports.desiredPolicy(runnerId);
      if (epoch === undefined || row === undefined || row.connection_epoch !== epoch || row.session_id !== sessionId || !validLifecycleId(row.lifecycle_id)) {
        return new Response("stale credentials", {
          status: 409
        });
      }
      await ports.scheduleMaintenanceAlarm(admittedAtMs);
      return Response.json({
        epoch,
        lifecycle_id: row.lifecycle_id,
        desired_policy: policy,
        ...(ports.packedHistory && metadata.data.capabilities.labels.job_history_protocol === "1" ? {
          job_history: ports.jobHistorySettings(runnerId, row.lifecycle_id),
          ...(metadata.data.capabilities.labels.job_reporting_protocol === "2" ? {
            job_reporting: 2
          } : {})
        } : {})
      });
    }
    if (method === "POST" && action === "disconnect") {
      const parsed = parseRunnerDisconnect(input);
      if (!parsed.ok) return registryInputError(parsed);
      const {
        epoch,
        credentialVersion,
        nowMs,
        identity,
        state
      } = parsed.value;
      ports.markDisconnected(runnerId, epoch, credentialVersion, state, nowMs, identity.lifecycleId, identity.sessionId);
      // Drop a stale maintenance alarm as soon as the last online runner
      // disconnects instead of waiting for the old deadline to wake this DO.
      await ports.scheduleMaintenanceAlarm(nowMs);
      return new Response(null, {
        status: 204
      });
    }
    return undefined;
  };
}
