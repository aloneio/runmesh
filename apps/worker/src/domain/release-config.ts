import type { FixedReleaseDescriptor, InstallerReleaseTarget } from "../contracts/runner-release.js";

/**
 * Fixed, source-reviewed hosted-bootstrap contract. The Worker HTTPS endpoint
 * that serves an installer is the one-command bootstrap trust root. Release
 * assets are authenticated with this embedded key; a downloaded keyring is
 * never fetched or used by an installer.
 */
export const FIXED_RELEASE_VERSION = "0.1.3";
export const FIXED_NODE_VERSION = "22.23.2";
export const FIXED_NODE_BASE_URL = `https://nodejs.org/dist/v${FIXED_NODE_VERSION}`;
export const FIXED_RELEASE_KEY_ID = "runmesh-preview-2026-01";
export const FIXED_RELEASE_PUBLIC_KEY_PEM = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEASXdEYS7UorlzNJ8ij2gftFIX2rrTvhNlZm3MqE/BWXI=\n-----END PUBLIC KEY-----\n";
export const FIXED_RELEASE_CHANNEL = "stable" as const;
export const FIXED_RELEASE_TAG = `v${FIXED_RELEASE_VERSION}`;
export const FIXED_ARTIFACT_NAME = `runmesh-runner-${FIXED_RELEASE_VERSION}.tgz`;
export const FIXED_RELEASE_BASE_URL = `https://github.com/aloneio/runmesh/releases/download/${FIXED_RELEASE_TAG}`;
export const FIXED_ARTIFACT_URL = `${FIXED_RELEASE_BASE_URL}/${FIXED_ARTIFACT_NAME}`;
export const FIXED_MANIFEST_URL = `${FIXED_RELEASE_BASE_URL}/manifest.json`;
export const FIXED_SIGNATURE_URL = `${FIXED_RELEASE_BASE_URL}/manifest.sig`;
export const FIXED_SIGNATURE_DESCRIPTOR_URL = `${FIXED_RELEASE_BASE_URL}/manifest.signature.json`;
export const FIXED_CHECKSUMS_URL = `${FIXED_RELEASE_BASE_URL}/SHA256SUMS`;


const DEV_RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-dev\.(0|[1-9]\d*)$/u;

export function installerReleaseTarget(version: string, channel: "dev" | "stable"): InstallerReleaseTarget {
  if (channel === "stable" && version !== FIXED_RELEASE_VERSION) throw new Error("stable installer release is not the reviewed fixed release");
  if (channel === "dev" && !DEV_RELEASE_VERSION.test(version)) throw new Error("invalid development Runner release version");
  const tag = `v${version}`;
  const artifactName = `runmesh-runner-${version}.tgz`;
  const releaseBase = `https://github.com/aloneio/runmesh/releases/download/${tag}`;
  return Object.freeze({
    version, channel, tag, release_base_url: releaseBase, artifact_name: artifactName, artifact_url: `${releaseBase}/${artifactName}`,
    manifest_url: `${releaseBase}/manifest.json`, signature_url: `${releaseBase}/manifest.sig`,
    signature_descriptor_url: `${releaseBase}/manifest.signature.json`, checksums_url: `${releaseBase}/SHA256SUMS`,
    release_key_id: FIXED_RELEASE_KEY_ID, public_key_pem: FIXED_RELEASE_PUBLIC_KEY_PEM,
  });
}

export const FIXED_INSTALLER_RELEASE = installerReleaseTarget(FIXED_RELEASE_VERSION, "stable");

// Bound every fixed release asset before signature verification. The current
// Runner package is about 0.5 MiB; leave room for ordinary growth while still
// preventing an over-sized allowed-origin response from filling a host's
// temporary filesystem.
export const MAX_RELEASE_ASSET_BYTES = 8 * 1024 * 1024;
export const MAX_NODE_RUNTIME_BYTES = 64 * 1024 * 1024;
// Node is shipped inside the Runmesh installation so the service does not
// depend on a host-provided Node/npm installation.  These are the official
// Node distribution archive digests for the supported desktop/server targets.
export const FIXED_NODE_RUNTIME_ASSETS = {
  "linux-x64": { archive: `node-v${FIXED_NODE_VERSION}-linux-x64.tar.gz`, sha256: "b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a" },
  "linux-arm64": { archive: `node-v${FIXED_NODE_VERSION}-linux-arm64.tar.gz`, sha256: "013b59cfd2819703a6f4a14ab891fc46fc2a4e3f5bcd92de3fb4929b43e35b30" },
  "darwin-x64": { archive: `node-v${FIXED_NODE_VERSION}-darwin-x64.tar.gz`, sha256: "58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026" },
  "darwin-arm64": { archive: `node-v${FIXED_NODE_VERSION}-darwin-arm64.tar.gz`, sha256: "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6" },
  "win-x64": { archive: `node-v${FIXED_NODE_VERSION}-win-x64.zip`, sha256: "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97" },
  "win-arm64": { archive: `node-v${FIXED_NODE_VERSION}-win-arm64.zip`, sha256: "fec025a6da31757e3b6af84c5a1628e9d38442ca99a2161091d78f2fcfa35ef3" },
} as const;


/** Only this exact acknowledgement enables the immutable source-pinned release. */
export function signedReleaseIsAvailable(value: string | undefined): boolean {
  return value === FIXED_RELEASE_VERSION;
}

export function fixedReleaseDescriptor(available: boolean): FixedReleaseDescriptor {
  if (!available) return {
    channel: FIXED_RELEASE_CHANNEL, distributable: false, current_version: "", latest_version: "", package_name: "", package_version: "", package_spec: "", artifact: null, artifacts: null,
    manifest_url: null, signature_url: null, signature_descriptor_url: null, checksums_url: null, release_key_id: null, published_at: null,
  };
  return {
    channel: FIXED_RELEASE_CHANNEL, distributable: true, current_version: FIXED_RELEASE_VERSION, latest_version: FIXED_RELEASE_VERSION,
    package_name: "@aloneio/runmesh-runner", package_version: FIXED_RELEASE_VERSION, package_spec: FIXED_ARTIFACT_URL,
    artifact: { source: FIXED_ARTIFACT_URL }, artifacts: null, manifest_url: FIXED_MANIFEST_URL,
    signature_url: FIXED_SIGNATURE_URL, signature_descriptor_url: FIXED_SIGNATURE_DESCRIPTOR_URL,
    checksums_url: FIXED_CHECKSUMS_URL, release_key_id: FIXED_RELEASE_KEY_ID, published_at: null,
  };
}

/**
 * GitHub currently serves release assets from one of these HTTPS origins after
 * the fixed release URL redirects.  Keep this list deliberately finite: a
 * redirect to an arbitrary HTTPS endpoint must not turn the installer into an
 * SSRF/download oracle, even though the detached signature would eventually
 * reject a tampered artifact.
 */
export const FIXED_RELEASE_ALLOWED_REDIRECT_ORIGINS = [
  "https://github.com",
  "https://objects.githubusercontent.com",
  "https://release-assets.githubusercontent.com",
  "https://github-releases.githubusercontent.com",
  "https://github-cloud.s3.amazonaws.com",
] as const;
