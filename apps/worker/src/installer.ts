/**
 * Fixed, source-reviewed hosted-bootstrap contract. The Worker HTTPS endpoint
 * that serves an installer is the one-command bootstrap trust root. Release
 * assets are authenticated with this embedded key; a downloaded keyring is
 * never fetched or used by an installer.
 */
export const FIXED_RELEASE_VERSION = "0.1.0-dev.3";
export const FIXED_NODE_VERSION = "22.19.0";
export const FIXED_NODE_BASE_URL = `https://nodejs.org/dist/v${FIXED_NODE_VERSION}`;
export const FIXED_RELEASE_KEY_ID = "runmesh-preview-2026-01";
export const FIXED_RELEASE_PUBLIC_KEY_PEM = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEASXdEYS7UorlzNJ8ij2gftFIX2rrTvhNlZm3MqE/BWXI=\n-----END PUBLIC KEY-----\n";
export const FIXED_RELEASE_TAG = `v${FIXED_RELEASE_VERSION}`;
export const FIXED_ARTIFACT_NAME = `runmesh-runner-${FIXED_RELEASE_VERSION}.tgz`;
export const FIXED_RELEASE_BASE_URL = `https://github.com/aloneio/runmesh/releases/download/${FIXED_RELEASE_TAG}`;
export const FIXED_ARTIFACT_URL = `${FIXED_RELEASE_BASE_URL}/${FIXED_ARTIFACT_NAME}`;
export const FIXED_MANIFEST_URL = `${FIXED_RELEASE_BASE_URL}/manifest.json`;
export const FIXED_SIGNATURE_URL = `${FIXED_RELEASE_BASE_URL}/manifest.sig`;
export const FIXED_SIGNATURE_DESCRIPTOR_URL = `${FIXED_RELEASE_BASE_URL}/manifest.signature.json`;
export const FIXED_CHECKSUMS_URL = `${FIXED_RELEASE_BASE_URL}/SHA256SUMS`;

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
  "linux-x64": { archive: `node-v${FIXED_NODE_VERSION}-linux-x64.tar.xz`, sha256: "c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2" },
  "linux-arm64": { archive: `node-v${FIXED_NODE_VERSION}-linux-arm64.tar.xz`, sha256: "0b2d9f564b6594222a62c82e1df2efe119dd4a4aff29644f4dd325bf360b6bcc" },
  "darwin-x64": { archive: `node-v${FIXED_NODE_VERSION}-darwin-x64.tar.xz`, sha256: "41796082f45db51738d1902cae84fa4f699ff6d2550321361424e8bfe6ea1939" },
  "darwin-arm64": { archive: `node-v${FIXED_NODE_VERSION}-darwin-arm64.tar.xz`, sha256: "1c3a9e78da501bbc1f0c99fbbb69bb7c722bc7a9bf30128b21ea502f3905892a" },
  "win-x64": { archive: `node-v${FIXED_NODE_VERSION}-win-x64.zip`, sha256: "ea3fad0e67a991d8477d8c01344b56e69c676ccb733f065b22436994b1253f86" },
  "win-arm64": { archive: `node-v${FIXED_NODE_VERSION}-win-arm64.zip`, sha256: "e4a7336010d58ff35b53d9dd5869095c56089c70913cf22508cf8183593e56b2" },
} as const;

export interface FixedReleaseDescriptor {
  readonly channel: "dev";
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

/** Only this exact acknowledgement enables the immutable source-pinned release. */
export function signedReleaseIsAvailable(value: string | undefined): boolean {
  return value === FIXED_RELEASE_VERSION;
}

export function fixedReleaseDescriptor(available: boolean): FixedReleaseDescriptor {
  if (!available) return {
    channel: "dev", distributable: false, current_version: "", latest_version: "", package_name: "", package_version: "", package_spec: "", artifact: null, artifacts: null,
    manifest_url: null, signature_url: null, signature_descriptor_url: null, checksums_url: null, release_key_id: null, published_at: null,
  };
  return {
    channel: "dev", distributable: true, current_version: FIXED_RELEASE_VERSION, latest_version: FIXED_RELEASE_VERSION,
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

const ORIGIN_MAX_LENGTH = 2_048;
const DNS_LABEL = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)$/;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^\[[0-9A-Fa-f:.]+\]$/;

function safeHostname(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > 253 || hostname.endsWith(".")) return false;
  if (IPV6.test(hostname)) return hostname.includes(":") && hostname.length <= 127;
  if (IPV4.test(hostname)) return hostname.split(".").every((part) => Number(part) <= 255);
  return hostname.split(".").every((label) => DNS_LABEL.test(label));
}

/**
 * Parse and canonicalize a public HTTPS origin supplied by deployment config
 * or a request.  WHATWG URL parsing intentionally accepts several characters
 * in host strings (for example `https://x.test';id;#`); those characters are
 * not valid in a deployment authority and would be dangerous when copied into
 * shell/PowerShell templates, so validate the normalized hostname as well as
 * the URL components.
 */
export function canonicalPublicOrigin(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > ORIGIN_MAX_LENGTH || /[\u0000-\u0020\u007f\\%?#]/.test(value)) {
    throw new Error("installer origin is malformed");
  }
  // An origin is not a path.  Permit the conventional trailing slash, but do
  // not silently discard a path supplied by a proxy or environment variable.
  if (!/^https:\/\/[^/]+\/?$/i.test(value)) throw new Error("installer origin must be an HTTPS origin");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("installer origin is malformed"); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "" || !safeHostname(url.hostname)) {
    throw new Error("installer origin must be HTTPS without credentials, path, query, or fragment");
  }
  if (url.port !== "" && (!/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65_535)) throw new Error("installer origin has an invalid port");
  return url.origin;
}

/**
 * Resolve the origin that may be embedded in a hosted installer. A configured
 * RUNMESH_PUBLIC_ORIGIN remains the canonical fallback, while a valid HTTPS
 * request whose URL and Host agree is also accepted as the active custom
 * Worker domain. This lets Cloudflare custom domains work without adding each
 * hostname to a deployment variable. Throwing is intentional so callers can
 * return a generic 400/421 response rather than rendering a script from
 * attacker-controlled authority data.
 */
export function resolvePublicOrigin(request: Request, configuredOrigin?: string): string {
  let requestUrl: URL;
  try { requestUrl = new URL(request.url); } catch { throw new Error("request URL is malformed"); }
  // A configured public origin may be used behind an internal HTTP reverse
  // proxy. The request authority is still checked via Host when available,
  // but its scheme is never copied into a generated public URL.
  if (requestUrl.username !== "" || requestUrl.password !== "") throw new Error("request URL must not contain credentials");
  const configured = configuredOrigin === undefined ? undefined : canonicalPublicOrigin(configuredOrigin);
  const hostHeader = request.headers.get("host");
  const hostOrigin = hostHeader === null ? undefined : canonicalPublicOrigin(`https://${hostHeader}`);
  let requestOrigin: string | undefined;
  try { requestOrigin = requestUrl.protocol === "https:" ? canonicalPublicOrigin(requestUrl.origin) : undefined; } catch { requestOrigin = undefined; }
  if (configured !== undefined) {
    // A reverse proxy may expose an internal request URL while preserving the
    // configured public Host. Keep that supported.
    if (hostOrigin === configured) return configured;
    // Cloudflare supplies the routed hostname in both the request URL and
    // Host. Treat that matching HTTPS authority as the active custom domain.
    if (requestOrigin !== undefined && hostOrigin === requestOrigin) return requestOrigin;
    throw new Error("request Host does not match a configured or routed public origin");
  }
  if (requestOrigin === undefined) throw new Error("request origin is not a valid public HTTPS origin");
  if (hostOrigin !== undefined && hostOrigin !== requestOrigin) throw new Error("request Host does not match the request origin");
  return requestOrigin;
}

function shellLiteral(value: string): string {
  if (value.includes("\u0000")) throw new Error("cannot quote NUL in a shell literal");
  // Close/open single quotes around an embedded quote.  This is the standard
  // POSIX form: 'one'"'"'two'. Newlines and metacharacters remain data.
  return value.replaceAll("'", "'\"'\"'");
}

function powershellLiteral(value: string): string {
  if (value.includes("\u0000")) throw new Error("cannot quote NUL in a PowerShell literal");
  return value.replaceAll("'", "''");
}

/** Quote one argv/string literal for a POSIX shell command snippet. */
export function shellQuote(value: string): string { return `'${shellLiteral(value)}'`; }

