import { canonicalPublicOrigin, fixedReleaseDescriptor, installerReleaseTarget, signedReleaseIsAvailable } from "../installer.js";
import { FIXED_RELEASE_ALLOWED_REDIRECT_ORIGINS, FIXED_RELEASE_KEY_ID, FIXED_RELEASE_PUBLIC_KEY_PEM, FIXED_RELEASE_VERSION, MAX_RELEASE_ASSET_BYTES } from "../installer.js";
import type { FixedReleaseDescriptor } from "../installer.js";
import { PROTOCOL_CURRENT_VERSION, PROTOCOL_MIN_VERSION } from "@aloneio/runmesh-protocol";

export type RunnerReleaseDescriptor = Omit<FixedReleaseDescriptor, "published_at"> & {
  readonly published_at: string | null;
  readonly protocol: { readonly min_version: number; readonly max_version: number };
};
export interface ReleaseGateDiagnostics {
  readonly acknowledgement_matches_fixed_release: boolean;
  readonly canonical_public_origin_configured: boolean;
  readonly test_mode_disabled: boolean;
}
export interface RunnerReleaseEnvironment {
  readonly RUNMESH_SIGNED_RELEASE_AVAILABLE?: string;
  readonly RUNMESH_ENVIRONMENT?: string;
  readonly WORKER_ID?: string;
  readonly RUNMESH_PUBLIC_ORIGIN?: string;
  readonly RUNMESH_TEST_MODE?: string;
}

const DEV_RELEASE_DISCOVERY_URL = "https://api.github.com/repos/aloneio/runmesh/releases?per_page=20";
const DEV_RELEASE_CACHE_MS = 60_000;
const DEV_RELEASE_STALE_MS = 60 * 60_000;
const DEV_RELEASE_REFRESH_BUDGET_MS = 20_000;
const DEV_RELEASE_CACHE_KEY = new Request("https://runmeshdev.aloneiodev.workers.dev/__internal/verified-dev-runner-release-v1");
const DEV_RELEASE_FETCH_ATTEMPTS = 3;
const DEV_RELEASE_RETRY_DELAY_MS = 75;
const MAX_DISCOVERY_BYTES = 512 * 1024;
const DEV_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-dev\.(0|[1-9]\d*)$/u;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const ALLOWED_RELEASE_ORIGINS = new Set<string>(FIXED_RELEASE_ALLOWED_REDIRECT_ORIGINS);
const REQUIRED_STATIC_ASSETS = ["LICENSE", "NOTICE", "SHA256SUMS", "THIRD_PARTY_NOTICES.md", "manifest.json", "manifest.sig", "manifest.signature.json", "trust-keyring.json"] as const;
let cachedDevRelease: { readonly expires_at_ms: number; readonly verified_at_ms: number; readonly descriptor: RunnerReleaseDescriptor } | undefined;
let nextRuntimeRefreshAtMs = 0;

export interface DevelopmentReleaseCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}
interface CachedDevelopmentReleaseRecord {
  readonly schema_version: 1;
  readonly verified_at_ms: number;
  readonly descriptor: RunnerReleaseDescriptor;
}

