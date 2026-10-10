import { PROTOCOL_CURRENT_VERSION, PROTOCOL_MIN_VERSION, verifyRunnerReleaseSignature } from "@aloneio/runmesh-protocol";
import { FIXED_RELEASE_ALLOWED_REDIRECT_ORIGINS, FIXED_RELEASE_KEY_ID, FIXED_RELEASE_PUBLIC_KEY_PEM, MAX_RELEASE_ASSET_BYTES, installerReleaseTarget } from "../domain/release-config.js";
import { isRecord, isDevelopmentReleaseVersion, validatedCachedDevelopmentRelease } from "../domain/release-selection.js";
import { releaseManifestProblem } from "../domain/release-manifest.js";
import type { RunnerReleaseDescriptor, DevelopmentReleaseCache, CachedDevelopmentReleaseRecord, DevelopmentReleaseFailure } from "../contracts/runner-release.js";
import { boundedJsonResponse } from "../bounded-json.js";

export const DEV_RELEASE_DISCOVERY_URL = "https://api.github.com/repos/aloneio/runmesh/releases?per_page=20";
const DEV_RELEASE_CACHE_KEY = new Request("https://runmeshdev.aloneiodev.workers.dev/__internal/verified-dev-runner-release-v1");
const DEV_RELEASE_FETCH_ATTEMPTS = 3;
const DEV_RELEASE_RETRY_DELAY_MS = 75;
const MAX_RELEASE_RETRY_WINDOW_MS = 60 * 60_000;
const MAX_DISCOVERY_BYTES = 512 * 1024;
const ALLOWED_RELEASE_ORIGINS = new Set<string>(FIXED_RELEASE_ALLOWED_REDIRECT_ORIGINS);

/** Errors carry fixed diagnostics separately from messages retained for callers. */
export class DevelopmentReleaseError extends Error {
  constructor(message: string, readonly failure: DevelopmentReleaseFailure, readonly retry_at_ms?: number) { super(message); }
}
export function safeDevelopmentReleaseFailure(value: unknown): DevelopmentReleaseFailure {
  if (!isRecord(value) || typeof value.phase !== "string" || !["discovery", "manifest", "signature", "signature_descriptor", "verification"].includes(value.phase)
    || typeof value.reason !== "string" || !["http_error", "network_error", "timeout", "invalid_response", "invalid_signature", "invalid_manifest", "no_candidate", "unexpected"].includes(value.reason)) {
    return { phase: "discovery", reason: "unexpected" };
  }
  const failure: DevelopmentReleaseFailure = { phase: value.phase as DevelopmentReleaseFailure["phase"], reason: value.reason as DevelopmentReleaseFailure["reason"],
    ...(Number.isInteger(value.http_status) && Number(value.http_status) >= 100 && Number(value.http_status) <= 599 ? { http_status: Number(value.http_status) } : {}) };
  if (value.recovery === "reverified") return { ...failure, recovery: "reverified" };
  if (value.recovery === "failed") {
    // Project the recovery through the same fixed vocabulary; never forward
    // exception messages, URLs, or arbitrary fields from either failure.
    const recovery = safeDevelopmentReleaseFailure({ phase: value.recovery_phase, reason: value.recovery_reason, http_status: value.recovery_http_status });
    return { ...failure, recovery: "failed", recovery_phase: recovery.phase, recovery_reason: recovery.reason,
      ...(recovery.http_status === undefined ? {} : { recovery_http_status: recovery.http_status }) };
  }
  return failure;
}
export function developmentReleaseFailure(error: unknown, phase: DevelopmentReleaseFailure["phase"] = "discovery"): DevelopmentReleaseFailure {
  return error instanceof DevelopmentReleaseError ? safeDevelopmentReleaseFailure(error.failure) : { phase, reason: "unexpected" };
}
function releaseError(error: unknown, phase: DevelopmentReleaseFailure["phase"], reason: DevelopmentReleaseFailure["reason"]): DevelopmentReleaseError {
  return error instanceof DevelopmentReleaseError ? error : new DevelopmentReleaseError(error instanceof Error ? error.message : "development release failed", { phase, reason });
}
export async function releasePhase<T>(phase: DevelopmentReleaseFailure["phase"], reason: DevelopmentReleaseFailure["reason"], work: () => T | Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) { throw releaseError(error, phase, error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name) ? "timeout" : reason); }
}

/** Every redirect, retry and asset retains the request owner's original budget. */
export function releaseFetchWithinDeadline(fetchImpl: typeof fetch, deadline: AbortSignal): typeof fetch {
  return (input, init) => {
    deadline.throwIfAborted();
    const signal = init?.signal == null ? deadline : AbortSignal.any([deadline, init.signal]);
    return fetchImpl(input, { ...init, signal });
  };
}

