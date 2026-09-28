import { createRunner } from "../application/create-runner.js";
import { registerRunner } from "../application/register-runner.js";
import { regenerateRunnerEnrollment } from "../application/runner-enrollment.js";
import { createEnrollmentCode } from "../application/enrollment.js";
import { revokeRunner, rotateRunner } from "../application/runner-credentials.js";
import { runnerExecutionSnapshot } from "../application/runner-queries.js";
import type { RunnerActionFailure, RunnerActionPorts, RunnerWriteOutcome } from "../contracts/runner-administration.js";
import type { EnrollmentWindow, ExecutionModeSelection, RunnerExecutionSnapshot } from "../contracts/runner-admin.js";
import { runnerRegistryRequest } from "../platform/control-plane.js";
import type { WorkerEnv } from "../platform/env.js";
import { fenceRunnerTransport, beginRunnerPolicyMutation, cancelRunnerPolicyMutation } from "../platform/runner-mutations.js";
import { runnerTokenVerifier } from "../security.js";
import { record } from "../values.js";
import { json } from "../platform/control-plane.js";
import type { ValidityWindow } from "../validity.js";
import { runnerLifecyclePorts } from "./runner-mutations.js";
import { adminError, adminRunnerError } from "./responses.js";
export function runnerWriteOutcome(response: Response): RunnerWriteOutcome {
  return response.ok ? "accepted" : response.status === 400 ? "invalid" : response.status === 404 ? "missing" : response.status === 409 ? "conflict" : "unknown";
}
function actionPorts(env: WorkerEnv, prefix: string): RunnerActionPorts {
  return {
    ...runnerLifecyclePorts(env),
    mutationId: () => prefix + crypto.randomUUID(),
    fence: async (id, mutation) => (await fenceRunnerTransport(env, id, mutation)).ok
  };
}
type EnrollmentOptions = {
  readonly selection: ExecutionModeSelection;
  readonly ttlMs: number | undefined;
  readonly window: EnrollmentWindow | undefined;
};
export function registerRunnerFromControlPlane(env: WorkerEnv, runnerId: string, token: string, pepper: string, mode: ExecutionModeSelection["mode"] | undefined) {
  return registerRunner({
    ...actionPorts(env, "credential-rotated-"),
    read: async id => {
      const response = await runnerRegistryRequest(env, id, "", "GET", "");
      return response.ok ? "available" : response.status === 404 ? "missing" : "unavailable";
    },
    write: async (id, mutation) => runnerWriteOutcome(await runnerRegistryRequest(env, id, "", "PUT", JSON.stringify({
      token_verifier: await runnerTokenVerifier(token, pepper),
      mutation_id: mutation,
      ...(mode === undefined ? {} : {
        execution_mode: mode
      })
    })))
  }, runnerId, mode !== undefined);
}
export function regenerateEnrollmentFromControlPlane(env: WorkerEnv, runnerId: string, initial: RunnerExecutionSnapshot, input: EnrollmentOptions) {
  return regenerateRunnerEnrollment({
    mutationId: () => "runner-enrollment-" + crypto.randomUUID(),
    fence: async (id, mutation) => (await beginRunnerPolicyMutation(env, id, mutation)).ok,
    cancel: runnerLifecyclePorts(env).cancel,
    snapshot: async id => {
      const result = await runnerExecutionSnapshot(env, id);
      return result.snapshot === undefined ? {
        state: result.status === 404 ? "missing" : "unavailable"
      } : {
        state: "available",
        snapshot: result.snapshot
      };
    },
    enroll: (id, snapshot) => createEnrollmentCode(env, id, input.selection, {
      configuredMode: snapshot.configuredMode,
      lifecycleId: snapshot.lifecycleId
    }, input.ttlMs, input.window),
    release: async (id, mutation) => {
      const response = await cancelRunnerPolicyMutation(env, id, mutation);
      if (response.ok) return {
        released: true
      };
      const candidate = record(record(await json(response))?.error)?.code;
      const safe = new Set(["mutation_state_changed", "mutation_mismatch", "mutation_committed", "mutation_uncertain", "no_active_mutation", "runner_unavailable", "registry_unavailable", "control_plane_unavailable"]);
      return {
        released: false,
        diagnostic: typeof candidate === "string" && safe.has(candidate) ? candidate : "cleanup_unavailable"
      };
    }
  }, runnerId, initial);
}
export function createRunnerFromControlPlane(env: WorkerEnv, runnerId: string, input: EnrollmentOptions & {
  readonly displayName: string;
  readonly validity: ValidityWindow;
}) {
  return createRunner({
    ...actionPorts(env, "runner-create-"),
    canRead: async id => {
      const response = await runnerRegistryRequest(env, id, "", "GET", "");
      return response.ok || response.status === 404;
    },
    create: async (id, mutation) => runnerWriteOutcome(await runnerRegistryRequest(env, id, "/add", "POST", JSON.stringify({
      display_name: input.displayName,
      mutation_id: mutation,
      execution_mode: input.selection.mode,
      confirm_privileged_host: input.selection.confirmed,
      ...input.validity
    }))),
    enroll: (id, lifecycleId) => createEnrollmentCode(env, id, input.selection, {
      configuredMode: input.selection.mode,
      lifecycleId
    }, input.ttlMs, input.window)
  }, runnerId);
}
export function rotateRunnerFromControlPlane(env: WorkerEnv, runnerId: string, initial: RunnerExecutionSnapshot, input: EnrollmentOptions) {
  return rotateRunner({
    ...actionPorts(env, "credential-rotated-"),
    snapshot: async id => {
      const result = await runnerExecutionSnapshot(env, id);
      return result.snapshot === undefined ? {
        state: result.status === 404 ? "missing" : "unavailable"
      } : {
        state: "available",
        snapshot: result.snapshot
      };
    },
    rotate: async (id, mutation) => runnerWriteOutcome(await runnerRegistryRequest(env, id, "/rotate", "POST", JSON.stringify({
      mutation_id: mutation
    }))),
    enroll: (id, snapshot) => createEnrollmentCode(env, id, input.selection, {
      configuredMode: snapshot.configuredMode,
      lifecycleId: snapshot.lifecycleId
    }, input.ttlMs, input.window)
  }, runnerId, initial);
}
export function revokeRunnerFromControlPlane(env: WorkerEnv, runnerId: string) {
  return revokeRunner({
    ...actionPorts(env, "credential-revoked-"),
    revoke: async (id, mutation) => runnerWriteOutcome(await runnerRegistryRequest(env, id, "/revoke", "POST", JSON.stringify({
      confirmation: id,
      mutation_id: mutation
    })))
  }, runnerId);
}
export function browserRunnerAdministrationError(action: "create" | "rotate" | "revoke", failure: RunnerActionFailure): Response {
  const missing = failure.cause === "missing";
  const fail = action === "revoke" ? adminRunnerError : adminError;
  if (failure.reason === "write") return fail(action === "create" ? failure.cause === "unknown" ? 503 : failure.cause === "conflict" ? 409 : 400 : missing ? 404 : 400, action === "create" ? "Runner could not be added." : action === "rotate" ? "Runner credential rotation failed." : "Runner revoke failed.");
  if (failure.reason === "changed" || failure.reason === "enrollment_rejected") return fail(missing ? 404 : 409, missing ? action === "create" ? "Runner enrollment target was not found." : "Runner was not found." : "Runner state changed; reload the Runner page and retry.");
  const messages: Record<typeof action, Partial<Record<RunnerActionFailure["reason"], string>>> = {
    create: {
      read: "Runner creation could not read the Runner state.",
      fence: "Runner creation could not fence the Runner.",
      commit: "Runner creation outcome is uncertain; Runner remains safely fenced.",
      enrollment_state: "Runner enrollment state is uncertain; Runner remains safely fenced.",
      enrollment: "Runner enrollment code could not be created; Runner remains safely fenced.",
      enrollment_recovery: "Runner enrollment code state is uncertain; Runner remains safely fenced.",
      finalize: "Runner creation cleanup is uncertain; Runner remains safely fenced."
    },
    rotate: {
      fence: "Runner credential rotation could not fence the Runner.",
      commit: "Runner credential rotation outcome is uncertain; Runner remains safely fenced.",
      cancel: "Runner credential rotation failed; Runner remains safely fenced.",
      recovery: "Runner credential rotation state is uncertain; Runner remains safely fenced.",
      enrollment: "Enrollment code could not be generated; Runner remains safely fenced.",
      enrollment_recovery: "Enrollment code state is uncertain; Runner remains safely fenced.",
      finalize: "Runner credential cleanup is uncertain; Runner remains safely fenced."
    },
    revoke: {
      fence: "Runner revocation could not fence the Runner.",
      commit: "Runner revocation outcome is uncertain; Runner remains safely fenced.",
      cancel: "Runner revocation failed; Runner remains safely fenced.",
      recovery: "Runner revocation state is uncertain; Runner remains safely fenced.",
      finalize: "Runner revocation cleanup is uncertain; Runner remains safely fenced."
    }
  };
  return fail(503, messages[action][failure.reason] ?? "Runner mutation outcome is uncertain; Runner remains safely fenced.");
}