/** Quote one string literal for a PowerShell command snippet. */
export function powershellQuote(value: string): string { return `'${powershellLiteral(value)}'`; }

/* This source deliberately has no trust-keyring download. */
const VERIFY_RELEASE = String.raw`import { createHash, createPublicKey, verify } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
const directory = process.argv[2];
const version = "__VERSION__";
const keyId = "__KEY_ID__";
const artifactName = "__ARTIFACT_NAME__";
const artifactUrl = "__ARTIFACT_URL__";
const publicKeyPem = __PUBLIC_KEY_PEM__;
const maxReleaseAssetBytes = __MAX_RELEASE_ASSET_BYTES__;
const fail = (message) => { throw new Error("release verification failed: " + message); };
const boundedRead = async (name, encoding) => {
  const path = join(directory, name);
  let handle;
  try { handle = await open(path, "r"); } catch { fail("invalid " + name); }
  try {
    const metadata = await handle.stat().catch(() => fail("invalid " + name));
    if (!metadata.isFile() || !Number.isSafeInteger(metadata.size) || metadata.size <= 0) fail("invalid " + name);
    if (metadata.size > maxReleaseAssetBytes) fail(name + " exceeds the fixed size limit");
    const chunks = [];
    let total = 0;
    while (total <= maxReleaseAssetBytes) {
      // Read at most one byte past the cap so growth after stat cannot cause
      // an unbounded allocation before the size check runs.
      const remaining = maxReleaseAssetBytes + 1 - total;
      const chunk = Buffer.allocUnsafe(Math.min(65536, remaining));
      const result = await handle.read(chunk, 0, chunk.byteLength, null).catch(() => fail("invalid " + name));
      if (result.bytesRead === 0) break;
      chunks.push(result.bytesRead === chunk.byteLength ? chunk : chunk.subarray(0, result.bytesRead));
      total += result.bytesRead;
      if (total > maxReleaseAssetBytes) fail(name + " exceeds the fixed size limit");
    }
    // Re-stat the same descriptor after EOF as well. An append that lands
    // immediately after the final read would otherwise evade the initial
    // size check even though the path was held open safely throughout.
    const finalMetadata = await handle.stat().catch(() => fail("invalid " + name));
    if (!finalMetadata.isFile() || !Number.isSafeInteger(finalMetadata.size) || finalMetadata.size <= 0) fail(name + " changed while being read");
    if (finalMetadata.size > maxReleaseAssetBytes) fail(name + " exceeds the fixed size limit");
    if (total !== metadata.size || total !== finalMetadata.size) fail(name + " changed while being read");
    const bytes = Buffer.concat(chunks, total);
    return encoding === undefined ? bytes : bytes.toString(encoding);
  } finally { await handle.close().catch(() => {}); }
};
const parseBytes = (name, bytes) => { try { return JSON.parse(bytes.toString("utf8")); } catch { fail("invalid " + name); } };
const manifestBytes = await boundedRead("manifest.json");
const descriptor = parseBytes("manifest.signature.json", await boundedRead("manifest.signature.json"));
if (descriptor?.schema_version !== 1 || descriptor.algorithm !== "ed25519" || descriptor.key_id !== keyId || descriptor.encoding !== "base64" || descriptor.signed_file !== "manifest.json") fail("invalid signature descriptor");
const encodedSignature = (await boundedRead("manifest.sig", "utf8")).trim();
if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encodedSignature)) fail("signature is not canonical base64");
const signature = Buffer.from(encodedSignature, "base64");
if (signature.length !== 64 || signature.toString("base64") !== encodedSignature || !verify(null, manifestBytes, createPublicKey(publicKeyPem), signature)) fail("signature does not verify");
const manifest = parseBytes("manifest.json", manifestBytes);
const artifact = Array.isArray(manifest?.artifacts) && manifest.artifacts.length === 1 ? manifest.artifacts[0] : undefined;
if (manifest?.schema_version !== 1 || manifest.project !== "runmesh" || manifest.version !== version || manifest.tag !== "v" + version || manifest.channel !== "dev" || manifest.prerelease !== true || !/^[0-9a-f]{40}$/.test(manifest.commit_sha) || manifest.protocol_min !== 2 || manifest.protocol_max !== 2 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(manifest.published_at)) fail("manifest fields are not the fixed preview contract");
if (artifact?.name !== artifactName || artifact.platform !== "node" || artifact.architecture !== "portable" || artifact.node_major_min !== 20 || artifact.url !== artifactUrl || !Number.isSafeInteger(artifact.size) || artifact.size <= 0 || artifact.size > maxReleaseAssetBytes || !/^[0-9a-f]{64}$/.test(artifact.sha256)) fail("manifest artifact is invalid");
const artifactBytes = await boundedRead(artifactName);
const digest = createHash("sha256").update(artifactBytes).digest("hex");
if (artifactBytes.byteLength !== artifact.size || digest !== artifact.sha256) fail("artifact size or SHA-256 mismatch");
const sums = await boundedRead("SHA256SUMS", "utf8");
if (!sums.split(/\r?\n/).some((line) => line === digest + "  " + artifactName || line === digest + " *" + artifactName)) fail("SHA256SUMS does not match authenticated artifact");
`;

function verifierSource(): string {
  return VERIFY_RELEASE
    .replaceAll("__VERSION__", FIXED_RELEASE_VERSION)
    .replaceAll("__KEY_ID__", FIXED_RELEASE_KEY_ID)
    .replaceAll("__ARTIFACT_NAME__", FIXED_ARTIFACT_NAME)
    .replaceAll("__ARTIFACT_URL__", FIXED_ARTIFACT_URL)
    .replaceAll("__MAX_RELEASE_ASSET_BYTES__", String(MAX_RELEASE_ASSET_BYTES))
    .replace("__PUBLIC_KEY_PEM__", JSON.stringify(FIXED_RELEASE_PUBLIC_KEY_PEM));
}