export async function readDevelopmentReleaseCache(cache: DevelopmentReleaseCache | undefined, timeoutMs?: number): Promise<CachedDevelopmentReleaseRecord | undefined> {
  if (cache === undefined) return undefined;
  if (timeoutMs !== undefined) {
    const receipt = await boundedJsonResponse(async signal => await cache.match(new Request(DEV_RELEASE_CACHE_KEY, { signal })) ?? new Response(null, { status: 404 }), timeoutMs, MAX_DISCOVERY_BYTES);
    return validatedCachedDevelopmentRelease(receipt?.value);
  }
  try { const response = await cache.match(DEV_RELEASE_CACHE_KEY); return response === undefined ? undefined : validatedCachedDevelopmentRelease(await boundedJson(response)); } catch { return undefined; }
}
export async function writeDevelopmentReleaseCache(cache: DevelopmentReleaseCache | undefined, descriptor: RunnerReleaseDescriptor, verifiedAtMs: number): Promise<void> {
  if (cache === undefined) return;
  const body: CachedDevelopmentReleaseRecord = { schema_version: 1, verified_at_ms: verifiedAtMs, descriptor };
  try { await cache.put(DEV_RELEASE_CACHE_KEY, new Response(JSON.stringify(body), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=3600" } })); } catch { /* Cache availability must not affect signed release correctness. */ }
}

function retryableReleaseResponse(response: Response): boolean {
  if (response.status === 403 || response.status === 429 || response.status >= 500) return true;
  return false;
}
/** Request-local backpressure only; it never changes verified release lifetime. */
function releaseRetryAtMs(response: Response, now = Date.now()): number | undefined {
  const retry = response.headers.get("retry-after")?.trim();
  let retryAt: number | undefined;
  if (retry !== undefined && /^\d+$/u.test(retry)) {
    const seconds = Number(retry);
    if (Number.isSafeInteger(seconds)) retryAt = now + Math.min(MAX_RELEASE_RETRY_WINDOW_MS, seconds * 1000);
  } else if (retry !== undefined) {
    const parsed = Date.parse(retry);
    if (Number.isFinite(parsed) && new Date(parsed).toUTCString() === retry) retryAt = Math.max(now, parsed);
  }
  if (response.status === 403 && response.headers.get("x-ratelimit-remaining")?.trim() === "0") {
    const reset = response.headers.get("x-ratelimit-reset")?.trim(), seconds = reset !== undefined && /^\d+$/u.test(reset) ? Number(reset) : NaN;
    const resetAt = Number.isSafeInteger(seconds) && Number.isSafeInteger(seconds * 1000) ? Math.max(now, seconds * 1000) : now + 60_000;
    retryAt = Math.max(retryAt ?? now, resetAt);
  }
  return retryAt === undefined ? undefined : Math.min(now + MAX_RELEASE_RETRY_WINDOW_MS, retryAt);
}
export async function releaseFetch(input: string, init: Omit<RequestInit, "signal">, fetchImpl: typeof fetch, phase: DevelopmentReleaseFailure["phase"] = "discovery"): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < DEV_RELEASE_FETCH_ATTEMPTS; attempt++) {
    try {
      const response = await fetchImpl(input, { ...init, signal: AbortSignal.timeout(10_000) });
      if (!retryableReleaseResponse(response) || releaseRetryAtMs(response) !== undefined || attempt + 1 === DEV_RELEASE_FETCH_ATTEMPTS) return response;
      // Start disposal without letting a peer's cleanup promise own the retry budget.
      void response.body?.cancel().catch(() => undefined);
    } catch (error) {
      lastError = error;
      if (attempt + 1 === DEV_RELEASE_FETCH_ATTEMPTS) throw releaseError(error, phase, error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name) ? "timeout" : "network_error");
    }
    await new Promise(resolve => setTimeout(resolve, DEV_RELEASE_RETRY_DELAY_MS * (attempt + 1)));
  }
  throw lastError instanceof Error ? lastError : new Error("development release fetch failed");
}

/** Own the response body even when status or headers reject it before reading. */
export async function boundedJson(response: Response): Promise<unknown> {
  return releasePhase("discovery", "invalid_response", async () => {
    if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new DevelopmentReleaseError("development release discovery failed", { phase: "discovery", reason: "http_error", http_status: response.status }, releaseRetryAtMs(response)); }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_DISCOVERY_BYTES)) { void response.body?.cancel().catch(() => undefined); throw new Error("development release discovery response is too large"); }
    if (response.body === null) throw new Error("development release discovery response is empty");
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (let index = 0; ; index++) {
        if (index >= 1024) throw new Error("development release discovery response is fragmented");
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength; if (bytes > MAX_DISCOVERY_BYTES) throw new Error("development release discovery response is too large"); chunks.push(part.value);
      }
    } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const body = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  });
}

