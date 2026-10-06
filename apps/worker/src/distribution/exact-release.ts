import { exactRunnerRelease, MAX_RELEASE_ASSET_BYTES, PROTOCOL_CURRENT_VERSION, PROTOCOL_MIN_VERSION, releaseManifestProblem, verifyRunnerReleaseSignature } from "@aloneio/runmesh-protocol";
import type { RunnerReleaseDescriptor } from "../contracts/runner-release.js";
import { boundedReleaseBytes, DevelopmentReleaseError, releasePhase } from "./release-io.js";

export type ExactRunnerReleaseDescriptor = RunnerReleaseDescriptor & { readonly manifest_sha256: string; readonly artifact_sha256: string };

/** Explicit version selection is independent of the monotonic latest-release cache. */
export async function resolveExactRunnerRelease(version: string, fetchImpl: typeof fetch = fetch): Promise<ExactRunnerReleaseDescriptor> {
  const target = exactRunnerRelease(version);
  const manifest = await releasePhase("manifest", "invalid_response", () => boundedReleaseBytes(target.manifest_url, 65536, fetchImpl, "manifest"));
  const signature = await releasePhase("signature", "invalid_response", () => boundedReleaseBytes(target.signature_url, 1024, fetchImpl, "signature"));
  const descriptor = await releasePhase("signature_descriptor", "invalid_response", () => boundedReleaseBytes(target.signature_descriptor_url, 16384, fetchImpl, "signature_descriptor"));
  const verified = await releasePhase("verification", "invalid_signature", () => verifyRunnerReleaseSignature(manifest, signature, descriptor));
  const problem = releaseManifestProblem(verified, { ...target, protocol_min: PROTOCOL_MIN_VERSION, protocol_max: PROTOCOL_CURRENT_VERSION,
    max_asset_bytes: MAX_RELEASE_ASSET_BYTES, compatibility: "overlap", node_major: 22 });
  if (problem !== undefined) throw new DevelopmentReleaseError("This release does not match the Runner protocol and runtime requirements.", { phase: "verification", reason: "invalid_manifest" });
  const release = verified as { protocol_min: number; protocol_max: number; published_at: string; artifacts: [{ sha256: string }] };
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(manifest)));
  return { channel: target.channel, distributable: true, current_version: version, latest_version: version,
    package_name: "@aloneio/runmesh-runner", package_version: version, package_spec: target.artifact_url,
    artifact: { source: target.artifact_url }, artifacts: null, manifest_url: target.manifest_url, signature_url: target.signature_url,
    signature_descriptor_url: target.signature_descriptor_url, checksums_url: target.checksums_url, release_key_id: target.release_key_id,
    published_at: release.published_at, protocol: { min_version: release.protocol_min, max_version: release.protocol_max },
    manifest_sha256: [...digest].map(byte => byte.toString(16).padStart(2, "0")).join(""), artifact_sha256: release.artifacts[0].sha256 };
}
