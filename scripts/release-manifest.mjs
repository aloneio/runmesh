import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_VERSION } from "./product-version.mjs";

export const RELEASE_PROJECT = "runmesh";
export const RELEASE_CHANNEL = "dev";
export const RELEASE_MANIFEST_SCHEMA_VERSION = 1;
export const RELEASE_PROTOCOL_MIN = 2;
export const RELEASE_PROTOCOL_MAX = 2;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export function releaseVersion(value) {
  if (typeof value !== "string" || !SEMVER.test(value)) throw new Error("release version is invalid");
  return value;
}
export function releaseTag(version) { return `v${releaseVersion(version)}`; }
export function releaseArtifactName(version) { return `runmesh-runner-${releaseVersion(version)}.tgz`; }
export function releaseAssetUrl(version, name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(name)) throw new Error(`unsafe release asset name: ${name}`);
  return `https://github.com/aloneio/runmesh/releases/download/${releaseTag(version)}/${encodeURIComponent(name)}`;
}

export async function buildManifest({ releaseDirectory, version = PRODUCT_VERSION, commitSha, publishedAt }) {
  if (version !== PRODUCT_VERSION) throw new Error(`release version must match root package.json (${PRODUCT_VERSION})`);
  if (!COMMIT_SHA.test(commitSha)) throw new Error("commit_sha must be a lowercase 40-character Git SHA");
  if (!TIMESTAMP.test(publishedAt) || Number.isNaN(Date.parse(publishedAt))) throw new Error("published_at must be a UTC ISO timestamp without milliseconds");
  const names = (await readdir(releaseDirectory)).filter((name) => name.endsWith(".tgz")).sort();
  const expectedName = releaseArtifactName(version);
  if (names.length !== 1 || names[0] !== expectedName) throw new Error(`release must contain exactly ${expectedName}`);
  const path = join(releaseDirectory, expectedName);
  const bytes = await readFile(path);
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size <= 0) throw new Error(`empty Runner artifact: ${expectedName}`);
  return validateManifest({
    schema_version: RELEASE_MANIFEST_SCHEMA_VERSION,
    project: RELEASE_PROJECT,
    version,
    tag: releaseTag(version),
    channel: RELEASE_CHANNEL,
    prerelease: true,
    commit_sha: commitSha,
    protocol_min: RELEASE_PROTOCOL_MIN,
    protocol_max: RELEASE_PROTOCOL_MAX,
    published_at: publishedAt,
    artifacts: [{
      name: basename(expectedName),
      platform: "node",
      architecture: "portable",
      node_major_min: 20,
      url: releaseAssetUrl(version, expectedName),
      size: metadata.size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }],
  }, version);
}

export function validateManifest(value, expectedVersion = value?.version) {
  const version = releaseVersion(expectedVersion);
  if (!isObject(value)
    || value.schema_version !== RELEASE_MANIFEST_SCHEMA_VERSION
    || value.project !== RELEASE_PROJECT
    || value.version !== version
    || value.tag !== releaseTag(version)
    || value.channel !== RELEASE_CHANNEL
    || value.prerelease !== true
    || !COMMIT_SHA.test(value.commit_sha)
    || value.protocol_min !== RELEASE_PROTOCOL_MIN
    || value.protocol_max !== RELEASE_PROTOCOL_MAX
    || !TIMESTAMP.test(value.published_at)
    || !Array.isArray(value.artifacts)
    || value.artifacts.length !== 1) {
    throw new Error("invalid Runmesh development manifest");
  }
  const artifact = value.artifacts[0];
  const expectedName = releaseArtifactName(version);
  if (!isObject(artifact)
    || artifact.name !== expectedName
    || artifact.platform !== "node"
    || artifact.architecture !== "portable"
    || artifact.node_major_min !== 20
    || artifact.url !== releaseAssetUrl(version, expectedName)
    || !Number.isSafeInteger(artifact.size)
    || artifact.size <= 0
    || typeof artifact.sha256 !== "string"
    || !SHA256.test(artifact.sha256)) {
    throw new Error("invalid manifest artifact");
  }
  return {
    schema_version: RELEASE_MANIFEST_SCHEMA_VERSION,
    project: RELEASE_PROJECT,
    version,
    tag: releaseTag(version),
    channel: RELEASE_CHANNEL,
    prerelease: true,
    commit_sha: value.commit_sha,
    protocol_min: RELEASE_PROTOCOL_MIN,
    protocol_max: RELEASE_PROTOCOL_MAX,
    published_at: value.published_at,
    artifacts: [{
      name: artifact.name,
      platform: artifact.platform,
      architecture: artifact.architecture,
      node_major_min: artifact.node_major_min,
      url: artifact.url,
      size: artifact.size,
      sha256: artifact.sha256,
    }],
  };
}

export async function writeManifest(options) {
  const manifest = await buildManifest(options);
  await writeFile(join(options.releaseDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}
function isObject(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
async function main(args) {
  const [directory, version, commitSha, publishedAt] = args;
  if (args.length !== 4 || [directory, version, commitSha, publishedAt].some((value) => value === undefined)) {
    throw new Error("usage: release-manifest.mjs <release-directory> <version> <commit-sha> <published-at>");
  }
  await writeManifest({ releaseDirectory: resolve(directory), version, commitSha, publishedAt });
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