const POSIX_TEMPLATE = String.raw`#!/usr/bin/env sh
# Fixed signed Runmesh preview bootstrap. This Worker HTTPS response is the
# bootstrap trust root. This script verifies the GitHub artifact with its
# embedded Ed25519 public key and never trusts a downloaded keyring.
set -eu
umask 077
if [ -t 2 ] && [ -z "\${NO_COLOR:-}" ]; then C_RESET='\033[0m'; C_CYAN='\033[36m'; C_GREEN='\033[32m'; C_RED='\033[31m'; else C_RESET=''; C_CYAN=''; C_GREEN=''; C_RED=''; fi
step() { printf '%b→%b %s\n' "$C_CYAN" "$C_RESET" "$1" >&2; }
ok() { printf '%b✓%b %s\n' "$C_GREEN" "$C_RESET" "$1" >&2; }
fail() { printf '%b✗%b %s\n' "$C_RED" "$C_RESET" "$1" >&2; }
report_failure() {
  label="$1"
  log_file="$2"
  rc="$3"
  fail "$label"
  printf '%s\n' "  exit code: $rc" >&2
  if [ -s "$log_file" ]; then
    printf '%s\n' '  output:' >&2
    sed 's/^/  │ /' "$log_file" >&2
  fi
  rm -f "$log_file"
}
printf '\n%bRunmesh%b  Runner installer\n\n' "$C_CYAN" "$C_RESET" >&2
# Do not let inherited runtime/package-manager configuration alter a privileged
# install. The operator's PATH is still required to point at trusted binaries.
unset NODE_OPTIONS NODE_PATH CURL_HOME CURLRC NPM_CONFIG_USERCONFIG NPM_CONFIG_GLOBALCONFIG npm_config_userconfig npm_config_globalconfig 2>/dev/null || true
VERSION='__VERSION__'
RELEASE_BASE='__RELEASE_BASE__'
ARTIFACT='__ARTIFACT_NAME__'
ENROLLMENT_URL='__ENROLLMENT_URL__'
INSTALL_ROOT='/opt/runmesh'
AUTO_INSTALL_DEPS=1
ENROLLMENT_CODE_ARG=''
EXPECT_CODE_ARG=0
for arg in "$@"; do
  case "$arg" in
    --no-auto-deps) AUTO_INSTALL_DEPS=0 ;;
    --code) EXPECT_CODE_ARG=1 ;;
    --code=*) ENROLLMENT_CODE_ARG="$(printf '%s' "$arg" | sed 's/^--code=//')" ;;
    install|--auto-deps|--re-enroll) : ;;
    *)
      if [ "$EXPECT_CODE_ARG" -eq 1 ]; then
        ENROLLMENT_CODE_ARG="$arg"
        EXPECT_CODE_ARG=0
      elif [ -z "$ENROLLMENT_CODE_ARG" ]; then
        ENROLLMENT_CODE_ARG="$arg"
      fi
      ;;
  esac
done
if [ "$EXPECT_CODE_ARG" -eq 1 ]; then printf '%s\n' 'error: --code requires the one-time enrollment code' >&2; exit 1; fi
if [ -n "$ENROLLMENT_CODE_ARG" ]; then
  case "$ENROLLMENT_CODE_ARG" in
    *[!A-Za-z0-9_-]*) printf '%s\n' 'error: invalid one-time enrollment code' >&2; exit 1 ;;
  esac
  [ "$(printf '%s' "$ENROLLMENT_CODE_ARG" | wc -c | tr -d '[:space:]')" -eq 43 ] || { printf '%s\n' 'error: invalid one-time enrollment code' >&2; exit 1; }
fi
if [ "$(id -u)" -ne 0 ]; then printf '%s\n' 'error: run from an elevated root shell' >&2; exit 1; fi
case "$(uname -s)" in
  Linux) PROFILE='/etc/runmesh/profile.json'; SERVICE_MANIFEST='/etc/systemd/system/runmesh-runner.service' ;;
  Darwin) PROFILE='/Library/Application Support/Runmesh/profile.json'; SERVICE_MANIFEST='/Library/LaunchDaemons/io.alone.runmesh.runner.plist' ;;
  *) printf '%s\n' 'error: Linux or macOS is required' >&2; exit 1;;
esac
for command_name in curl stty readlink grep tar mktemp sed wc tr; do command -v "$command_name" >/dev/null 2>&1 || { printf '%s\n' "error: $command_name is required" >&2; exit 1; }; done
case "$(uname -s):$(uname -m)" in
  Linux:x86_64|Linux:amd64) NODE_ASSET='__NODE_LINUX_X64__'; NODE_SHA256='__NODE_LINUX_X64_SHA256__' ;;
  Linux:aarch64|Linux:arm64) NODE_ASSET='__NODE_LINUX_ARM64__'; NODE_SHA256='__NODE_LINUX_ARM64_SHA256__' ;;
  Darwin:x86_64) NODE_ASSET='__NODE_DARWIN_X64__'; NODE_SHA256='__NODE_DARWIN_X64_SHA256__' ;;
  Darwin:arm64) NODE_ASSET='__NODE_DARWIN_ARM64__'; NODE_SHA256='__NODE_DARWIN_ARM64_SHA256__' ;;
  *) printf '%s\n' 'error: unsupported operating system or CPU architecture' >&2; exit 1;;
esac
NODE_BASE='__NODE_BASE_URL__'
[ "$AUTO_INSTALL_DEPS" -eq 1 ] || { printf '%s\n' 'error: private runtime bootstrap is disabled (--no-auto-deps).' >&2; exit 1; }
has_path() { [ -e "$1" ] || [ -L "$1" ]; }
refresh_existing() {
  if ! has_path "$INSTALL_ROOT/current"; then return 1; fi
  [ -L "$INSTALL_ROOT/current" ] || { printf '%s\n' 'error: existing Runmesh path is not a managed current link' >&2; exit 1; }
  CURRENT_TARGET="$(readlink "$INSTALL_ROOT/current")"
  case "$CURRENT_TARGET" in
    "$INSTALL_ROOT"/versions/*) : ;;
    *) printf '%s\n' 'error: existing Runmesh current link is outside the managed Runmesh versions directory' >&2; exit 1 ;;
  esac
  EXISTING_RUNNER="$INSTALL_ROOT/current/bin/runmesh"
  [ -x "$EXISTING_RUNNER" ] || { printf '%s\n' 'error: existing Runmesh installation is incomplete; restore it or remove it with runmesh uninstall before retrying' >&2; exit 1; }
  [ -f "$PROFILE" ] && [ -f "$SERVICE_MANIFEST" ] || { printf '%s\n' 'error: existing Runmesh installation is incomplete; restore it or remove it with runmesh uninstall before retrying' >&2; exit 1; }
  grep -F 'runmesh-runner-managed:' "$SERVICE_MANIFEST" >/dev/null 2>&1 || { printf '%s\n' 'error: existing service is not managed by Runmesh; refusing to modify it' >&2; exit 1; }
  REFRESH_LOCK="$INSTALL_ROOT/.refresh.lock"
  if ! mkdir "$REFRESH_LOCK" 2>/dev/null; then printf '%s\n' 'error: another Runmesh enrollment refresh is already running' >&2; exit 1; fi
  REFRESH_INPUT="$INSTALL_ROOT/.refresh-code.$$"
  trap 'rm -f "$REFRESH_INPUT" 2>/dev/null || true; rmdir "$REFRESH_LOCK" 2>/dev/null || true' EXIT HUP INT TERM
  step 'Refreshing credentials for the existing Runmesh Runner.'
  if [ -n "$ENROLLMENT_CODE_ARG" ]; then ENROLLMENT_CODE="$ENROLLMENT_CODE_ARG"; unset ENROLLMENT_CODE_ARG
  else
    printf '%s' 'Paste the one-time enrollment code (input is hidden): ' >/dev/tty
    stty -echo < /dev/tty || { printf '%s\n' 'error: terminal input cannot be protected' >&2; exit 1; }
    TTY_ECHO_DISABLED=1
    IFS= read -r ENROLLMENT_CODE < /dev/tty || { stty echo < /dev/tty 2>/dev/null || true; printf '\n%s\n' 'error: unable to read enrollment code from terminal' >&2; exit 1; }
    stty echo < /dev/tty 2>/dev/null || true; TTY_ECHO_DISABLED=0; printf '\n' >/dev/tty
  fi
  case "$ENROLLMENT_CODE" in *[!A-Za-z0-9_-]*) printf '%s\n' 'error: invalid one-time enrollment code' >&2; exit 1;; esac
  printf '%s\n' "$ENROLLMENT_CODE" > "$REFRESH_INPUT"
  REFRESH_CODE_LENGTH="$(wc -c < "$REFRESH_INPUT" | tr -d '[:space:]')"
  [ "$REFRESH_CODE_LENGTH" -eq 44 ] || { printf '%s\n' 'error: invalid one-time enrollment code' >&2; exit 1; }
  unset ENROLLMENT_CODE
  REFRESH_ENROLL_LOG="$INSTALL_ROOT/.refresh-enroll.$$.log"
  if "$EXISTING_RUNNER" enroll --profile "$PROFILE" --server "$ENROLLMENT_URL" --code-stdin --re-enroll < "$REFRESH_INPUT" >"$REFRESH_ENROLL_LOG" 2>&1; then :; else rc=$?; report_failure 'Refreshing credentials for the existing Runmesh Runner.' "$REFRESH_ENROLL_LOG" "$rc"; exit "$rc"; fi
  rm -f "$REFRESH_INPUT"; REFRESH_INPUT=''
  REFRESH_INSTALL_LOG="$INSTALL_ROOT/.refresh-install.$$.log"
  if "$EXISTING_RUNNER" install --profile "$PROFILE" --execution-mode privileged_host --confirm-privileged-host --executable-path "$EXISTING_RUNNER" >"$REFRESH_INSTALL_LOG" 2>&1; then :; else rc=$?; report_failure 'Refreshing the installed service for the existing Runmesh Runner.' "$REFRESH_INSTALL_LOG" "$rc"; exit "$rc"; fi
  REFRESH_RESTART_LOG="$INSTALL_ROOT/.refresh-restart.$$.log"
  if "$EXISTING_RUNNER" restart --profile "$PROFILE" >"$REFRESH_RESTART_LOG" 2>&1; then :; else rc=$?; report_failure 'Restarting the existing Runmesh Runner service.' "$REFRESH_RESTART_LOG" "$rc"; exit "$rc"; fi
  ok 'Runmesh Runner credentials refreshed and service restarted in place.'
  trap - EXIT HUP INT TERM
  rmdir "$REFRESH_LOCK" 2>/dev/null || true
  return 0
}
if has_path "$INSTALL_ROOT/current" && has_path "$PROFILE" && has_path "$SERVICE_MANIFEST"; then refresh_existing; exit $?; fi
if has_path "$INSTALL_ROOT/current" || has_path "$INSTALL_ROOT/versions/$VERSION" || has_path "$INSTALL_ROOT/versions/$VERSION.staging.$$" || has_path "$PROFILE" || has_path "$SERVICE_MANIFEST"; then printf '%s\n' 'error: existing Runmesh installation or service state found; refusing to overwrite it' >&2; exit 1; fi
TMP="$(mktemp -d /tmp/runmesh-installer.XXXXXX)"
STAGE="$INSTALL_ROOT/versions/$VERSION.staging.$$"
CURRENT_NEW="$INSTALL_ROOT/current.new"
FINAL="$INSTALL_ROOT/versions/$VERSION"
RUNTIME_ARCHIVE="$TMP/$NODE_ASSET"
RUNTIME_ROOT="$TMP/node-runtime"
mkdir "$RUNTIME_ROOT"
RUNTIME_URL="$NODE_BASE/$NODE_ASSET"
if command -v curl >/dev/null 2>&1; then
  curl -q --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --max-redirs 3 --max-time 120 --max-filesize __MAX_NODE_RUNTIME_BYTES__ --output "$RUNTIME_ARCHIVE" "$RUNTIME_URL"
elif command -v wget >/dev/null 2>&1; then
  wget --https-only --timeout=120 --tries=1 --output-document="$RUNTIME_ARCHIVE" "$RUNTIME_URL"
else
  printf '%s\n' 'error: curl or wget is required to download the private Node.js runtime' >&2
  exit 1
fi
RUNTIME_SIZE="$(wc -c < "$RUNTIME_ARCHIVE" | tr -d '[:space:]')"
case "$RUNTIME_SIZE" in ''|*[!0-9]*) printf '%s\n' 'error: private Node.js runtime archive size is invalid' >&2; exit 1;; esac
[ "$RUNTIME_SIZE" -le __MAX_NODE_RUNTIME_BYTES__ ] || { printf '%s\n' 'error: private Node.js runtime archive exceeds the fixed size limit' >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  printf '%s  %s\n' "$NODE_SHA256" "$RUNTIME_ARCHIVE" | sha256sum -c -
elif command -v shasum >/dev/null 2>&1; then
  test "$(shasum -a 256 "$RUNTIME_ARCHIVE" | awk '{print $1}')" = "$NODE_SHA256"
else
  printf '%s\n' 'error: sha256sum or shasum is required to verify the private Node.js runtime' >&2
  exit 1
fi
tar -xJf "$RUNTIME_ARCHIVE" -C "$RUNTIME_ROOT"
NODE_DIRECTORY="$(printf '%s' "$NODE_ASSET" | sed 's/\.tar\.xz$//')"
NODE_HOME="$RUNTIME_ROOT/$NODE_DIRECTORY"
NODE="$NODE_HOME/bin/node"
NPM_CLI="$NODE_HOME/lib/node_modules/npm/bin/npm-cli.js"
[ -x "$NODE" ] || { printf '%s\n' 'error: private Node.js runtime extraction failed' >&2; exit 1; }
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || { printf '%s\n' 'error: private Node.js runtime is too old' >&2; exit 1; }
# Keep privileged npm completely inside the private temporary directory. npm
# otherwise consults the invoking root user's, global, and current-directory
# npmrc files, any of which could change where or how a package is installed.
NPM_CONFIG_USERCONFIG="$TMP/npm-user.npmrc"
NPM_CONFIG_GLOBALCONFIG="$TMP/npm-global.npmrc"
NPM_CONFIG_CACHE="$TMP/npm-cache"
: > "$NPM_CONFIG_USERCONFIG"
: > "$NPM_CONFIG_GLOBALCONFIG"
mkdir "$NPM_CONFIG_CACHE"
export NPM_CONFIG_USERCONFIG NPM_CONFIG_GLOBALCONFIG NPM_CONFIG_CACHE
export npm_config_userconfig="$NPM_CONFIG_USERCONFIG" npm_config_globalconfig="$NPM_CONFIG_GLOBALCONFIG" npm_config_cache="$NPM_CONFIG_CACHE"
TTY_ECHO_DISABLED=0
FINAL_CREATED=0
CURRENT_CREATED=0
ENROLLMENT_ATTEMPTED=0
# The preflight above rejects an existing profile, so a profile present after
# enrollment belongs to this new attempt and is safe to remove on rollback.
cleanup_tty() { if [ "$TTY_ECHO_DISABLED" -eq 1 ]; then stty echo < /dev/tty 2>/dev/null || true; TTY_ECHO_DISABLED=0; fi; }
cleanup() { cleanup_tty; rm -rf "$TMP"; }
rollback() {
  rc="$1"
  cleanup_tty
  if [ "$CURRENT_CREATED" -eq 1 ] && [ -L "$CURRENT_NEW" ]; then rm -f "$CURRENT_NEW"; fi
  if [ "$CURRENT_CREATED" -eq 1 ] && [ -L "$INSTALL_ROOT/current" ] && [ "$(readlink "$INSTALL_ROOT/current")" = "$FINAL" ]; then "$INSTALL_ROOT/current/bin/runmesh" uninstall --profile "$PROFILE" --purge --yes --json >/dev/null 2>&1 || true; rm -f "$INSTALL_ROOT/current"; fi
  if [ "$ENROLLMENT_ATTEMPTED" -eq 1 ] && [ -f "$PROFILE" ]; then rm -f "$PROFILE"; fi
  if [ -L "$INSTALL_ROOT/current" ] && [ "$(readlink "$INSTALL_ROOT/current")" = "$FINAL" ]; then rm -f "$INSTALL_ROOT/current"; fi
  if [ -L "$CURRENT_NEW" ]; then rm -f "$CURRENT_NEW"; fi
  if [ "$FINAL_CREATED" -eq 1 ]; then rm -rf "$FINAL"; fi
  rm -rf "$STAGE" "$TMP"
  trap - EXIT HUP INT TERM
  exit "$rc"
}
on_exit() {
  rc=$?
  if [ "$rc" -eq 0 ]; then cleanup; else rollback "$rc"; fi
}
trap on_exit EXIT
trap 'rollback 1' HUP INT TERM
# Follow redirects one hop at a time. curl's automatic redirect handling is
# deliberately disabled: every Location is parsed and pinned before a second
# request is made. Signature verification below remains the authority for
# bytes, while this check prevents arbitrary redirect targets and SSRF.
download() {
  name="$1"
  url="$RELEASE_BASE/$name"
  attempt=0
  while :; do
    attempt=$((attempt + 1))
    headers="$TMP/$name.headers"
    status_file="$TMP/$name.status"
    if curl -q --fail --silent --show-error --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 0 --max-redirs 0 --max-filesize __MAX_RELEASE_ASSET_BYTES__ --dump-header "$headers" --output "$TMP/$name" --write-out '%{http_code}' "$url" > "$status_file"; then
      curl_rc=0
    else
      curl_rc=$?
    fi
    status_code=""
    IFS= read -r status_code < "$status_file" || true
    case "$status_code" in
      301|302|303|307|308)
        if [ "$attempt" -ge 6 ]; then printf '%s\n' 'error: release redirect limit exceeded' >&2; exit 1; fi
        url="$("$NODE" --input-type=module - "$headers" "$url" <<'RUNMESH_REDIRECT_CHECK'
import { readFile } from "node:fs/promises";
const [headerPath, current] = process.argv.slice(2);
const headers = await readFile(headerPath, "utf8");
const locations = headers.split(/\r?\n/).filter((line) => /^location\s*:/iu.test(line)).map((line) => line.replace(/^location\s*:/iu, "").trim());
const location = locations.at(-1);
if (location === undefined || location.length === 0 || /[\u0000-\u0020\u007f]/u.test(location)) throw new Error("release redirect Location is invalid");
let next;
try { next = new URL(location, current); } catch { throw new Error("release redirect URL is invalid"); }
const allowed = new Set(__RELEASE_REDIRECT_ORIGINS_JSON__);
if (next.protocol !== "https:" || next.username !== "" || next.password !== "" || !allowed.has(next.origin)) throw new Error("release redirect escaped pinned origins");
process.stdout.write(next.toString());
RUNMESH_REDIRECT_CHECK
)"
        continue
        ;;
      2??)
        if [ "$curl_rc" -ne 0 ]; then printf '%s\n' 'error: release download failed' >&2; exit 1; fi
        if ! "$NODE" -e '
          const { statSync } = require("node:fs");
          const metadata = statSync(process.argv[1]);
          if (!metadata.isFile() || metadata.size <= 0 || metadata.size > __MAX_RELEASE_ASSET_BYTES__) process.exit(1);
        ' "$TMP/$name"; then
          printf '%s\n' 'error: release asset exceeds the fixed size limit' >&2
          exit 1
        fi
        rm -f "$headers" "$status_file"
        break
        ;;
      *)
        printf '%s\n' 'error: release download returned an unexpected status' >&2
        exit 1
        ;;
    esac
  done
}
step 'Downloading the fixed release assets.'
download manifest.json
download manifest.sig
download manifest.signature.json
download SHA256SUMS
download "$ARTIFACT"
step 'Verifying the signed release assets.'
VERIFY_LOG="$TMP/release-verify.log"
if "$NODE" --input-type=module - "$TMP" >"$VERIFY_LOG" 2>&1 <<'RUNMESH_VERIFY'
__VERIFIER__
RUNMESH_VERIFY
then :; else rc=$?; report_failure 'Verifying the signed release assets.' "$VERIFY_LOG" "$rc"; exit "$rc"; fi
ok 'Signed release assets verified.'
mkdir -p "$INSTALL_ROOT/versions"
if ! mkdir "$STAGE"; then printf '%s\n' 'error: installer staging path is already in use' >&2; exit 1; fi
step 'Installing the verified Runner package.'
export NPM_CONFIG_UPDATE_NOTIFIER=false
INSTALL_LOG="$TMP/npm-install.log"
if (
  cd "$TMP"
  "$NODE" "$NPM_CLI" --userconfig "$NPM_CONFIG_USERCONFIG" --globalconfig "$NPM_CONFIG_GLOBALCONFIG" install --global --ignore-scripts --offline --no-audit --no-fund --prefix "$STAGE" "$TMP/$ARTIFACT"
)> "$INSTALL_LOG" 2>&1; then :; else rc=$?; report_failure 'Installing the verified Runner package.' "$INSTALL_LOG" "$rc"; exit "$rc"; fi
ok 'Verified Runner package installed.'
PACKAGE_ROOT="$STAGE/lib/node_modules/@aloneio/runmesh-runner"
BUNDLE_FILENAME='runmesh.cjs'
[ -f "$PACKAGE_ROOT/dist/$BUNDLE_FILENAME" ] || { fail 'The verified Runmesh package is missing its Runner bundle.'; exit 1; }
mkdir -p "$STAGE/runtime"
cp "$NODE" "$STAGE/runtime/node"
chmod 0755 "$STAGE/runtime/node"
RUNNER="$STAGE/bin/runmesh"
RUNMESH_RUNNER="$STAGE/bin/runmesh-runner"
# npm creates POSIX bin entries as symlinks into the package's dist directory.
# Remove those links before writing our private-runtime wrappers; redirecting
# cat through the links would overwrite the verified Runner bundle with shell code.
rm -f "$RUNNER" "$RUNMESH_RUNNER"
cat > "$RUNNER" <<RUNMESH_RUNNER_SH
#!/bin/sh
ROOT=\$(CDPATH= cd -- "\$(dirname -- "\$0")" && pwd)
exec "\$ROOT/../runtime/node" "\$ROOT/../lib/node_modules/@aloneio/runmesh-runner/dist/$BUNDLE_FILENAME" "\$@"
RUNMESH_RUNNER_SH
cat > "$RUNMESH_RUNNER" <<RUNMESH_RUNNER_SH
#!/bin/sh
ROOT=\$(CDPATH= cd -- "\$(dirname -- "\$0")" && pwd)
exec "\$ROOT/../runtime/node" "\$ROOT/../lib/node_modules/@aloneio/runmesh-runner/dist/$BUNDLE_FILENAME" "\$@"
RUNMESH_RUNNER_SH
chmod 0755 "$RUNNER" "$RUNMESH_RUNNER"
[ "$("$RUNNER" --version)" = "$VERSION" ] || { printf '%s\n' 'error: installed runmesh version mismatch' >&2; exit 1; }
[ "$("$RUNMESH_RUNNER" --version)" = "$VERSION" ] || { printf '%s\n' 'error: installed runmesh-runner version mismatch' >&2; exit 1; }
"$RUNNER" --help | grep -F 'usage: runmesh-runner' >/dev/null
"$RUNMESH_RUNNER" --help | grep -F 'usage: runmesh-runner' >/dev/null
if [ -n "$ENROLLMENT_CODE_ARG" ]; then
  ENROLLMENT_CODE="$ENROLLMENT_CODE_ARG"
  unset ENROLLMENT_CODE_ARG
else
  printf '%s' 'Paste the one-time enrollment code (input is hidden): ' >/dev/tty
  stty -echo < /dev/tty || { printf '%s\n' 'error: terminal input cannot be protected' >&2; exit 1; }
  TTY_ECHO_DISABLED=1
  if ! IFS= read -r ENROLLMENT_CODE < /dev/tty; then printf '\n%s\n' 'error: unable to read enrollment code from terminal' >&2; exit 1; fi
  cleanup_tty
  printf '\n' >/dev/tty
fi
ENROLLMENT_INPUT="$TMP/enrollment-code"
printf '%s\n' "$ENROLLMENT_CODE" > "$ENROLLMENT_INPUT"
unset ENROLLMENT_CODE
ENROLLMENT_ATTEMPTED=1
step 'Enrolling the Runner and starting the service.'
ENROLL_LOG="$TMP/enroll.log"
if "$RUNNER" enroll --profile "$PROFILE" --server "$ENROLLMENT_URL" --code-stdin --execution-mode privileged_host --confirm-privileged-host < "$ENROLLMENT_INPUT" >"$ENROLL_LOG" 2>&1; then :; else rc=$?; report_failure 'Enrolling the Runner.' "$ENROLL_LOG" "$rc"; exit "$rc"; fi
rm -f "$ENROLLMENT_INPUT"
mv "$STAGE" "$FINAL"
FINAL_CREATED=1
ln -s "$FINAL" "$INSTALL_ROOT/current.new"
mv "$INSTALL_ROOT/current.new" "$INSTALL_ROOT/current"
CURRENT_CREATED=1
SERVICE_LOG="$TMP/service-install.log"
if "$INSTALL_ROOT/current/bin/runmesh" install --profile "$PROFILE" --execution-mode privileged_host --confirm-privileged-host --executable-path "$INSTALL_ROOT/current/bin/runmesh" >"$SERVICE_LOG" 2>&1; then :; else rc=$?; report_failure 'Installing the Runmesh service.' "$SERVICE_LOG" "$rc"; exit "$rc"; fi
ok "Runmesh Runner $VERSION installed and enrolled."
printf '%s\n' '  Service started automatically.' '  Logs: sudo journalctl -u runmesh-runner -f' >&2
`;

