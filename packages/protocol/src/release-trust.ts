/** Source-reviewed trust shared by the installer, control plane and host updater. */
export const FIXED_RELEASE_KEY_ID = "runmesh-preview-2026-01";
export const FIXED_RELEASE_PUBLIC_KEY_PEM = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEASXdEYS7UorlzNJ8ij2gftFIX2rrTvhNlZm3MqE/BWXI=\n-----END PUBLIC KEY-----\n";
export const MAX_RELEASE_ASSET_BYTES = 8 * 1024 * 1024;
export const FIXED_RELEASE_ALLOWED_REDIRECT_ORIGINS = [
  "https://github.com", "https://objects.githubusercontent.com",
  "https://release-assets.githubusercontent.com", "https://github-releases.githubusercontent.com",
  "https://github-cloud.s3.amazonaws.com",
] as const;

const EXACT_VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-dev\.(0|[1-9]\d{0,19}))?$/u;
export function exactRunnerRelease(version: string) {
  if (!EXACT_VERSION.test(version)) throw new Error("Enter an exact Runner version, such as 0.1.7 or 0.1.7-dev.123.");
  const channel = version.includes("-dev.") ? "dev" as const : "stable" as const;
  const tag = `v${version}`;
  const base = `https://github.com/aloneio/runmesh/releases/download/${tag}`;
  const artifact_name = `runmesh-runner-${version}.tgz`;
  return { version, channel, tag, release_base_url: base, artifact_name, artifact_url: `${base}/${artifact_name}`,
    manifest_url: `${base}/manifest.json`, signature_url: `${base}/manifest.sig`,
    signature_descriptor_url: `${base}/manifest.signature.json`, checksums_url: `${base}/SHA256SUMS`,
    release_key_id: FIXED_RELEASE_KEY_ID, public_key_pem: FIXED_RELEASE_PUBLIC_KEY_PEM };
}