function protocol() { return { min_version: PROTOCOL_MIN_VERSION, max_version: PROTOCOL_CURRENT_VERSION } as const; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function validTimestamp(value: unknown): value is string { return typeof value === "string" && UTC_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().replace(".000Z", "Z") === value; }
function isDevelopment(env: RunnerReleaseEnvironment): boolean {
  return env.RUNMESH_ENVIRONMENT === "development" || (env.RUNMESH_ENVIRONMENT === undefined && env.WORKER_ID === "worker-development");
}
function isCurrentDevelopmentVersion(version: string): boolean {
  const stable = STABLE_VERSION.exec(FIXED_RELEASE_VERSION);
  const dev = DEV_VERSION.exec(version);
  if (stable === null || dev === null || version.length > 64 || !dev.slice(1).every(value => Number.isSafeInteger(Number(value)))) return false;
  return dev[1] === stable[1] && dev[2] === stable[2] && Number(dev[3]) === Number(stable[3]) + 1;
}
function unavailableDevelopmentRelease(): RunnerReleaseDescriptor {
  return { channel: "dev", distributable: false, current_version: "", latest_version: "", package_name: "", package_version: "", package_spec: "", artifact: null, artifacts: null, manifest_url: null, signature_url: null, signature_descriptor_url: null, checksums_url: null, release_key_id: null, published_at: null, protocol: protocol() };
}
function validatedCachedDevelopmentRelease(value: unknown): CachedDevelopmentReleaseRecord | undefined {
  if (!isRecord(value) || value.schema_version !== 1 || !Number.isSafeInteger(value.verified_at_ms) || Number(value.verified_at_ms) <= 0 || !isRecord(value.descriptor)) return undefined;
  const descriptor = value.descriptor;
  if (descriptor.channel !== "dev" || descriptor.distributable !== true || typeof descriptor.package_version !== "string" || !isCurrentDevelopmentVersion(descriptor.package_version)) return undefined;
  const target = installerReleaseTarget(descriptor.package_version, "dev");
  if (descriptor.current_version !== target.version || descriptor.latest_version !== target.version || descriptor.package_name !== "@aloneio/runmesh-runner" || descriptor.package_version !== target.version || descriptor.package_spec !== target.artifact_url) return undefined;
  if (!isRecord(descriptor.artifact) || descriptor.artifact.source !== target.artifact_url || descriptor.artifacts !== null || descriptor.manifest_url !== target.manifest_url || descriptor.signature_url !== target.signature_url || descriptor.signature_descriptor_url !== target.signature_descriptor_url || descriptor.checksums_url !== target.checksums_url || descriptor.release_key_id !== target.release_key_id || !validTimestamp(descriptor.published_at)) return undefined;
  if (!isRecord(descriptor.protocol) || descriptor.protocol.min_version !== PROTOCOL_MIN_VERSION || descriptor.protocol.max_version !== PROTOCOL_CURRENT_VERSION) return undefined;
  return { schema_version: 1, verified_at_ms: Number(value.verified_at_ms), descriptor: {
    channel: "dev", distributable: true, current_version: target.version, latest_version: target.version,
    package_name: "@aloneio/runmesh-runner", package_version: target.version, package_spec: target.artifact_url,
    artifact: { source: target.artifact_url }, artifacts: null, manifest_url: target.manifest_url,
    signature_url: target.signature_url, signature_descriptor_url: target.signature_descriptor_url,
    checksums_url: target.checksums_url, release_key_id: target.release_key_id,
    published_at: descriptor.published_at, protocol: protocol(),
  } };
}
function defaultDevelopmentReleaseCache(): DevelopmentReleaseCache | undefined {
  try {
    if (typeof caches === "undefined") return undefined;
    return (caches as unknown as { readonly default?: DevelopmentReleaseCache }).default;
  } catch { return undefined; }
}
async function readDevelopmentReleaseCache(cache: DevelopmentReleaseCache | undefined): Promise<CachedDevelopmentReleaseRecord | undefined> {
  if (cache === undefined) return undefined;
  try { const response = await cache.match(DEV_RELEASE_CACHE_KEY); return response === undefined || !response.ok ? undefined : validatedCachedDevelopmentRelease(await boundedJson(response)); } catch { return undefined; }
}
async function writeDevelopmentReleaseCache(cache: DevelopmentReleaseCache | undefined, descriptor: RunnerReleaseDescriptor, verifiedAtMs: number): Promise<void> {
  if (cache === undefined) return;
  const body: CachedDevelopmentReleaseRecord = { schema_version: 1, verified_at_ms: verifiedAtMs, descriptor };
  try { await cache.put(DEV_RELEASE_CACHE_KEY, new Response(JSON.stringify(body), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=3600" } })); } catch { /* Cache availability must not affect signed release correctness. */ }
}

export function releaseGateDiagnostics(env: RunnerReleaseEnvironment): ReleaseGateDiagnostics {
  let canonicalPublicOriginConfigured = false;
  try { canonicalPublicOriginConfigured = env.RUNMESH_PUBLIC_ORIGIN !== undefined && canonicalPublicOrigin(env.RUNMESH_PUBLIC_ORIGIN).length > 0; } catch { canonicalPublicOriginConfigured = false; }
  return {
    acknowledgement_matches_fixed_release: isDevelopment(env) ? env.RUNMESH_SIGNED_RELEASE_AVAILABLE === "dev" : signedReleaseIsAvailable(env.RUNMESH_SIGNED_RELEASE_AVAILABLE),
    canonical_public_origin_configured: canonicalPublicOriginConfigured,
    test_mode_disabled: env.RUNMESH_TEST_MODE !== "1",
  };
}

/** Stable descriptor remains source-pinned and network-free. */
export function runnerReleaseDescriptor(env: RunnerReleaseEnvironment): RunnerReleaseDescriptor {
  let originReady = false;
  try { originReady = env.RUNMESH_PUBLIC_ORIGIN !== undefined && canonicalPublicOrigin(env.RUNMESH_PUBLIC_ORIGIN).length > 0; } catch { originReady = false; }
  const distributable = signedReleaseIsAvailable(env.RUNMESH_SIGNED_RELEASE_AVAILABLE) && originReady && env.RUNMESH_TEST_MODE !== "1";
  return { ...fixedReleaseDescriptor(distributable), protocol: protocol() };
}

function retryableReleaseResponse(response: Response): boolean {
  if (response.status === 403 || response.status === 429 || response.status >= 500) return true;
  return false;
}
async function releaseFetch(input: string, init: Omit<RequestInit, "signal">, fetchImpl: typeof fetch): Promise<Response> {
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

async function boundedJson(response: Response): Promise<unknown> {
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
  if (!isRecord(manifest) || manifest.schema_version !== 1 || manifest.project !== "runmesh" || manifest.version !== target.version || manifest.tag !== target.tag || manifest.channel !== "dev" || manifest.prerelease !== true || !COMMIT_SHA.test(String(manifest.commit_sha ?? "")) || manifest.protocol_min !== PROTOCOL_MIN_VERSION || manifest.protocol_max !== PROTOCOL_CURRENT_VERSION || !validTimestamp(manifest.published_at) || !Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 1) throw new Error("development release manifest is invalid");
  const artifact = manifest.artifacts[0];
  if (!isRecord(artifact) || artifact.name !== target.artifact_name || artifact.platform !== "node" || artifact.architecture !== "portable" || artifact.node_major_min !== 22 || artifact.url !== target.artifact_url || !Number.isSafeInteger(artifact.size) || Number(artifact.size) <= 0 || Number(artifact.size) > MAX_RELEASE_ASSET_BYTES || !SHA256.test(String(artifact.sha256 ?? ""))) throw new Error("development release manifest artifact is invalid");
}

function developmentDescriptor(value: unknown): RunnerReleaseDescriptor | undefined {
  if (!isRecord(value) || value.draft !== false || value.prerelease !== true || value.immutable !== true || typeof value.tag_name !== "string") return undefined;
  const version = value.tag_name.startsWith("v") ? value.tag_name.slice(1) : "";
  if (!isCurrentDevelopmentVersion(version)) return undefined;
  if (!validTimestamp(value.published_at)) return undefined;
  if (!Array.isArray(value.assets)) return undefined;
  const names = new Set(value.assets.flatMap(asset => isRecord(asset) && typeof asset.name === "string" ? [asset.name] : []));
  const target = installerReleaseTarget(version, "dev");
  for (const name of [...REQUIRED_STATIC_ASSETS, target.artifact_name]) if (!names.has(name)) return undefined;
  return {
    channel: "dev", distributable: true, current_version: version, latest_version: version,
    package_name: "@aloneio/runmesh-runner", package_version: version, package_spec: target.artifact_url,
    artifact: { source: target.artifact_url }, artifacts: null, manifest_url: target.manifest_url, signature_url: target.signature_url,
    signature_descriptor_url: target.signature_descriptor_url, checksums_url: target.checksums_url, release_key_id: target.release_key_id,
    published_at: value.published_at, protocol: protocol(),
  };
}

type DevelopmentReleaseVerifier = (descriptor: RunnerReleaseDescriptor, fetchImpl: typeof fetch) => Promise<void>;
export type DevelopmentReleaseRefreshScheduler = (work: Promise<void>) => void;
function usableCacheAge(verifiedAtMs: number, now: number, limit: number): boolean {
  return verifiedAtMs <= now && now - verifiedAtMs < limit;
}

async function refreshDevelopmentRunnerRelease(fetchImpl: typeof fetch, verifyRelease: DevelopmentReleaseVerifier, cache: DevelopmentReleaseCache | undefined, useRuntimeCache: boolean): Promise<RunnerReleaseDescriptor> {
  // Bound the complete refresh, including all assets, below waitUntil's lifetime.
  const deadline = AbortSignal.timeout(DEV_RELEASE_REFRESH_BUDGET_MS);
  const boundedFetch: typeof fetch = (input, init) => {
    deadline.throwIfAborted();
    const signal = init?.signal == null ? deadline : AbortSignal.any([deadline, init.signal]);
    return fetchImpl(input, { ...init, signal });
  };
  const response = await releaseFetch(DEV_RELEASE_DISCOVERY_URL, {
    method: "GET", redirect: "manual", cache: "no-store", credentials: "omit",
    headers: { accept: "application/vnd.github+json", "user-agent": "runmeshdev-release-discovery/1", "x-github-api-version": "2026-03-10" },
  }, boundedFetch);
  const releases = await boundedJson(response);
  if (!Array.isArray(releases)) throw new Error("development release discovery response is invalid");
  const candidates = releases.flatMap(value => { const descriptor = developmentDescriptor(value); return descriptor === undefined ? [] : [descriptor]; });
  candidates.sort((a, b) => Number(b.package_version.split("-dev.")[1]) - Number(a.package_version.split("-dev.")[1]));
  for (const descriptor of candidates) {
    try {
      await verifyRelease(descriptor, boundedFetch);
      const verifiedAtMs = Date.now();
      if (useRuntimeCache) cachedDevRelease = { expires_at_ms: verifiedAtMs + DEV_RELEASE_CACHE_MS, verified_at_ms: verifiedAtMs, descriptor };
      await writeDevelopmentReleaseCache(cache, descriptor, verifiedAtMs);
      return descriptor;
    } catch { /* A malformed or unverifiable prerelease is never advertised. */ }
  }
  throw new Error("no immutable signed development Runner release is available");
}

export async function discoverDevelopmentRunnerRelease(fetchImpl: typeof fetch = fetch, verifyRelease: DevelopmentReleaseVerifier = verifyDevelopmentRunnerRelease, cacheOverride?: DevelopmentReleaseCache | null, scheduleRefresh?: DevelopmentReleaseRefreshScheduler): Promise<RunnerReleaseDescriptor> {
  const useRuntimeCache = fetchImpl === fetch && verifyRelease === verifyDevelopmentRunnerRelease;
  const cache = cacheOverride === null ? undefined : cacheOverride ?? (useRuntimeCache ? defaultDevelopmentReleaseCache() : undefined);
  const now = Date.now();
  if (useRuntimeCache && cachedDevRelease !== undefined && cachedDevRelease.expires_at_ms > now && usableCacheAge(cachedDevRelease.verified_at_ms, now, DEV_RELEASE_STALE_MS)) return cachedDevRelease.descriptor;
  const cached = await readDevelopmentReleaseCache(cache);
  const cacheAgeMs = cached === undefined || cached.verified_at_ms > now ? Number.POSITIVE_INFINITY : now - cached.verified_at_ms;
  if (cached !== undefined && cacheAgeMs <= DEV_RELEASE_CACHE_MS) {
    if (useRuntimeCache) cachedDevRelease = { expires_at_ms: Math.min(now + DEV_RELEASE_CACHE_MS, cached.verified_at_ms + DEV_RELEASE_STALE_MS), verified_at_ms: cached.verified_at_ms, descriptor: cached.descriptor };
    return cached.descriptor;
  }
  if (cached !== undefined && cacheAgeMs < DEV_RELEASE_STALE_MS && scheduleRefresh !== undefined) {
    if (useRuntimeCache) cachedDevRelease = { expires_at_ms: Math.min(now + DEV_RELEASE_CACHE_MS, cached.verified_at_ms + DEV_RELEASE_STALE_MS), verified_at_ms: cached.verified_at_ms, descriptor: cached.descriptor };
    // Do not share an I/O promise between requests. Only throttle refresh launches.
    if (!useRuntimeCache || now >= nextRuntimeRefreshAtMs) {
      if (useRuntimeCache) nextRuntimeRefreshAtMs = now + DEV_RELEASE_CACHE_MS;
      const refresh = refreshDevelopmentRunnerRelease(fetchImpl, verifyRelease, cache, useRuntimeCache).then(() => undefined).catch(() => undefined);
      try { scheduleRefresh(refresh); } catch { /* Cached bytes remain usable until their original hard deadline. */ }
    }
    return cached.descriptor;
  }
  try { return await refreshDevelopmentRunnerRelease(fetchImpl, verifyRelease, cache, useRuntimeCache); }
  catch (error) {
    if (cached !== undefined && usableCacheAge(cached.verified_at_ms, Date.now(), DEV_RELEASE_STALE_MS)) {
      if (useRuntimeCache) cachedDevRelease = { expires_at_ms: Math.min(now + DEV_RELEASE_CACHE_MS, cached.verified_at_ms + DEV_RELEASE_STALE_MS), verified_at_ms: cached.verified_at_ms, descriptor: cached.descriptor };
      return cached.descriptor;
    }
    throw error;
  }
}

/** Development is dev-only. Discovery failure is fail-closed; stable is never used as a fallback. */
export async function resolveRunnerReleaseDescriptor(env: RunnerReleaseEnvironment, fetchImpl: typeof fetch = fetch, cacheOverride?: DevelopmentReleaseCache | null, scheduleRefresh?: DevelopmentReleaseRefreshScheduler): Promise<RunnerReleaseDescriptor> {
  if (!isDevelopment(env)) return runnerReleaseDescriptor(env);
  const gate = releaseGateDiagnostics(env);
  if (!gate.acknowledgement_matches_fixed_release || !gate.canonical_public_origin_configured || !gate.test_mode_disabled) return unavailableDevelopmentRelease();
  try { return await discoverDevelopmentRunnerRelease(fetchImpl, verifyDevelopmentRunnerRelease, cacheOverride, scheduleRefresh); }
  catch { return unavailableDevelopmentRelease(); }
}

export async function resolveDevelopmentRunnerRelease(env: RunnerReleaseEnvironment, fetchImpl: typeof fetch = fetch, cacheOverride?: DevelopmentReleaseCache | null, scheduleRefresh?: DevelopmentReleaseRefreshScheduler): Promise<RunnerReleaseDescriptor> {
  if (!isDevelopment(env)) return unavailableDevelopmentRelease();
  return resolveRunnerReleaseDescriptor(env, fetchImpl, cacheOverride, scheduleRefresh);
}
