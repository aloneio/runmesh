import { compareDevelopmentReleaseVersions, DEV_RELEASE_STALE_MS, validatedCachedDevelopmentRelease } from "../domain/release-selection.js";
import type { CachedDevelopmentReleaseRecord } from "../contracts/runner-release.js";

export type DevelopmentReleaseCacheUpdate =
  | { readonly kind: "invalid" | "unchanged" }
  | { readonly kind: "write"; readonly record: CachedDevelopmentReleaseRecord };

/** Cache admission uses fresh verification and preserves the signed release cadence. */
export function developmentReleaseCacheUpdate(input: unknown, stored: unknown, now: number): DevelopmentReleaseCacheUpdate {
  const candidate = validatedCachedDevelopmentRelease(input);
  if (candidate === undefined || candidate.verified_at_ms > now + 60_000
    || now - candidate.verified_at_ms >= DEV_RELEASE_STALE_MS) return { kind: "invalid" };
  const current = validatedCachedDevelopmentRelease(stored);
  if (current !== undefined) {
    // Reverification advances freshness, never the release cadence. Ambiguous
    // same-cadence versions retain the existing signed descriptor.
    const order = compareDevelopmentReleaseVersions(current.descriptor.package_version, candidate.descriptor.package_version);
    if (order > 0 || (order === 0 && (current.descriptor.package_version !== candidate.descriptor.package_version
      || current.verified_at_ms >= candidate.verified_at_ms))) return { kind: "unchanged" };
  }
  return { kind: "write", record: candidate };
}
