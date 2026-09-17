export interface InstallerReleaseTarget {
  readonly version: string;
  readonly channel: "dev" | "stable";
  readonly tag: string;
  readonly release_base_url: string;
  readonly artifact_name: string;
  readonly artifact_url: string;
  readonly manifest_url: string;
  readonly signature_url: string;
  readonly signature_descriptor_url: string;
  readonly checksums_url: string;
  readonly release_key_id: string;
  readonly public_key_pem: string;
}

export interface FixedReleaseDescriptor {
  readonly channel: "dev" | "stable";
  readonly distributable: boolean;
  readonly current_version: string;
  readonly latest_version: string;
  readonly package_name: string;
  readonly package_version: string;
  /** A fixed tarball URL only. The signed manifest remains authoritative. */
  readonly package_spec: string;
  readonly artifact: { readonly source: string } | null;
  readonly artifacts: null;
  readonly manifest_url: string | null;
  readonly signature_url: string | null;
  readonly signature_descriptor_url: string | null;
  readonly checksums_url: string | null;
  readonly release_key_id: string | null;
  readonly published_at: null;
}

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

export interface DevelopmentReleaseCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}
export interface CachedDevelopmentReleaseRecord {
  readonly schema_version: 1;
  readonly verified_at_ms: number;
  readonly descriptor: RunnerReleaseDescriptor;
}


export type DevelopmentReleaseVerifier = (descriptor: RunnerReleaseDescriptor, fetchImpl: typeof fetch) => Promise<void>;
export type DevelopmentReleaseRefreshScheduler = (work: Promise<void>) => void;
/** Only values and launch counters may cross requests, never an I/O promise. */
export interface DevelopmentReleaseRuntime {
  cached?: { readonly expires_at_ms: number; readonly verified_at_ms: number; readonly descriptor: RunnerReleaseDescriptor };
  next_refresh_at_ms: number;
  refresh_sequence: number;
  committed_sequence: number;
}
export interface DevelopmentReleaseDependencies {
  readonly fetch: typeof fetch;
  readonly verify: DevelopmentReleaseVerifier;
  readonly cache: DevelopmentReleaseCache | undefined;
  readonly now: () => number;
  readonly runtime: DevelopmentReleaseRuntime;
}
