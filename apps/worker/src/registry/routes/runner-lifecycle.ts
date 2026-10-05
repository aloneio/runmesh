import type { RunnerRoute } from "./request.js";
import { parseRunnerHeartbeat, parseRunnerSession } from "../route-inputs.js";
import { registryInputError } from "../route-projections.js";
import { validTimestamp } from "../../validity.js";
import { validWindow } from "../../validity.js";
import type { ValidityWindow } from "../../validity.js";
import type { ValidityStatus } from "../../validity.js";
import type { RunnerExecutionMode, RunnerMutationState, RunnerRecord, RunnerRow, EnrollmentRow } from "../records.js";
import { requestedExecutionMode, requestedExpectedExecutionMode, requestedExpectedLifecycleId, requestedPrivilegedConfirmation, requestedRunnerEnrollmentTtl, stringField, validVerifier, validMutationId, mutationIdField } from "../values.js";
export interface RunnerLifecyclePorts {
  authorizeMcpRpc(input: Record<string, unknown>): {
    ok: true;
    record_history?: boolean;
  } | {
    ok: false;
    code: string;
  };
  runnerRow(runnerId: string): RunnerRow | undefined;
  registerRunner(runnerId: string, tokenVerifier: string, nowMs: number, mutationId?: string, configuredExecutionMode?: RunnerExecutionMode): boolean;
  recordHeartbeat(runnerId: string, epoch: number, credentialVersion: number, nowMs: number, lifecycleId: string, sessionId: string): boolean;
  sessionIsCurrent(runnerId: string, epoch: number, credentialVersion: number, requireOnline: boolean, lifecycleId: string, sessionId: string): boolean;
  addRunner(runnerId: string, displayName: string, nowMs: number, mutationId?: string, configuredExecutionMode?: RunnerExecutionMode, confirmPrivilegedHost?: boolean, validity?: ValidityWindow): RunnerRecord | undefined;
  deleteRunner(runnerId: string, confirmation: string, nowMs: number, mutationId?: string): boolean;
  renameRunner(runnerId: string, displayName: string, nowMs: number): RunnerRecord | undefined;
  createRunnerEnrollment(runnerId: string, enrollmentId: string, verifier: string, nowMs: number, configuredExecutionMode?: RunnerExecutionMode, confirmPrivilegedHost?: boolean, expectedConfiguredExecutionMode?: RunnerExecutionMode | null, expectedLifecycleId?: string, enrollmentTtlMs?: number, validityWindow?: {
    not_before_ms?: number;
    expires_at_ms?: number;
  }, mutationId?: string): {
    enrollment_id: string;
    runner_id: string;
    created_at_ms: number;
    not_before_ms: number;
    expires_at_ms: number;
  } | undefined;
  runnerAccess(runnerId: string, nowMs?: number): {
    allowed: boolean;
    status: ValidityStatus | "missing";
  };
  latestRunnerEnrollment(runnerId: string): Omit<EnrollmentRow, "verifier"> | undefined;
  setRunnerValidity(runnerId: string, validityWindow: ValidityWindow, lifecycleId: string, nowMs?: number): boolean;
  invalidateRunnerCredential(runnerId: string, nowMs: number, mutationId?: string): boolean;
  revokeRunner(runnerId: string, confirmation: string, nowMs: number, mutationId?: string): boolean;
  getRunnerMutationState(runnerId: string, mutationId: string): RunnerMutationState;
  getRunnerExecutionState(runnerId: string): {
    readonly runner: RunnerRecord;
    readonly lifecycle_id: string;
    readonly session_id: string | null;
  } | undefined;
  getRunner(runnerId: string): RunnerRecord | undefined;
}

