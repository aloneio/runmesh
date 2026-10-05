import { DEFAULT_RUNNER_ENROLLMENT_TTL_MS } from "../contracts/enrollment-options.js";
import type { EnrollmentCodeResult } from "../contracts/runner-admin.js";
import type { EnrollmentWindow } from "../contracts/runner-admin.js";
import type { ExecutionModeSelection } from "../contracts/runner-admin.js";
import { record } from "../values.js";
import type { RunnerExecutionExpectation } from "../contracts/runner-admin.js";
import { validTimestamp } from "../validity.js";
import type { EnrollmentPorts } from "../contracts/control-plane-receipts.js";

export async function createEnrollmentCode(ports: EnrollmentPorts, runnerId: string, selection?: ExecutionModeSelection, expected?: RunnerExecutionExpectation, enrollmentTtlMs = DEFAULT_RUNNER_ENROLLMENT_TTL_MS, enrollmentWindow: EnrollmentWindow = {}, mutationId?: string): Promise<EnrollmentCodeResult> {
  const code = ports.randomCode(), enrollmentId = ports.randomCode();
  const payload = {
    enrollment_id: enrollmentId, verifier: await ports.digest(code),
    enrollment_ttl_ms: enrollmentTtlMs, ...enrollmentWindow,
    ...(selection === undefined ? {} : { execution_mode: selection.mode, confirm_privileged_host: selection.confirmed }),
    ...(expected === undefined ? {} : { expected_execution_mode: expected.configuredMode, expected_lifecycle_id: expected.lifecycleId }),
    ...(mutationId === undefined ? {} : { mutation_id: mutationId }),
  };
  const response = await ports.create(runnerId, payload);
  if (response?.status !== 200) return { ok: false, status: response?.status ?? 503, deterministic: response !== undefined && [400, 403, 404, 409].includes(response.status) };
  try {
    const value = record(response.value);
    if (value?.runner_id !== runnerId || value.enrollment_id !== enrollmentId
      || typeof value.created_at_ms !== "number" || typeof value.not_before_ms !== "number" || typeof value.expires_at_ms !== "number"
      || !validTimestamp(value.created_at_ms) || !validTimestamp(value.not_before_ms) || !validTimestamp(value.expires_at_ms)
      || value.created_at_ms > value.expires_at_ms || value.not_before_ms >= value.expires_at_ms) throw new Error("invalid enrollment response");
    return { ok: true, code, created_at_ms: value.created_at_ms, not_before_ms: value.not_before_ms, expires_at_ms: value.expires_at_ms };
  } catch { return { ok: false, status: 502, deterministic: false }; }
}
