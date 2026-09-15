import { internalHeaders } from "../security.js";
import { isConfiguredSecret } from "../security.js";
import type { WorkerEnv } from "./env.js";

export async function consumeInternalNonce(env: WorkerEnv, nonce: string, expiresAtMs: number): Promise<boolean> {
  const body = JSON.stringify({ nonce, expires_at_ms: expiresAtMs });
  const headers = await signedInternalHeaders(env, "POST", "/auth/internal-nonces", body);
  if (headers === undefined) return false;
  try {
    const response = await env.REGISTRY.get(env.REGISTRY.idFromName("registry")).fetch(
      new Request("https://registry.internal/auth/internal-nonces", { method: "POST", headers, body }),
    );
    return response.status === 204;
  } catch { return false; }
}

export async function signedInternalHeaders(env: WorkerEnv, method: string, path: string, body: string): Promise<HeadersInit | undefined> {
  if (!isConfiguredSecret(env.INTERNAL_CONTROL_SECRET)) return undefined;
  try { return await internalHeaders(env.INTERNAL_CONTROL_SECRET, method, path, body); } catch { return undefined; }
}

export function controlPlaneUnavailable(): Response {
  return new Response("control plane is not configured", { status: 503, headers: { "cache-control": "no-store" } });
}

export async function registryRequest(env: WorkerEnv, path: string, method: string, body: string, signal?: AbortSignal): Promise<Response> {
  const headers = await signedInternalHeaders(env, method, path, body);
  if (headers === undefined) return controlPlaneUnavailable();
  try {
    const init: RequestInit = { method, headers, ...(signal === undefined ? {} : { signal }), ...(body.length === 0 || method === "GET" || method === "HEAD" ? {} : { body }) };
    return await env.REGISTRY.get(env.REGISTRY.idFromName("registry")).fetch(new Request(`https://registry.internal${path}`, init));
  } catch { return new Response("registry unavailable", { status: 503 }); }
}

export async function runnerRpc(env: WorkerEnv, runnerId: string, method: string, params: Record<string, unknown>, policyRevision?: number, policyChecksum?: string): Promise<Response> {
  const body = JSON.stringify({ method, params, ...(policyRevision === undefined || policyChecksum === undefined ? {} : { policy_revision: policyRevision, expected_policy_revision: policyRevision, expected_policy_checksum: policyChecksum }) });
  const headers = await signedInternalHeaders(env, "POST", "/rpc", body);
  if (headers === undefined) return controlPlaneUnavailable();
  try { return await env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/rpc", { method: "POST", headers, body })); }
  catch { return new Response("runner unavailable", { status: 503 }); }
}

export async function runnerRegistryRequest(env: WorkerEnv, runnerId: string, action: string, method: string, body: string): Promise<Response> {
  const path = `/runners/${encodeURIComponent(runnerId)}${action}`;
  return registryRequest(env, path, method, body);
}

export async function registryGet(env: WorkerEnv, path: string): Promise<Response> { return registryRequest(env, path, "GET", ""); }

export async function registryPost(env: WorkerEnv, path: string, payload: Record<string, unknown>): Promise<Response> { return registryRequest(env, path, "POST", JSON.stringify(payload)); }

export async function json(response: Response): Promise<unknown> { try { return await response.json(); } catch { return undefined; } }
