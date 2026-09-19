import { hmacHex } from "../security.js";
import { isConfiguredSecret } from "../security.js";
import { boundedJsonResponse } from "../platform/bounded-json.js";
import { record } from "../values.js";
import { registryRequest } from "../platform/control-plane.js";
import type { WorkerEnv } from "../platform/env.js";

type PreAuthThrottle = { readonly allowed: boolean; readonly retry_after_ms: number };

async function authSourceHash(env: WorkerEnv, request: Request): Promise<string> {
  // Trust only Cloudflare's edge-populated address, never X-Forwarded-For.
  // Non-edge/local requests share a conservative unattributed source bucket.
  const address = request.headers.get("cf-connecting-ip");
  const source = address !== null && /^[0-9a-f:.]{3,64}$/iu.test(address) ? address.toLowerCase() : "unattributed";
  if (!isConfiguredSecret(env.INTERNAL_CONTROL_SECRET)) throw new Error("internal control is not configured");
  return hmacHex(env.INTERNAL_CONTROL_SECRET, `runmesh-auth-source:v1:${source}`);
}

export async function authThrottleCheck(env: WorkerEnv, kind: "login" | "setup", request: Request): Promise<PreAuthThrottle | undefined> {
  const payload = JSON.stringify({ kind, source_hash: await authSourceHash(env, request) });
  const response = await boundedJsonResponse(signal => registryRequest(env, "/auth/throttle/check", "POST", payload, signal));
  const body = response?.status === 200 ? record(response.value) : undefined;
  return body !== undefined && typeof body.allowed === "boolean" && typeof body.retry_after_ms === "number" && Number.isSafeInteger(body.retry_after_ms) && body.retry_after_ms >= 0
    ? { allowed: body.allowed, retry_after_ms: body.retry_after_ms }
    : undefined;
}

export async function authThrottleRecord(env: WorkerEnv, kind: "login" | "setup", success: boolean, request: Request): Promise<void> {
  // The request includes only outcome metadata; passwords/verifiers never enter logs.
  try {
    const payload = JSON.stringify({ kind, source_hash: await authSourceHash(env, request), success });
    await boundedJsonResponse(signal => registryRequest(env, "/auth/throttle/record", "POST", payload, signal));
  } catch { /* authentication result remains authoritative */ }
}
