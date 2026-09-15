import { DEFAULT_RUNNER_ENROLLMENT_TTL_MS } from "../contracts/enrollment-options.js";
import type { EnrollmentCodeResult } from "../contracts/runner-admin.js";
import type { EnrollmentWindow } from "../contracts/runner-admin.js";
import type { ExecutionModeSelection } from "../contracts/runner-admin.js";
import { json } from "../platform/control-plane.js";
import { randomBase64Url } from "../security.js";
import { record } from "../values.js";
import type { RunnerExecutionExpectation } from "../contracts/runner-admin.js";
import { runnerRegistryRequest } from "../platform/control-plane.js";
import { sha256Hex } from "../security.js";
import { validTimestamp } from "../validity.js";
import type { WorkerEnv } from "../platform/env.js";

export async function createEnrollmentCode(env: WorkerEnv, runnerId: string, selection?: ExecutionModeSelection, expected?: RunnerExecutionExpectation, enrollmentTtlMs = DEFAULT_RUNNER_ENROLLMENT_TTL_MS, window: EnrollmentWindow = {}): Promise<EnrollmentCodeResult> {
  const code = randomBase64Url();
  const response = await runnerRegistryRequest(env, runnerId, "/enrollments", "POST", JSON.stringify({
    enrollment_id: randomBase64Url(), verifier: await sha256Hex(code),
    enrollment_ttl_ms: enrollmentTtlMs, ...window,
    ...(selection === undefined ? {} : { execution_mode: selection.mode, confirm_privileged_host: selection.confirmed }),
    ...(expected === undefined ? {} : { expected_execution_mode: expected.configuredMode, expected_lifecycle_id: expected.lifecycleId }),
  }));
  if (!response.ok) return { ok: false, status: response.status, deterministic: [400, 404, 409].includes(response.status) };
  try {
    const value = record(await json(response));
    if (typeof value?.created_at_ms !== "number" || typeof value.not_before_ms !== "number" || typeof value.expires_at_ms !== "number" || !validTimestamp(value.created_at_ms) || !validTimestamp(value.not_before_ms) || !validTimestamp(value.expires_at_ms)) throw new Error("invalid enrollment response");
    return { ok: true, code, created_at_ms: value.created_at_ms, not_before_ms: value.not_before_ms, expires_at_ms: value.expires_at_ms };
  } catch { return { ok: false, status: 502, deterministic: false }; }
}
