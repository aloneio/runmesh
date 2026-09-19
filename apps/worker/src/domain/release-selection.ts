import { PROTOCOL_CURRENT_VERSION, PROTOCOL_MIN_VERSION } from "@aloneio/runmesh-protocol";
import { canonicalPublicOrigin } from "../public-origin.js";
import { FIXED_RELEASE_VERSION, fixedReleaseDescriptor, installerReleaseTarget, signedReleaseIsAvailable } from "./release-config.js";
import { validReleaseTimestamp as validTimestamp } from "./release-manifest.js";
import type { RunnerReleaseDescriptor, ReleaseGateDiagnostics, RunnerReleaseEnvironment, CachedDevelopmentReleaseRecord, DevelopmentReleaseRuntime } from "../contracts/runner-release.js";

export const DEV_RELEASE_CACHE_MS = 60_000;
export const DEV_RELEASE_STALE_MS = 60 * 60_000;
export const DEV_RELEASE_REFRESH_BUDGET_MS = 20_000;
const DEV_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-dev\.(0|[1-9]\d*)$/u;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const REQUIRED_STATIC_ASSETS = ["LICENSE", "NOTICE", "SHA256SUMS", "THIRD_PARTY_NOTICES.md", "manifest.json", "manifest.sig", "manifest.signature.json", "trust-keyring.json"] as const;

export function protocol() { return { min_version: PROTOCOL_MIN_VERSION, max_version: PROTOCOL_CURRENT_VERSION } as const; }
export function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function isDevelopment(env: RunnerReleaseEnvironment): boolean {
  return env.RUNMESH_ENVIRONMENT === "development" || (env.RUNMESH_ENVIRONMENT === undefined && env.WORKER_ID === "worker-development");
}
export function isCurrentDevelopmentVersion(version: string): boolean {
  const stable = STABLE_VERSION.exec(FIXED_RELEASE_VERSION);
  const dev = DEV_VERSION.exec(version);
  if (stable === null || dev === null || version.length > 64 || !dev.slice(1).every(value => Number.isSafeInteger(Number(value)))) return false;
  return dev[1] === stable[1] && dev[2] === stable[2] && Number(dev[3]) === Number(stable[3]) + 1;
}
export function unavailableDevelopmentRelease(): RunnerReleaseDescriptor {
  return { channel: "dev", distributable: false, current_version: "", latest_version: "", package_name: "", package_version: "", package_spec: "", artifact: null, artifacts: null, manifest_url: null, signature_url: null, signature_descriptor_url: null, checksums_url: null, release_key_id: null, published_at: null, protocol: protocol() };
}
export function validatedCachedDevelopmentRelease(value: unknown): CachedDevelopmentReleaseRecord | undefined {
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

export function developmentDescriptor(value: unknown): RunnerReleaseDescriptor | undefined {
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

export function usableCacheAge(verifiedAtMs: number, now: number, limit: number): boolean {
  return verifiedAtMs <= now && now - verifiedAtMs < limit;
}

export function createDevelopmentReleaseRuntime(): DevelopmentReleaseRuntime {
  return { next_refresh_at_ms: 0, refresh_sequence: 0, committed_sequence: 0 };
}
