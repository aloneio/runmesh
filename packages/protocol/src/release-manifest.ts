/** Platform-independent signed-manifest fields. This source is also compiled
 * into the standalone installer verifier; never add I/O or runtime imports. */
export interface ReleaseValidationTarget {
  readonly version: string;
  readonly channel: "stable" | "dev";
  readonly artifact_name: string;
  readonly artifact_url: string;
  readonly protocol_min: number;
  readonly protocol_max: number;
  readonly max_asset_bytes: number;
  /** Bootstrap requires its reviewed exact range; explicit updates use overlap. */
  readonly compatibility?: "overlap";
  readonly node_major?: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validReleaseTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value)
    && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().replace(".000Z", "Z") === value;
}

/** Unknown signed fields are tolerated, but every consumed field is typed. */
export function releaseManifestProblem(value: unknown, target: ReleaseValidationTarget): "manifest" | "artifact" | undefined {
  if (!record(value) || value.schema_version !== 1 || value.project !== "runmesh"
    || value.version !== target.version || value.tag !== `v${target.version}`
    || value.channel !== target.channel || value.prerelease !== (target.channel === "dev")
    || typeof value.commit_sha !== "string" || !/^[a-f0-9]{40}$/u.test(value.commit_sha)
    || (target.compatibility === "overlap"
      ? !Number.isSafeInteger(value.protocol_min) || !Number.isSafeInteger(value.protocol_max)
        || Number(value.protocol_min) < 1 || Number(value.protocol_min) > Number(value.protocol_max)
        || Number(value.protocol_min) > target.protocol_max || Number(value.protocol_max) < target.protocol_min
      : value.protocol_min !== target.protocol_min || value.protocol_max !== target.protocol_max)
    || !validReleaseTimestamp(value.published_at) || !Array.isArray(value.artifacts) || value.artifacts.length !== 1) return "manifest";
  const artifact: unknown = value.artifacts[0];
  if (!record(artifact) || artifact.name !== target.artifact_name || artifact.platform !== "node"
    || artifact.architecture !== "portable" || (target.node_major === undefined ? artifact.node_major_min !== 22
      : !Number.isSafeInteger(artifact.node_major_min) || Number(artifact.node_major_min) < 20 || Number(artifact.node_major_min) > target.node_major)
    || artifact.url !== target.artifact_url
    || typeof artifact.size !== "number" || !Number.isSafeInteger(artifact.size)
    || artifact.size <= 0 || artifact.size > target.max_asset_bytes
    || typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(artifact.sha256)) return "artifact";
  return undefined;
}
