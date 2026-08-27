import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_PROJECT = "runmesh";
export const RELEASE_VERSION = "0.1.0-dev.1";
export const RELEASE_TAG = "v0.1.0-dev.1";
export const RELEASE_CHANNEL = "dev";
export const RELEASE_PROTOCOL_MIN = 2;
export const RELEASE_PROTOCOL_MAX = 2;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const PLATFORMS = new Set(["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64"]);

export function releaseVersion(value) {
  if (value !== RELEASE_VERSION && value !== RELEASE_TAG) throw new Error(`release version must be ${RELEASE_VERSION}`);
  return RELEASE_VERSION;
}

export function releaseAssetUrl(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(name)) throw new Error(`unsafe release asset name: ${name}`);
  return `https://github.com/aloneio/runmesh/releases/download/${RELEASE_TAG}/${encodeURIComponent(name)}`;
}

export function platformForArtifact(name) {
  const prefix = `runmesh-runner-${RELEASE_VERSION}-`;
  if (!name.startsWith(prefix) || !name.endsWith(".tgz")) throw new Error(`invalid Runner artifact name: ${name}`);
  const id = name.slice(prefix.length, -4);
  if (!PLATFORMS.has(id)) throw new Error(`unsupported Runner artifact platform: ${id}`);
  const [platform, architecture] = id.split("-");
  return { platform, architecture };
}

export async function buildManifest({ releaseDirectory, commitSha, publishedAt }) {
  if (!COMMIT_SHA.test(commitSha)) throw new Error("commit_sha must be a lowercase 40-character Git SHA");
  if (!TIMESTAMP.test(publishedAt) || Number.isNaN(Date.parse(publishedAt))) throw new Error("published_at must be a UTC ISO timestamp without milliseconds");
  const names = (await readdir(releaseDirectory)).filter((name) => name.endsWith(".tgz")).sort();
  if (names.length !== PLATFORMS.size) throw new Error(`release must contain exactly ${PLATFORMS.size} Runner artifacts`);
  const seen = new Set();
  const artifacts = [];
  for (const name of names) {
    const { platform, architecture } = platformForArtifact(name);
    const id = `${platform}-${architecture}`;
    if (seen.has(id)) throw new Error(`duplicate Runner artifact: ${id}`);
    seen.add(id);
    const path = join(releaseDirectory, name);
    const bytes = await readFile(path);
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size <= 0) throw new Error(`empty Runner artifact: ${name}`);
    artifacts.push({ name: basename(name), platform, architecture, url: releaseAssetUrl(name), size: metadata.size, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return validateManifest({ schema_version: 1, project: RELEASE_PROJECT, version: RELEASE_VERSION, tag: RELEASE_TAG, channel: RELEASE_CHANNEL, prerelease: true, commit_sha: commitSha, protocol_min: RELEASE_PROTOCOL_MIN, protocol_max: RELEASE_PROTOCOL_MAX, published_at: publishedAt, artifacts });
}

export function validateManifest(value) {
  if (!isObject(value) || value.schema_version !== 1 || value.project !== RELEASE_PROJECT || value.version !== RELEASE_VERSION || value.tag !== RELEASE_TAG || value.channel !== RELEASE_CHANNEL || value.prerelease !== true || !COMMIT_SHA.test(value.commit_sha) || value.protocol_min !== RELEASE_PROTOCOL_MIN || value.protocol_max !== RELEASE_PROTOCOL_MAX || !TIMESTAMP.test(value.published_at) || !Array.isArray(value.artifacts) || value.artifacts.length !== PLATFORMS.size) throw new Error("invalid Runmesh development manifest");
  const seen = new Set();
  const artifacts = value.artifacts.map((artifact) => {
    if (!isObject(artifact) || typeof artifact.name !== "string" || typeof artifact.platform !== "string" || typeof artifact.architecture !== "string" || typeof artifact.url !== "string" || !Number.isSafeInteger(artifact.size) || artifact.size <= 0 || typeof artifact.sha256 !== "string" || !SHA256.test(artifact.sha256)) throw new Error("invalid manifest artifact");
    const parsed = platformForArtifact(artifact.name);
    if (parsed.platform !== artifact.platform || parsed.architecture !== artifact.architecture || artifact.url !== releaseAssetUrl(artifact.name)) throw new Error(`artifact identity mismatch: ${artifact.name}`);
    const id = `${artifact.platform}-${artifact.architecture}`;
    if (seen.has(id)) throw new Error(`duplicate manifest artifact: ${id}`);
    seen.add(id);
    return { name: artifact.name, platform: artifact.platform, architecture: artifact.architecture, url: artifact.url, size: artifact.size, sha256: artifact.sha256 };
  });
  return { schema_version: 1, project: RELEASE_PROJECT, version: RELEASE_VERSION, tag: RELEASE_TAG, channel: RELEASE_CHANNEL, prerelease: true, commit_sha: value.commit_sha, protocol_min: RELEASE_PROTOCOL_MIN, protocol_max: RELEASE_PROTOCOL_MAX, published_at: value.published_at, artifacts };
}

export async function writeManifest(options) {
  const manifest = await buildManifest(options);
  await writeFile(join(options.releaseDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}
function isObject(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }

async function main(args) {
  const [directory, commitSha, publishedAt] = args;
  if (args.length !== 3 || directory === undefined || commitSha === undefined || publishedAt === undefined) throw new Error("usage: release-manifest.mjs <release-directory> <commit-sha> <published-at>");
  await writeManifest({ releaseDirectory: resolve(directory), commitSha, publishedAt });
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