const POWERSHELL_TEMPLATE = String.raw`$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# Ignore inherited Node/npm/curl configuration and resolve only real executable
# commands. The operator's PATH must still be trusted on the host.
$env:NODE_OPTIONS = $null
$env:NODE_PATH = $null
$env:CURL_HOME = $null
$env:CURLRC = $null
$env:NPM_CONFIG_USERCONFIG = $null
$env:NPM_CONFIG_GLOBALCONFIG = $null
$env:NPM_CONFIG_CACHE = $null
$env:npm_config_userconfig = $null
$env:npm_config_globalconfig = $null
$env:npm_config_cache = $null
# Windows PowerShell 5.1 does not eagerly load System.Net.Http. Load it
# explicitly before constructing HttpClientHandler so the fixed installer has
# the same pre-follow redirect guarantees on PowerShell 5.1 and 7+.
Add-Type -AssemblyName System.Net.Http
# This Worker HTTPS response is the bootstrap trust root. Release assets are
# verified with the embedded Ed25519 key below, never a downloaded keyring.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Version = '__VERSION__'
$ReleaseBase = '__RELEASE_BASE__'
$ArtifactName = '__ARTIFACT_NAME__'
$EnrollmentUrl = '__ENROLLMENT_URL__'
$AllowedReleaseOrigins = @(__RELEASE_REDIRECT_ORIGINS_PS__)
$AutoInstallDeps = $true
if ($args -contains '--no-auto-deps') { $AutoInstallDeps = $false }
if (-not $AutoInstallDeps) { throw 'Private runtime bootstrap is disabled (--no-auto-deps).' }
$EnrollmentCodeArgument = $null
$ExpectCodeArgument = $false
foreach ($Argument in $args) {
  if ($ExpectCodeArgument) { $EnrollmentCodeArgument = [string]$Argument; $ExpectCodeArgument = $false; continue }
  if ($Argument -eq '--code') { $ExpectCodeArgument = $true; continue }
  if ($Argument -like '--code=*') { $EnrollmentCodeArgument = [string]$Argument.Substring(7); continue }
  if ($Argument -eq 'install' -or $Argument -eq '--auto-deps' -or $Argument -eq '--no-auto-deps' -or $Argument -eq '--re-enroll') { continue }
  if ($null -eq $EnrollmentCodeArgument) { $EnrollmentCodeArgument = [string]$Argument }
}
if ($ExpectCodeArgument) { throw '--code requires the one-time enrollment code.' }
if ($null -ne $EnrollmentCodeArgument -and $EnrollmentCodeArgument -notmatch '^[A-Za-z0-9_-]{43}$') { throw 'Invalid one-time enrollment code.' }
$InstallRoot = Join-Path $env:ProgramFiles 'Runmesh'
$Principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run from an elevated Administrator PowerShell session.' }
$NodeAsset = if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq [Runtime.InteropServices.Architecture]::Arm64) { '__NODE_WIN_ARM64__' } else { '__NODE_WIN_X64__' }
$NodeSha256 = if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq [Runtime.InteropServices.Architecture]::Arm64) { '__NODE_WIN_ARM64_SHA256__' } else { '__NODE_WIN_X64_SHA256__' }
$NodeUrl = '__NODE_BASE_URL__/' + $NodeAsset
$crlf = [Environment]::NewLine
$dq = [char]34
$VersionsRoot = Join-Path $InstallRoot 'versions'
$VersionRoot = Join-Path $VersionsRoot $Version
$Stage = Join-Path $VersionsRoot ($Version + '.staging.' + $PID)
$CurrentRoot = Join-Path $InstallRoot 'current'
$CurrentNew = Join-Path $InstallRoot 'current.new'
$Profile = Join-Path $env:ProgramData 'Runmesh\profile.json'
$ServiceManifest = Join-Path $env:ProgramData 'Runmesh\RunmeshRunner.xml'
function Write-Step([string]$Message) { Write-Host ("→ {0}" -f $Message) -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host ("✓ {0}" -f $Message) -ForegroundColor Green }
function Write-Fail([string]$Message) { Write-Host ("✗ {0}" -f $Message) -ForegroundColor Red }
function Write-LogFailure([string]$Message, [string]$LogPath, [int]$ExitCode, $ErrorRecord = $null) {
  Write-Fail $Message
  Write-Host ("  exit code: {0}" -f $ExitCode) -ForegroundColor DarkGray
  if ($null -ne $ErrorRecord) {
    Write-Host ("  exception: {0}" -f $ErrorRecord.Exception.GetType().FullName) -ForegroundColor DarkGray
    Write-Host ("  message: {0}" -f $ErrorRecord.Exception.Message) -ForegroundColor DarkGray
    if ($ErrorRecord.InvocationInfo -and $ErrorRecord.InvocationInfo.PositionMessage) {
      Write-Host '  location:' -ForegroundColor DarkGray
      $ErrorRecord.InvocationInfo.PositionMessage.TrimEnd().Split([Environment]::NewLine) | ForEach-Object { Write-Host ("  │ {0}" -f $_) -ForegroundColor DarkGray }
    }
    if ($ErrorRecord.ScriptStackTrace) {
      Write-Host '  stack trace:' -ForegroundColor DarkGray
      $ErrorRecord.ScriptStackTrace.TrimEnd().Split([Environment]::NewLine) | ForEach-Object { Write-Host ("  │ {0}" -f $_) -ForegroundColor DarkGray }
    }
  }
  if (Test-Path -LiteralPath $LogPath -PathType Leaf) {
    $contents = Get-Content -LiteralPath $LogPath -ErrorAction SilentlyContinue
    if ($null -ne $contents -and $contents.Count -gt 0) {
      Write-Host '  output:' -ForegroundColor DarkGray
      $contents | ForEach-Object { Write-Host ("  │ {0}" -f $_) -ForegroundColor DarkGray }
    }
  }
}
function Invoke-LoggedStep([string]$Message, [string]$LogPath, [scriptblock]$Action) {
  Write-Step $Message
  try {
    & $Action *> $LogPath
  } catch {
    $code = if ($LASTEXITCODE -ne 0) { [int]$LASTEXITCODE } else { 1 }
    Add-Content -LiteralPath $LogPath -Value (($_ | Out-String).TrimEnd()) -ErrorAction SilentlyContinue
    Write-LogFailure $Message $LogPath $code $_
    throw
  }
  $code = if ($LASTEXITCODE -ne 0) { [int]$LASTEXITCODE } else { 0 }
  if ($code -ne 0) {
    Write-LogFailure $Message $LogPath $code
    throw $Message
  }
  Write-Ok $Message
}
function Refresh-Existing {
  if (-not (Test-Path -LiteralPath $CurrentRoot)) { return $false }
  if (-not (Test-Path -LiteralPath $CurrentRoot -PathType Container)) { throw 'Existing Runmesh current path is not a managed directory.' }
  $ExistingRunner = Join-Path $CurrentRoot 'runmesh.cmd'
  if (-not (Test-Path -LiteralPath $ExistingRunner -PathType Leaf) -or -not (Test-Path -LiteralPath $Profile -PathType Leaf) -or -not (Test-Path -LiteralPath $ServiceManifest -PathType Leaf)) { throw 'Existing Runmesh installation is incomplete; restore it or remove it with runmesh uninstall before retrying.' }
  if ($null -eq (Select-String -LiteralPath $ServiceManifest -SimpleMatch 'runmesh-runner-managed:' -Quiet)) { throw 'Existing service is not managed by Runmesh; refusing to modify it.' }
  $RefreshLock = Join-Path $InstallRoot '.refresh.lock'
  try { New-Item -ItemType Directory -Path $RefreshLock -ErrorAction Stop | Out-Null } catch { throw 'Another Runmesh enrollment refresh is already running.' }
  try {
    Write-Step 'Refreshing credentials for the existing Runmesh Runner.'
    if ($null -eq $EnrollmentCodeArgument) {
      $SecureCode = Read-Host 'Paste the one-time enrollment code (input is hidden)' -AsSecureString
      $CodePointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureCode)
      try { $EnrollmentCode = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($CodePointer) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($CodePointer) }
    } else { $EnrollmentCode = $EnrollmentCodeArgument; $EnrollmentCodeArgument = $null }
    if ([string]::IsNullOrWhiteSpace($EnrollmentCode) -or $EnrollmentCode -notmatch '^[A-Za-z0-9_-]{43}$') { throw 'Invalid one-time enrollment code.' }
    $RefreshEnrollLog = Join-Path $InstallRoot ('.refresh-enroll.{0}.log' -f $PID)
    $EnrollmentCode | & $ExistingRunner enroll --profile $Profile --server $EnrollmentUrl --code-stdin --re-enroll *> $RefreshEnrollLog
    if ($LASTEXITCODE -ne 0) { Write-LogFailure 'Refreshing credentials for the existing Runmesh Runner.' $RefreshEnrollLog $LASTEXITCODE; throw 'Enrollment refresh failed.' }
    $RefreshInstallLog = Join-Path $InstallRoot ('.refresh-install.{0}.log' -f $PID)
    & $ExistingRunner install --profile $Profile --executable-path $ExistingRunner *> $RefreshInstallLog
    if ($LASTEXITCODE -ne 0) { Write-LogFailure 'Refreshing the installed service for the existing Runmesh Runner.' $RefreshInstallLog $LASTEXITCODE; throw 'Service installation refresh failed.' }
    $RefreshRestartLog = Join-Path $InstallRoot ('.refresh-restart.{0}.log' -f $PID)
    & $ExistingRunner restart --profile $Profile *> $RefreshRestartLog
    if ($LASTEXITCODE -ne 0) { Write-LogFailure 'Restarting the existing Runmesh Runner service.' $RefreshRestartLog $LASTEXITCODE; throw 'Runner service restart failed.' }
    Write-Ok 'Runmesh Runner credentials refreshed and service restarted in place.'
    return $true
  } finally { Remove-Variable EnrollmentCode -ErrorAction SilentlyContinue; try { Remove-Item -LiteralPath $RefreshLock -Force -ErrorAction SilentlyContinue } catch {} }
}
if ((Test-Path -LiteralPath $CurrentRoot) -and (Test-Path -LiteralPath $Profile) -and (Test-Path -LiteralPath $ServiceManifest)) { if (Refresh-Existing) { exit 0 } }
if ((Test-Path -LiteralPath $CurrentRoot) -or (Test-Path -LiteralPath $VersionRoot) -or (Test-Path -LiteralPath $CurrentNew) -or (Test-Path -LiteralPath $Stage) -or (Test-Path -LiteralPath $Profile) -or (Test-Path -LiteralPath $ServiceManifest)) { throw 'Existing Runmesh installation or service state found; refusing to overwrite it.' }
$TempRoot = Join-Path ([IO.Path]::GetTempPath()) ('runmesh-installer-' + [guid]::NewGuid().ToString('N'))
$ServiceAttempted = $false
$EnrollmentAttempted = $false
# Preflight rejects an existing profile; any profile after enrollment is ours
# and can be removed if a later install step fails.
$Succeeded = $false
$CurrentRunner = $null
$HttpHandler = $null
$HttpClient = $null
New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null
$EmptyUserConfig = Join-Path $TempRoot 'empty-user.npmrc'
$EmptyGlobalConfig = Join-Path $TempRoot 'empty-global.npmrc'
$NpmCache = Join-Path $TempRoot 'npm-cache'
# Point both npm config layers and its cache at private, empty paths. The
# install also runs from TempRoot, which has no caller-controlled project
# npmrc; this prevents root/global/cwd configuration from changing a
# privileged offline install.
[IO.File]::WriteAllText($EmptyUserConfig, '')
[IO.File]::WriteAllText($EmptyGlobalConfig, '')
New-Item -ItemType Directory -Path $NpmCache -Force | Out-Null
$env:NPM_CONFIG_USERCONFIG = $EmptyUserConfig
$env:NPM_CONFIG_GLOBALCONFIG = $EmptyGlobalConfig
$env:NPM_CONFIG_CACHE = $NpmCache
$env:npm_config_userconfig = $env:NPM_CONFIG_USERCONFIG
$env:npm_config_globalconfig = $env:NPM_CONFIG_GLOBALCONFIG
$env:npm_config_cache = $env:NPM_CONFIG_CACHE
try {
  # Invoke-WebRequest/-MaximumRedirection are intentionally not used for the
  # release fetch: their automatic redirect behavior cannot be pinned before
  # the next request. HttpClient follows one validated Location at a time.
  $NodeArchivePath = Join-Path $TempRoot $NodeAsset
  Invoke-WebRequest -UseBasicParsing -MaximumRedirection 0 -Uri $NodeUrl -OutFile $NodeArchivePath
  if ((Get-Item -LiteralPath $NodeArchivePath).Length -le 0 -or (Get-Item -LiteralPath $NodeArchivePath).Length -gt __MAX_NODE_RUNTIME_BYTES__) { throw 'Private Node.js runtime archive size is invalid.' }
  $NodeDigest = (Get-FileHash -LiteralPath $NodeArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($NodeDigest -ne $NodeSha256) { throw 'Private Node.js runtime checksum verification failed.' }
  $NodeExtract = Join-Path $TempRoot 'node-runtime'
  Expand-Archive -LiteralPath $NodeArchivePath -DestinationPath $NodeExtract -Force
  $NodeHome = Join-Path $NodeExtract ([IO.Path]::GetFileNameWithoutExtension($NodeAsset))
  $NodePath = Join-Path $NodeHome 'node.exe'
  $NpmPath = Join-Path $NodeHome 'npm.cmd'
  if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf) -or -not (Test-Path -LiteralPath $NpmPath -PathType Leaf)) { throw 'Private Node.js runtime extraction failed.' }
  $NodeMajor = [int]((& $NodePath --version).Trim().TrimStart('v').Split('.')[0])
  if ($NodeMajor -lt 20) { throw 'Private Node.js runtime is too old.' }
  $HttpHandler = [Net.Http.HttpClientHandler]::new()
  $HttpHandler.AllowAutoRedirect = $false
  $HttpHandler.AutomaticDecompression = [Net.DecompressionMethods]::GZip -bor [Net.DecompressionMethods]::Deflate
  $HttpClient = [Net.Http.HttpClient]::new($HttpHandler)
  $HttpClient.Timeout = [TimeSpan]::FromSeconds(60)
  foreach ($Name in @('manifest.json', 'manifest.sig', 'manifest.signature.json', 'SHA256SUMS', $ArtifactName)) {
    $current = [Uri]::new($ReleaseBase + '/' + $Name)
    $downloaded = $false
    for ($attempt = 0; $attempt -lt 6; $attempt++) {
      $currentOrigin = $current.GetLeftPart([UriPartial]::Authority).TrimEnd('/')
      if ($current.Scheme -ne 'https' -or -not [string]::IsNullOrEmpty($current.UserInfo) -or $AllowedReleaseOrigins -notcontains $currentOrigin) { throw 'Release redirect escaped pinned origins.' }
      $response = $null
      try {
        $response = $HttpClient.GetAsync($current, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        $status = [int]$response.StatusCode
        if ($status -ge 300 -and $status -lt 400) {
          if ($attempt -ge 5 -or $null -eq $response.Headers.Location) { throw 'Release redirect limit or Location header exceeded.' }
          $next = [Uri]::new($current, [string]$response.Headers.Location)
          $nextOrigin = $next.GetLeftPart([UriPartial]::Authority).TrimEnd('/')
          if ($next.Scheme -ne 'https' -or -not [string]::IsNullOrEmpty($next.UserInfo) -or $AllowedReleaseOrigins -notcontains $nextOrigin) { throw 'Release redirect escaped pinned origins.' }
          $current = $next
          continue
        }
        if (-not $response.IsSuccessStatusCode) { throw "Release download returned HTTP $status." }
        $contentLength = $response.Content.Headers.ContentLength
        if ($null -ne $contentLength -and $contentLength -gt __MAX_RELEASE_ASSET_BYTES__) { throw 'Release asset exceeds the fixed size limit.' }
        $stream = $null
        $file = $null
        try {
          $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
          $file = [IO.File]::Create((Join-Path $TempRoot $Name))
          $buffer = New-Object byte[] 65536
          [long]$total = 0
          while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $total += $read
            if ($total -gt __MAX_RELEASE_ASSET_BYTES__) { throw 'Release asset exceeds the fixed size limit.' }
            $file.Write($buffer, 0, $read)
          }
        } finally {
          if ($null -ne $file) { $file.Dispose() }
          if ($null -ne $stream) { $stream.Dispose() }
        }
        $downloaded = $true
      } finally {
        if ($null -ne $response) { $response.Dispose() }
      }
      if ($downloaded) { break }
    }
    if (-not $downloaded) { throw 'Release download did not complete.' }
  }
  $VerifyLog = Join-Path $TempRoot 'release-verify.log'
  Invoke-LoggedStep 'Verifying the signed release assets.' $VerifyLog {
    @'
__VERIFIER__
'@ | & $NodePath --input-type=module - $TempRoot
  }
  New-Item -ItemType Directory -Path $VersionsRoot -Force | Out-Null
  Push-Location -LiteralPath $TempRoot
  try {
    $InstallLog = Join-Path $TempRoot 'npm-install.log'
    Invoke-LoggedStep 'Installing the verified Runner package.' $InstallLog {
      & $NpmPath --userconfig $EmptyUserConfig --globalconfig $EmptyGlobalConfig install --global --ignore-scripts --offline --no-audit --no-fund --prefix $Stage (Join-Path $TempRoot $ArtifactName)
    }
  } finally {
    Pop-Location
  }
  $PackageRoot = Get-ChildItem -LiteralPath $Stage -Filter 'runmesh.cjs' -File -Recurse | Select-Object -First 1
  if ($null -eq $PackageRoot) { throw 'Verified package did not contain the Runner bundle.' }
  New-Item -ItemType Directory -Path (Join-Path $Stage 'runtime') -Force | Out-Null
  Copy-Item -LiteralPath $NodePath -Destination (Join-Path $Stage 'runtime\node.exe') -Force
  Copy-Item -LiteralPath $PackageRoot.FullName -Destination (Join-Path $Stage 'runmesh.cjs') -Force
  $Runner = Join-Path $Stage 'runmesh.cmd'
  $RunmeshRunner = Join-Path $Stage 'runmesh-runner.cmd'
  Set-Content -LiteralPath $Runner -Encoding ASCII -Value ('@echo off' + $crlf + $dq + '%~dp0runtime\node.exe' + $dq + ' ' + $dq + '%~dp0runmesh.cjs' + $dq + ' %*' + $crlf)
  Set-Content -LiteralPath $RunmeshRunner -Encoding ASCII -Value ('@echo off' + $crlf + $dq + '%~dp0runtime\node.exe' + $dq + ' ' + $dq + '%~dp0runmesh.cjs' + $dq + ' %*' + $crlf)
  if ((& $Runner --version).Trim() -ne $Version) { throw 'Installed runmesh version mismatch.' }
  if ((& $RunmeshRunner --version).Trim() -ne $Version) { throw 'Installed runmesh-runner version mismatch.' }
  & $Runner --help | Select-String -SimpleMatch 'usage: runmesh-runner' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Installed runmesh help check failed.' }
  & $RunmeshRunner --help | Select-String -SimpleMatch 'usage: runmesh-runner' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Installed runmesh-runner help check failed.' }
  if ($null -ne $EnrollmentCodeArgument) {
    $EnrollmentCode = $EnrollmentCodeArgument
    $EnrollmentCodeArgument = $null
  } else {
    $SecureCode = Read-Host 'Paste the one-time enrollment code (input is hidden)' -AsSecureString
    $CodePointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureCode)
    try { $EnrollmentCode = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($CodePointer) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($CodePointer) }
    if ([string]::IsNullOrWhiteSpace($EnrollmentCode)) { throw 'An enrollment code is required.' }
  }
  $EnrollmentAttempted = $true
  $EnrollLog = Join-Path $TempRoot 'enroll.log'
  Invoke-LoggedStep 'Enrolling the Runner.' $EnrollLog {
    $EnrollmentCode | & $Runner enroll --profile $Profile --server $EnrollmentUrl --code-stdin --execution-mode privileged_host --confirm-privileged-host
  }
  $EnrollmentCode = $null
  $SecureCode = $null
  Move-Item -LiteralPath $Stage -Destination $VersionRoot
  New-Item -ItemType Junction -Path $CurrentNew -Target $VersionRoot | Out-Null
  Move-Item -LiteralPath $CurrentNew -Destination $CurrentRoot
  $CurrentRunner = Join-Path $CurrentRoot 'runmesh.cmd'
  $ServiceAttempted = $true
  $ServiceLog = Join-Path $TempRoot 'service-install.log'
  Invoke-LoggedStep 'Installing and starting the Runmesh service.' $ServiceLog {
    & $CurrentRunner install --profile $Profile --execution-mode privileged_host --confirm-privileged-host --executable-path $CurrentRunner
  }
  $Succeeded = $true
  Write-Ok "Runmesh Runner $Version installed and enrolled."
  Write-Host '  Service started automatically.'
  Write-Host '  Windows status: Get-ScheduledTask -TaskName RunmeshRunner'
} catch {
  Write-Fail 'Runmesh Runner installation failed.'
  Write-Host ("  exception: {0}" -f $_.Exception.GetType().FullName) -ForegroundColor DarkGray
  Write-Host ("  message: {0}" -f $_.Exception.Message) -ForegroundColor DarkGray
  if ($_.InvocationInfo -and $_.InvocationInfo.PositionMessage) {
    Write-Host '  location:' -ForegroundColor DarkGray
    $_.InvocationInfo.PositionMessage.TrimEnd().Split([Environment]::NewLine) | ForEach-Object { Write-Host ("  │ {0}" -f $_) -ForegroundColor DarkGray }
  }
  if ($_.ScriptStackTrace) {
    Write-Host '  stack trace:' -ForegroundColor DarkGray
    $_.ScriptStackTrace.TrimEnd().Split([Environment]::NewLine) | ForEach-Object { Write-Host ("  │ {0}" -f $_) -ForegroundColor DarkGray }
  }
  Write-Host '  Any local files created by this attempt will be rolled back where safe.' -ForegroundColor DarkGray
  throw
} finally {
  if ($null -ne $HttpClient) { $HttpClient.Dispose() }
  if ($null -ne $HttpHandler) { $HttpHandler.Dispose() }
  if (-not $Succeeded) {
    if ($ServiceAttempted -and $null -ne $CurrentRunner -and (Test-Path -LiteralPath $CurrentRunner)) { try { & $CurrentRunner uninstall --profile $Profile --purge --yes --json *> $null } catch {} }
    if ($EnrollmentAttempted -and (Test-Path -LiteralPath $Profile)) { try { Remove-Item -LiteralPath $Profile -Force } catch {} }
    foreach ($Path in @($CurrentNew, $CurrentRoot, $Stage, $VersionRoot)) { if (Test-Path -LiteralPath $Path) { try { Remove-Item -LiteralPath $Path -Recurse -Force } catch {} } }
  }
  if (Test-Path -LiteralPath $TempRoot) { try { Remove-Item -LiteralPath $TempRoot -Recurse -Force } catch {} }
}
`;