/** Admitted requests only; authority remains with synchronous Registry operations. */
export function createRunnerLifecycleRoutes(ports: RunnerLifecyclePorts): RunnerRoute {
  return ({
    method,
    runnerId,
    action,
    itemId,
    input,
    nowMs: admittedAtMs,
    url
  }) => {
    if (method === "POST" && action === "mcp-authorization" && itemId === undefined) {
      const decision = ports.authorizeMcpRpc({
        ...input,
        runner_id: runnerId
      });
      return Response.json(decision, {
        status: decision.ok ? 200 : decision.code === "stale_policy" ? 409 : 403
      });
    }
    if (method === "PUT" && action === undefined) {
      const tokenVerifier = stringField(input, "token_verifier", 64);
      const mutationId = input.mutation_id === undefined ? undefined : mutationIdField(input);
      if (tokenVerifier === undefined || !validVerifier(tokenVerifier) || input.mutation_id !== undefined && mutationId === undefined) return Response.json({
        error: "invalid token verifier or mutation"
      }, {
        status: 400
      });
      const configuredExecutionMode = requestedExecutionMode(input);
      if (configuredExecutionMode === null) return Response.json({
        error: "invalid execution mode"
      }, {
        status: 400
      });
      const existingRunner = ports.runnerRow(runnerId);
      // A credential replacement must be fenced by RunnerDO.  The public
      // internal route is HMAC-authenticated, but an older Worker or a
      // manually replayed request must not be able to update an existing row
      // without the mutation identity that binds the Registry transaction to
      // that fence.  Creation is the only operation that may omit it.
      if (existingRunner !== undefined && mutationId === undefined) return Response.json({
        error: "mutation_id is required for credential replacement"
      }, {
        status: 400
      });
      return ports.registerRunner(runnerId, tokenVerifier, admittedAtMs, mutationId, configuredExecutionMode ?? undefined) ? new Response(null, {
        status: 204
      }) : new Response("mutation conflict", {
        status: 409
      });
    }
    if (method === "POST" && action === "heartbeat") {
      const parsed = parseRunnerHeartbeat(input);
      if (!parsed.ok) return registryInputError(parsed);
      const {
        epoch,
        credentialVersion,
        nowMs,
        identity
      } = parsed.value;
      return ports.recordHeartbeat(runnerId, epoch, credentialVersion, nowMs, identity.lifecycleId, identity.sessionId) ? new Response(null, {
        status: 204
      }) : new Response("stale session", {
        status: 409
      });
    }
    if (method === "POST" && action === "session") {
      const parsed = parseRunnerSession(input);
      if (!parsed.ok) return registryInputError(parsed);
      const {
        epoch,
        credentialVersion,
        identity
      } = parsed.value;
      return ports.sessionIsCurrent(runnerId, epoch, credentialVersion, input.require_online === true, identity.lifecycleId, identity.sessionId) ? new Response(null, {
        status: 204
      }) : new Response("stale session", {
        status: 409
      });
    }
    if (method === "POST" && action === "add") {
      const displayName = stringField(input, "display_name", 256);
      const mutationId = input.mutation_id === undefined ? undefined : mutationIdField(input);
      if (input.mutation_id !== undefined && mutationId === undefined) return Response.json({
        error: "invalid mutation_id"
      }, {
        status: 400
      });
      const configuredExecutionMode = requestedExecutionMode(input);
      const confirmation = requestedPrivilegedConfirmation(input);
      if (configuredExecutionMode === null || confirmation === null || configuredExecutionMode === "privileged_host" && confirmation !== true) return Response.json({
        error: "invalid execution mode or privileged-host confirmation"
      }, {
        status: 400
      });
      const validFrom = input.valid_from_ms === undefined || input.valid_from_ms === null ? null : validTimestamp(input.valid_from_ms) ? input.valid_from_ms : undefined;
      const validUntil = input.valid_until_ms === undefined || input.valid_until_ms === null ? null : validTimestamp(input.valid_until_ms) ? input.valid_until_ms : undefined;
      const runner = displayName === undefined || validFrom === undefined || validUntil === undefined ? undefined : ports.addRunner(runnerId, displayName, admittedAtMs, mutationId, configuredExecutionMode, confirmation === true, {
        valid_from_ms: validFrom,
        valid_until_ms: validUntil
      });
      return runner === undefined ? new Response("conflict", {
        status: 409
      }) : Response.json(runner);
    }
    if (method === "DELETE" && action === undefined) {
      const confirmation = stringField(input, "confirmation", 128);
      const mutationId = mutationIdField(input);
      return confirmation !== undefined && mutationId !== undefined && ports.deleteRunner(runnerId, confirmation, admittedAtMs, mutationId) ? new Response(null, {
        status: 204
      }) : new Response("not found", {
        status: 404
      });
    }
    if (method === "POST" && action === "rename") {
      const displayName = stringField(input, "display_name", 256);
      const runner = displayName === undefined ? undefined : ports.renameRunner(runnerId, displayName, admittedAtMs);
      return runner === undefined ? new Response("not found", {
        status: 404
      }) : Response.json(runner);
    }
    if (method === "POST" && action === "enrollments") {
      const mutationId = mutationIdField(input);
      if (Object.prototype.hasOwnProperty.call(input, "mutation_id") && mutationId === undefined) return new Response("invalid mutation", { status: 400 });
      const enrollmentId = stringField(input, "enrollment_id", 43);
      const verifier = stringField(input, "verifier", 64);
      const configuredExecutionMode = requestedExecutionMode(input);
      const confirmation = requestedPrivilegedConfirmation(input);
      const enrollmentTtlMs = requestedRunnerEnrollmentTtl(input);
      const expectedMode = requestedExpectedExecutionMode(input);
      const expectedLifecycleId = requestedExpectedLifecycleId(input);
      if (input.not_before_ms !== undefined && !validTimestamp(input.not_before_ms) || input.expires_at_ms !== undefined && !validTimestamp(input.expires_at_ms)) return new Response("invalid enrollment dates", {
        status: 400
      });
      const hasExpectedMode = Object.prototype.hasOwnProperty.call(input, "expected_execution_mode");
      const hasExpectedLifecycle = Object.prototype.hasOwnProperty.call(input, "expected_lifecycle_id");
      // Any internal caller that supplies a mode for an existing Runner must
      // also supply both CAS components. Requests that only create a code
      // retain the already-recorded administrator selection.
      if (configuredExecutionMode !== undefined && (!hasExpectedMode || !hasExpectedLifecycle)) return Response.json({
        error: "expected runner state is required for execution-mode changes"
      }, {
        status: 409
      });
      if (hasExpectedMode !== hasExpectedLifecycle || configuredExecutionMode === null || confirmation === null || configuredExecutionMode === "privileged_host" && confirmation !== true || expectedMode === "invalid" || expectedLifecycleId === null || enrollmentTtlMs === null) return Response.json({
        error: "invalid execution mode, confirmation, expiration, or expected runner state"
      }, {
        status: 400
      });
      const enrollment = enrollmentId === undefined || verifier === undefined ? undefined : ports.createRunnerEnrollment(runnerId, enrollmentId, verifier, admittedAtMs, configuredExecutionMode, confirmation === true, expectedMode, expectedLifecycleId, enrollmentTtlMs, {
        ...(input.not_before_ms === undefined ? {} : {
          not_before_ms: input.not_before_ms as number
        }),
        ...(input.expires_at_ms === undefined ? {} : {
          expires_at_ms: input.expires_at_ms as number
        })
      }, mutationId);
      return enrollment === undefined ? new Response("not found", {
        status: 404
      }) : Response.json(enrollment);
    }
    if (method === "GET" && action === "access") return Response.json(ports.runnerAccess(runnerId, admittedAtMs));
    if (method === "GET" && action === "enrollments") return Response.json({
      enrollment: ports.latestRunnerEnrollment(runnerId) ?? null
    });
    if (method === "POST" && action === "validity") {
      const validityWindow = {
        valid_from_ms: input.valid_from_ms,
        valid_until_ms: input.valid_until_ms
      } as ValidityWindow;
      const lifecycleId = requestedExpectedLifecycleId(input);
      if (!validWindow(validityWindow) || typeof lifecycleId !== "string") return new Response("invalid validity window", {
        status: 400
      });
      return ports.setRunnerValidity(runnerId, validityWindow, lifecycleId, admittedAtMs) ? new Response(null, {
        status: 204
      }) : new Response("runner state changed", {
        status: 409
      });
    }
    if (method === "POST" && action === "rotate") {
      const mutationId = mutationIdField(input);
      if (ports.runnerRow(runnerId) === undefined) return new Response("not found", {
        status: 404
      });
      if (mutationId === undefined) return Response.json({
        error: "mutation_id is required"
      }, {
        status: 400
      });
      return ports.invalidateRunnerCredential(runnerId, admittedAtMs, mutationId) ? new Response(null, {
        status: 204
      }) : new Response("mutation conflict", {
        status: 409
      });
    }
    if (method === "POST" && action === "revoke") {
      const confirmation = stringField(input, "confirmation", 128);
      const mutationId = mutationIdField(input);
      return confirmation !== undefined && confirmation === runnerId && mutationId !== undefined && ports.revokeRunner(runnerId, confirmation, admittedAtMs, mutationId) ? new Response(null, {
        status: 204
      }) : new Response("not found", {
        status: 404
      });
    }
    if (method === "GET" && action === "mutation-state" && itemId === undefined) {
      const mutationId = url.searchParams.get("mutation_id");
      return mutationId !== null && validMutationId(mutationId) ? Response.json(ports.getRunnerMutationState(runnerId, mutationId)) : Response.json({
        error: "invalid mutation_id"
      }, {
        status: 400
      });
    }
    if (method === "GET" && action === "execution-state" && itemId === undefined) {
      const state = ports.getRunnerExecutionState(runnerId);
      return state === undefined ? new Response("not found", {
        status: 404
      }) : Response.json(state);
    }
    if (method === "GET" && action === undefined && itemId === undefined) {
      const runner = ports.getRunner(runnerId);
      return runner === undefined ? Response.json({
        error: "runner not found"
      }, {
        status: 404
      }) : Response.json(runner);
    }
    return undefined;
  };
}
