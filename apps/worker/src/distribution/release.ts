import { canonicalPublicOrigin } from "../installer.js";
import { fixedReleaseDescriptor } from "../installer.js";
import type { FixedReleaseDescriptor } from "../installer.js";
import { PROTOCOL_CURRENT_VERSION } from "@aloneio/runmesh-protocol";
import { PROTOCOL_MIN_VERSION } from "@aloneio/runmesh-protocol";
import { signedReleaseIsAvailable } from "../installer.js";

// SVG can replace the working copy without touching any page templates.
export interface RunnerReleaseDescriptor extends FixedReleaseDescriptor {
  readonly protocol: { readonly min_version: number; readonly max_version: number };
}

export interface ReleaseGateDiagnostics {
  readonly acknowledgement_matches_fixed_release: boolean;
  readonly canonical_public_origin_configured: boolean;
  readonly test_mode_disabled: boolean;
}

export interface RunnerReleaseEnvironment {
  /**
   * Explicit deployment acknowledgement set only after the immutable fixed
   * GitHub prerelease has been published and independently verified. Other
   * values fail closed; URLs, packages and version strings are never accepted.
   */
  readonly RUNMESH_SIGNED_RELEASE_AVAILABLE?: string;
  /** Canonical external HTTPS origin; required before hosted bootstrap is exposed. */
  readonly RUNMESH_PUBLIC_ORIGIN?: string;
  /** Test-harness-only switch; never configured by a deployment. */
  readonly RUNMESH_TEST_MODE?: string;
}

export function releaseGateDiagnostics(env: RunnerReleaseEnvironment): ReleaseGateDiagnostics {
  let canonicalPublicOriginConfigured = false;
  try { canonicalPublicOriginConfigured = env.RUNMESH_PUBLIC_ORIGIN !== undefined && canonicalPublicOrigin(env.RUNMESH_PUBLIC_ORIGIN).length > 0; } catch { canonicalPublicOriginConfigured = false; }
  return {
    acknowledgement_matches_fixed_release: signedReleaseIsAvailable(env.RUNMESH_SIGNED_RELEASE_AVAILABLE),
    canonical_public_origin_configured: canonicalPublicOriginConfigured,
    test_mode_disabled: env.RUNMESH_TEST_MODE !== "1",
  };
}

export function runnerReleaseDescriptor(env: RunnerReleaseEnvironment): RunnerReleaseDescriptor {
  const gate = releaseGateDiagnostics(env);
  const distributable = gate.acknowledgement_matches_fixed_release && gate.canonical_public_origin_configured && gate.test_mode_disabled;
  return { ...fixedReleaseDescriptor(distributable), protocol: { min_version: PROTOCOL_MIN_VERSION, max_version: PROTOCOL_CURRENT_VERSION } };
}
