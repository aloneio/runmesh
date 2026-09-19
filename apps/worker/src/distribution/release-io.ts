import { PROTOCOL_CURRENT_VERSION, PROTOCOL_MIN_VERSION } from "@aloneio/runmesh-protocol";
import { FIXED_RELEASE_ALLOWED_REDIRECT_ORIGINS, FIXED_RELEASE_KEY_ID, FIXED_RELEASE_PUBLIC_KEY_PEM, MAX_RELEASE_ASSET_BYTES, installerReleaseTarget } from "../domain/release-config.js";
import { isRecord, isCurrentDevelopmentVersion, validatedCachedDevelopmentRelease } from "../domain/release-selection.js";
import { releaseManifestProblem } from "../domain/release-manifest.js";
import type { RunnerReleaseDescriptor, DevelopmentReleaseCache, CachedDevelopmentReleaseRecord } from "../contracts/runner-release.js";

export const DEV_RELEASE_DISCOVERY_URL = "https://api.github.com/repos/aloneio/runmesh/releases?per_page=20";
const DEV_RELEASE_CACHE_KEY = new Request("https://runmeshdev.aloneiodev.workers.dev/__internal/verified-dev-runner-release-v1");
const DEV_RELEASE_FETCH_ATTEMPTS = 3;
const DEV_RELEASE_RETRY_DELAY_MS = 75;
const MAX_DISCOVERY_BYTES = 512 * 1024;
const ALLOWED_RELEASE_ORIGINS = new Set<string>(FIXED_RELEASE_ALLOWED_REDIRECT_ORIGINS);

export function defaultDevelopmentReleaseCache(): DevelopmentReleaseCache | undefined {
  try {
    if (typeof caches === "undefined") return undefined;
    return (caches as unknown as { readonly default?: DevelopmentReleaseCache }).default;
  } catch { return undefined; }
}
export async function readDevelopmentReleaseCache(cache: DevelopmentReleaseCache | undefined): Promise<CachedDevelopmentReleaseRecord | undefined> {
  if (cache === undefined) return undefined;
  try { const response = await cache.match(DEV_RELEASE_CACHE_KEY); return response === undefined || !response.ok ? undefined : validatedCachedDevelopmentRelease(await boundedJson(response)); } catch { return undefined; }
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
export async function releaseFetch(input: string, init: Omit<RequestInit, "signal">, fetchImpl: typeof fetch): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < DEV_RELEASE_FETCH_ATTEMPTS; attempt++) {
    try {
      const response = await fetchImpl(input, { ...init, signal: AbortSignal.timeout(10_000) });
      if (!retryableReleaseResponse(response) || attempt + 1 === DEV_RELEASE_FETCH_ATTEMPTS) return response;
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      lastError = error;
      if (attempt + 1 === DEV_RELEASE_FETCH_ATTEMPTS) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, DEV_RELEASE_RETRY_DELAY_MS * (attempt + 1)));
  }
  throw lastError instanceof Error ? lastError : new Error("development release fetch failed");
}

export async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error("development release discovery failed");
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_DISCOVERY_BYTES)) throw new Error("development release discovery response is too large");
  if (response.body === null) throw new Error("development release discovery response is empty");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (let index = 0; ; index++) {
      if (index >= 1024) throw new Error("development release discovery response is fragmented");
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength; if (bytes > MAX_DISCOVERY_BYTES) throw new Error("development release discovery response is too large"); chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const body = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
}

async function boundedReleaseBytes(url: string, limit: number, fetchImpl: typeof fetch): Promise<Uint8Array> {
  let current = new URL(url);
  for (let redirect = 0; redirect <= 4; redirect++) {
    if (current.protocol !== "https:" || !ALLOWED_RELEASE_ORIGINS.has(current.origin)) throw new Error("development release redirect origin is not trusted");
    const response = await releaseFetch(current.toString(), { method: "GET", redirect: "manual", cache: "no-store", credentials: "omit", headers: { accept: "application/octet-stream", "user-agent": "runmeshdev-release-verifier/1" } }, fetchImpl);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location"); await response.body?.cancel().catch(() => undefined);
      if (location === null || redirect === 4) throw new Error("development release redirect is invalid");
      current = new URL(location, current); continue;
    }
    if (!response.ok || response.body === null) { await response.body?.cancel().catch(() => undefined); throw new Error("development release asset is unavailable"); }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > limit)) { await response.body.cancel().catch(() => undefined); throw new Error("development release asset exceeds its size bound"); }
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (let index = 0; ; index++) {
        if (index >= 256) throw new Error("development release asset is fragmented");
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength; if (bytes > limit) throw new Error("development release asset exceeds its size bound"); chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    if (bytes === 0) throw new Error("development release asset is empty");
    const result = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  }
  throw new Error("development release redirect limit exceeded");
}

function canonicalBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw new Error("invalid base64");
  const binary = atob(value); if (btoa(binary) !== value) throw new Error("non-canonical base64");
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}
function publicKeySpki(pem: string): Uint8Array {
  const match = /^-----BEGIN PUBLIC KEY-----\n([A-Za-z0-9+/=]+)\n-----END PUBLIC KEY-----\n?$/u.exec(pem);
  if (match?.[1] === undefined) throw new Error("invalid Ed25519 public key");
  return canonicalBase64(match[1]);
}
function parseJsonBytes(bytes: Uint8Array): unknown { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
function ownedBuffer(bytes: Uint8Array): ArrayBuffer { const copy = new Uint8Array(bytes.byteLength); copy.set(bytes); return copy.buffer; }

export interface DevelopmentReleaseTrust { readonly key_id: string; readonly public_key_pem: string; }
const FIXED_DEVELOPMENT_TRUST: DevelopmentReleaseTrust = { key_id: FIXED_RELEASE_KEY_ID, public_key_pem: FIXED_RELEASE_PUBLIC_KEY_PEM };

export async function verifyDevelopmentRunnerRelease(descriptor: RunnerReleaseDescriptor, fetchImpl: typeof fetch = fetch, trust: DevelopmentReleaseTrust = FIXED_DEVELOPMENT_TRUST): Promise<void> {
  if (descriptor.channel !== "dev" || !descriptor.distributable || !isCurrentDevelopmentVersion(descriptor.package_version)) throw new Error("development release descriptor is invalid");
  const target = installerReleaseTarget(descriptor.package_version, "dev");
  // Fetch sequentially: three concurrent unauthenticated GitHub asset requests
  // multiplied transient edge failures and made a valid dev release intermittently
  // unavailable. Each fixed-origin GET has its own bounded retry budget.
  const manifestBytes = await boundedReleaseBytes(target.manifest_url, 64 * 1024, fetchImpl);
  const signatureBytes = await boundedReleaseBytes(target.signature_url, 1024, fetchImpl);
  const signatureDescriptorBytes = await boundedReleaseBytes(target.signature_descriptor_url, 16 * 1024, fetchImpl);
  const signatureDescriptor = parseJsonBytes(signatureDescriptorBytes);
  if (!isRecord(signatureDescriptor) || signatureDescriptor.schema_version !== 1 || signatureDescriptor.algorithm !== "ed25519" || signatureDescriptor.key_id !== trust.key_id || signatureDescriptor.encoding !== "base64" || signatureDescriptor.signed_file !== "manifest.json") throw new Error("development release signature descriptor is invalid");
  const signature = canonicalBase64(new TextDecoder("utf-8", { fatal: true }).decode(signatureBytes).trim());
  if (signature.byteLength !== 64) throw new Error("development release signature length is invalid");
  const key = await crypto.subtle.importKey("spki", ownedBuffer(publicKeySpki(trust.public_key_pem)), { name: "Ed25519" }, false, ["verify"]);
  if (!await crypto.subtle.verify({ name: "Ed25519" }, key, ownedBuffer(signature), ownedBuffer(manifestBytes))) throw new Error("development release signature does not verify");
  const manifest = parseJsonBytes(manifestBytes);
  const problem = releaseManifestProblem(manifest, { version: target.version, channel: target.channel,
    artifact_name: target.artifact_name, artifact_url: target.artifact_url,
    protocol_min: PROTOCOL_MIN_VERSION, protocol_max: PROTOCOL_CURRENT_VERSION, max_asset_bytes: MAX_RELEASE_ASSET_BYTES });
  if (problem !== undefined) throw new Error(problem === "manifest" ? "development release manifest is invalid" : "development release manifest artifact is invalid");
}