export async function boundedReleaseBytes(url: string, limit: number, fetchImpl: typeof fetch, phase: DevelopmentReleaseFailure["phase"]): Promise<Uint8Array> {
  let current = new URL(url);
  for (let redirect = 0; redirect <= 4; redirect++) {
    if (current.protocol !== "https:" || !ALLOWED_RELEASE_ORIGINS.has(current.origin)) throw new Error("development release redirect origin is not trusted");
    const response = await releaseFetch(current.toString(), { method: "GET", redirect: "manual", cache: "no-store", credentials: "omit", headers: { accept: "application/octet-stream", "user-agent": "runmeshdev-release-verifier/1" } }, fetchImpl, phase);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location"); void response.body?.cancel().catch(() => undefined);
      if (location === null || redirect === 4) throw new Error("development release redirect is invalid");
      current = new URL(location, current); continue;
    }
    if (!response.ok || response.body === null) { void response.body?.cancel().catch(() => undefined); throw new DevelopmentReleaseError("development release asset is unavailable", { phase, reason: response.ok ? "invalid_response" : "http_error", ...(!response.ok ? { http_status: response.status } : {}) }, response.ok ? undefined : releaseRetryAtMs(response)); }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > limit)) { void response.body.cancel().catch(() => undefined); throw new Error("development release asset exceeds its size bound"); }
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (let index = 0; ; index++) {
        if (index >= 256) throw new Error("development release asset is fragmented");
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength; if (bytes > limit) throw new Error("development release asset exceeds its size bound"); chunks.push(part.value);
      }
    } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
    if (bytes === 0) throw new Error("development release asset is empty");
    const result = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  }
  throw new Error("development release redirect limit exceeded");
}

function parseJsonBytes(bytes: Uint8Array): unknown { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }

export interface DevelopmentReleaseTrust { readonly key_id: string; readonly public_key_pem: string; }
const FIXED_DEVELOPMENT_TRUST: DevelopmentReleaseTrust = { key_id: FIXED_RELEASE_KEY_ID, public_key_pem: FIXED_RELEASE_PUBLIC_KEY_PEM };

export async function verifyDevelopmentRunnerRelease(descriptor: RunnerReleaseDescriptor, fetchImpl: typeof fetch = fetch, trust: DevelopmentReleaseTrust = FIXED_DEVELOPMENT_TRUST): Promise<void> {
  if (descriptor.channel !== "dev" || !descriptor.distributable || !isDevelopmentReleaseVersion(descriptor.package_version)) throw new DevelopmentReleaseError("development release descriptor is invalid", { phase: "verification", reason: "invalid_manifest" });
  const target = installerReleaseTarget(descriptor.package_version, "dev");
  // Fetch sequentially: three concurrent unauthenticated GitHub asset requests
  // multiplied transient edge failures and made a valid dev release intermittently
  // unavailable. Each fixed-origin GET has its own bounded retry budget.
  const manifestBytes = await releasePhase("manifest", "invalid_response", () => boundedReleaseBytes(target.manifest_url, 64 * 1024, fetchImpl, "manifest"));
  const signatureBytes = await releasePhase("signature", "invalid_response", () => boundedReleaseBytes(target.signature_url, 1024, fetchImpl, "signature"));
  const signatureDescriptorBytes = await releasePhase("signature_descriptor", "invalid_response", () => boundedReleaseBytes(target.signature_descriptor_url, 16 * 1024, fetchImpl, "signature_descriptor"));
  const signatureDescriptor = await releasePhase("signature_descriptor", "invalid_response", () => parseJsonBytes(signatureDescriptorBytes));
  if (!isRecord(signatureDescriptor) || signatureDescriptor.schema_version !== 1 || signatureDescriptor.algorithm !== "ed25519" || signatureDescriptor.key_id !== trust.key_id || signatureDescriptor.encoding !== "base64" || signatureDescriptor.signed_file !== "manifest.json") throw new DevelopmentReleaseError("development release signature descriptor is invalid", { phase: "signature_descriptor", reason: "invalid_signature" });
  const manifest = await releasePhase("verification", "invalid_signature", () => verifyRunnerReleaseSignature(manifestBytes, signatureBytes, signatureDescriptorBytes, trust));
  const problem = releaseManifestProblem(manifest, { version: target.version, channel: target.channel,
    artifact_name: target.artifact_name, artifact_url: target.artifact_url,
    protocol_min: PROTOCOL_MIN_VERSION, protocol_max: PROTOCOL_CURRENT_VERSION, max_asset_bytes: MAX_RELEASE_ASSET_BYTES });
  if (problem !== undefined) throw new DevelopmentReleaseError(problem === "manifest" ? "development release manifest is invalid" : "development release manifest artifact is invalid", { phase: "verification", reason: "invalid_manifest" });
}