function replaceInstallerTemplate(template: string, enrollmentUrl: string, literal: (value: string) => string): string {
  const node = FIXED_NODE_RUNTIME_ASSETS;
  return template
    .replaceAll("__VERSION__", literal(FIXED_RELEASE_VERSION))
    .replaceAll("__NODE_VERSION__", literal(FIXED_NODE_VERSION))
    .replaceAll("__MAX_NODE_RUNTIME_BYTES__", String(MAX_NODE_RUNTIME_BYTES))
    .replaceAll("__NODE_BASE_URL__", literal(FIXED_NODE_BASE_URL))
    .replaceAll("__NODE_LINUX_X64__", literal(node["linux-x64"].archive))
    .replaceAll("__NODE_LINUX_X64_SHA256__", node["linux-x64"].sha256)
    .replaceAll("__NODE_LINUX_ARM64__", literal(node["linux-arm64"].archive))
    .replaceAll("__NODE_LINUX_ARM64_SHA256__", node["linux-arm64"].sha256)
    .replaceAll("__NODE_DARWIN_X64__", literal(node["darwin-x64"].archive))
    .replaceAll("__NODE_DARWIN_X64_SHA256__", node["darwin-x64"].sha256)
    .replaceAll("__NODE_DARWIN_ARM64__", literal(node["darwin-arm64"].archive))
    .replaceAll("__NODE_DARWIN_ARM64_SHA256__", node["darwin-arm64"].sha256)
    .replaceAll("__NODE_WIN_X64__", literal(node["win-x64"].archive))
    .replaceAll("__NODE_WIN_X64_SHA256__", node["win-x64"].sha256)
    .replaceAll("__NODE_WIN_ARM64__", literal(node["win-arm64"].archive))
    .replaceAll("__NODE_WIN_ARM64_SHA256__", node["win-arm64"].sha256)
    .replaceAll("__RELEASE_BASE__", literal(FIXED_RELEASE_BASE_URL))
    .replaceAll("__ARTIFACT_NAME__", literal(FIXED_ARTIFACT_NAME))
    .replaceAll("__ENROLLMENT_URL__", literal(enrollmentUrl))
    .replaceAll("__MAX_RELEASE_ASSET_BYTES__", String(MAX_RELEASE_ASSET_BYTES))
    .replace("__RELEASE_REDIRECT_ORIGINS_JSON__", JSON.stringify(FIXED_RELEASE_ALLOWED_REDIRECT_ORIGINS))
    .replace("__RELEASE_REDIRECT_ORIGINS_PS__", FIXED_RELEASE_ALLOWED_REDIRECT_ORIGINS.map((value) => powershellQuote(value)).join(", "))
    .replace("__VERIFIER__", verifierSource());
}

export function renderPosixInstaller(requestOrigin: string): string {
  const publicOrigin = canonicalPublicOrigin(requestOrigin);
  return replaceInstallerTemplate(POSIX_TEMPLATE, `${publicOrigin}/runner/enroll`, shellLiteral);
}

export function renderPowerShellInstaller(requestOrigin: string): string {
  const publicOrigin = canonicalPublicOrigin(requestOrigin);
  return replaceInstallerTemplate(POWERSHELL_TEMPLATE, `${publicOrigin}/runner/enroll`, powershellLiteral);
}
