import type { AuthThrottleKind, AuthThrottlePorts } from "../contracts/control-plane-receipts.js";
import { record } from "../values.js";

type PreAuthThrottle = { readonly allowed: boolean; readonly retry_after_ms: number };

export async function authThrottleCheck(ports: AuthThrottlePorts, kind: AuthThrottleKind): Promise<PreAuthThrottle | undefined> {
  const response = await ports.check(kind);
  const body = response?.status === 200 ? record(response.value) : undefined;
  return body !== undefined && typeof body.allowed === "boolean" && typeof body.retry_after_ms === "number" && Number.isSafeInteger(body.retry_after_ms) && body.retry_after_ms >= 0
    ? { allowed: body.allowed, retry_after_ms: body.retry_after_ms }
    : undefined;
}

export async function authThrottleRecord(ports: AuthThrottlePorts, kind: AuthThrottleKind, success: boolean): Promise<void> {
  try { await ports.record(kind, success); }
  catch { /* Authentication result remains authoritative. */ }
}
