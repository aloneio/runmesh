import { canonicalPublicOrigin } from "./public-origin.js";
export { canonicalPublicOrigin, resolvePublicOrigin } from "./public-origin.js";
import { POSIX_INSTALLER_PREFLIGHT } from "./installer-preflight.js";
import { FIXED_NODE_VERSION, FIXED_NODE_BASE_URL, FIXED_INSTALLER_RELEASE, MAX_RELEASE_ASSET_BYTES, MAX_NODE_RUNTIME_BYTES, FIXED_NODE_RUNTIME_ASSETS, FIXED_RELEASE_ALLOWED_REDIRECT_ORIGINS } from "./domain/release-config.js";
export * from "./domain/release-config.js";
import type { InstallerReleaseTarget } from "./contracts/runner-release.js";
export type { InstallerReleaseTarget, FixedReleaseDescriptor } from "./contracts/runner-release.js";
import { PROTOCOL_MIN_VERSION, PROTOCOL_CURRENT_VERSION } from "@aloneio/runmesh-protocol";
import { RELEASE_VALIDATION_SOURCE } from "./generated-release-validation.js";

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
const expectedRelease = __VALIDATION_TARGET__;
const manifestProblem = RunmeshReleaseContract.releaseManifestProblem(manifest, expectedRelease);
if (manifestProblem === "manifest") fail("manifest fields are not the fixed preview contract");
if (manifestProblem === "artifact") fail("manifest artifact is invalid");
const artifactBytes = await boundedRead(artifactName);
const digest = createHash("sha256").update(artifactBytes).digest("hex");
if (artifactBytes.byteLength !== artifact.size || digest !== artifact.sha256) fail("artifact size or SHA-256 mismatch");
const sums = await boundedRead("SHA256SUMS", "utf8");
if (!sums.split(/\r?\n/).some((line) => line === digest + "  " + artifactName || line === digest + " *" + artifactName)) fail("SHA256SUMS does not match authenticated artifact");
`;

function verifierSource(release: InstallerReleaseTarget = FIXED_INSTALLER_RELEASE): string {
  return RELEASE_VALIDATION_SOURCE + "\n" + VERIFY_RELEASE
    .replace("__VALIDATION_TARGET__", JSON.stringify({ version: release.version, channel: release.channel,
      artifact_name: release.artifact_name, artifact_url: release.artifact_url,
      protocol_min: PROTOCOL_MIN_VERSION, protocol_max: PROTOCOL_CURRENT_VERSION, max_asset_bytes: MAX_RELEASE_ASSET_BYTES }))
    .replaceAll("__VERSION__", release.version)
    .replaceAll("__CHANNEL__", release.channel)
    .replaceAll("__PRERELEASE__", String(release.channel !== "stable"))
    .replaceAll("__KEY_ID__", release.release_key_id)
    .replaceAll("__ARTIFACT_NAME__", release.artifact_name)
    .replaceAll("__ARTIFACT_URL__", release.artifact_url)
    .replaceAll("__MAX_RELEASE_ASSET_BYTES__", String(MAX_RELEASE_ASSET_BYTES))
    .replace("__PUBLIC_KEY_PEM__", JSON.stringify(release.public_key_pem));
}

const POSIX_TEMPLATE = String.raw`#!/usr/bin/env sh
# Fixed signed Runmesh bootstrap. This Worker HTTPS response is the
# bootstrap trust root. This script verifies the GitHub artifact with its
# embedded Ed25519 public key and never trusts a downloaded keyring.
set -eu
umask 077
if [ -t 2 ] && [ -z "__NO_COLOR__" ]; then C_RESET='\033[0m'; C_CYAN='\033[36m'; C_GREEN='\033[32m'; C_RED='\033[31m'; else C_RESET=''; C_CYAN=''; C_GREEN=''; C_RED=''; fi
STEP_INDEX=0
step() { STEP_INDEX=$((STEP_INDEX + 1)); printf '  %b[%s]%b %s\n' "$C_CYAN" "$STEP_INDEX" "$C_RESET" "$1" >&2; }
ok() { printf '%b✓%b %s\n' "$C_GREEN" "$C_RESET" "$1" >&2; }
fail() { printf '%b✗%b %s\n' "$C_RED" "$C_RESET" "$1" >&2; }
report_failure() {
  label="$1"
  log_file="$2"
  rc="$3"
  fail "$label"
  printf '%s\n' "  exit code: $rc" >&2
  if [ "$ENROLLMENT_ATTEMPTED" -eq 1 ]; then
    printf '%s\n' '  Credential handoff was attempted; output is withheld to protect the code. Do not blindly retry enrollment. Inspect the service status and control-plane credential state.' >&2
  elif [ -s "$log_file" ]; then
    printf '%s\n' '  output:' >&2
    sed -n '1,60{s/^/  | /;p;}' "$log_file" >&2
  fi
  rm -f "$log_file"
}
printf '\n%bRunmesh Runner%b\n----------------------------------------\n' "$C_CYAN" "$C_RESET" >&2
# Do not let inherited runtime/package-manager configuration alter a privileged
# install. The operator's PATH is still required to point at trusted binaries.
unset NODE_OPTIONS NODE_PATH CURL_HOME CURLRC NPM_CONFIG_USERCONFIG NPM_CONFIG_GLOBALCONFIG npm_config_userconfig npm_config_globalconfig 2>/dev/null || true
__POSIX_INSTALLER_PREFLIGHT__
VERSION='__VERSION__'
RELEASE_BASE='__RELEASE_BASE__'
ARTIFACT='__ARTIFACT_NAME__'
ENROLLMENT_URL='__ENROLLMENT_URL__'
INSTALL_ROOT='/opt/runmesh'
INSTALL_PHASE=arguments
ENROLLMENT_ATTEMPTED=0
AUTO_INSTALL_DEPS=1
RUNMESH_ACTION='__ACTION__'
PURGE_REQUESTED=0
CONFIRM_PURGE=0
ENROLLMENT_CODE_ARG=''
CODE_ARG_SET=0
# The convenience command intentionally carries a single-use code in argv.
# Without one, keep the hidden terminal prompt as an optional manual path.
while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-auto-deps) AUTO_INSTALL_DEPS=0 ;;
    uninstall) RUNMESH_ACTION=uninstall ;;
    --purge) PURGE_REQUESTED=1 ;;
    --yes) CONFIRM_PURGE=1 ;;
    install|--auto-deps|--re-enroll) : ;;
    --code)
      [ "$#" -ge 2 ] || { printf '%s\n' 'error: --code requires an enrollment code' >&2; exit 1; }
      [ "$CODE_ARG_SET" -eq 0 ] || { printf '%s\n' 'error: enrollment code supplied more than once' >&2; exit 1; }
      ENROLLMENT_CODE_ARG="$2"; CODE_ARG_SET=1; shift ;;
    --code=*)
      [ "$CODE_ARG_SET" -eq 0 ] || { printf '%s\n' 'error: enrollment code supplied more than once' >&2; exit 1; }
      ENROLLMENT_CODE_ARG="__CODE_EQUALS_VALUE__"; CODE_ARG_SET=1 ;;
    *)
      [ "$CODE_ARG_SET" -eq 0 ] || { printf '%s\n' 'error: enrollment code supplied more than once' >&2; exit 1; }
      ENROLLMENT_CODE_ARG="$1"; CODE_ARG_SET=1 ;;
  esac
  shift
done
if [ "$CODE_ARG_SET" -eq 1 ]; then
  case "$ENROLLMENT_CODE_ARG" in *[!A-Za-z0-9_-]*) printf '%s\n' 'error: invalid one-time enrollment code' >&2; exit 1;; esac
  case "$ENROLLMENT_CODE_ARG" in ???????????????????????????????????????????) : ;; *) printf '%s\n' 'error: invalid one-time enrollment code' >&2; exit 1;; esac
fi
if [ "$RUNMESH_ACTION" = uninstall ]; then
  [ "$PURGE_REQUESTED" -eq 1 ] && [ "$CONFIRM_PURGE" -eq 1 ] && [ "$CODE_ARG_SET" -eq 0 ] || { printf '%s\n' 'error: uninstall requires --purge --yes and no enrollment code' >&2; exit 1; }
else
  [ "$PURGE_REQUESTED" -eq 0 ] && [ "$CONFIRM_PURGE" -eq 0 ] || { printf '%s\n' 'error: purge options are only valid for uninstall' >&2; exit 1; }
fi
INSTALL_PHASE=preflight
check_base_tools
if [ "$(id -u)" -ne 0 ]; then printf '%s\n' 'error: run from an elevated root shell' >&2; exit 1; fi
case "$(uname -s)" in
  Linux) PROFILE='/etc/runmesh/profile.json'; SERVICE_MANIFEST='/etc/systemd/system/runmesh-runner.service' ;;
  Darwin) PROFILE='/Library/Application Support/Runmesh/profile.json'; SERVICE_MANIFEST='/Library/LaunchDaemons/io.alone.runmesh.runner.plist' ;;
  *) printf '%s\n' 'error: Linux or macOS is required' >&2; exit 1;;
esac
check_service_prerequisites
case "$(uname -s):$(uname -m)" in
  Linux:x86_64|Linux:amd64) NODE_ASSET='__NODE_LINUX_X64__'; NODE_SHA256='__NODE_LINUX_X64_SHA256__' ;;
  Linux:aarch64|Linux:arm64) NODE_ASSET='__NODE_LINUX_ARM64__'; NODE_SHA256='__NODE_LINUX_ARM64_SHA256__' ;;
  Darwin:x86_64) NODE_ASSET='__NODE_DARWIN_X64__'; NODE_SHA256='__NODE_DARWIN_X64_SHA256__' ;;
  Darwin:arm64) NODE_ASSET='__NODE_DARWIN_ARM64__'; NODE_SHA256='__NODE_DARWIN_ARM64_SHA256__' ;;
  *) printf '%s\n' 'error: unsupported operating system or CPU architecture' >&2; exit 1;;
esac
NODE_BASE='__NODE_BASE_URL__'

# Serialize every hosted installation, refresh and uninstall before inspecting
# shared paths. Keep the lock outside the installation tree that purge removes.
INSTALL_LOCK='/var/run/runmesh-installer.lock'
if ! mkdir "$INSTALL_LOCK" 2>/dev/null; then printf '%s\n' 'error: another Runmesh installer or uninstaller is running; inspect a stale lock before removing it' >&2; exit 1; fi
release_install_lock() { rmdir "$INSTALL_LOCK" 2>/dev/null || true; }
trap release_install_lock EXIT
trap 'exit 1' HUP INT TERM
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
  [ "$("$EXISTING_RUNNER" --version)" = "$VERSION" ] || { printf '%s\n' 'error: installed Runner version differs from the fixed release; perform a verified manual upgrade before re-enrollment' >&2; exit 1; }
  [ -f "$PROFILE" ] && [ -f "$SERVICE_MANIFEST" ] || { printf '%s\n' 'error: existing Runmesh installation is incomplete; restore it or remove it with runmesh uninstall before retrying' >&2; exit 1; }
  grep -F 'runmesh-runner-managed:' "$SERVICE_MANIFEST" >/dev/null 2>&1 || { printf '%s\n' 'error: existing service is not managed by Runmesh; refusing to modify it' >&2; exit 1; }
  REFRESH_LOCK="$INSTALL_ROOT/.refresh.lock"
  if ! mkdir "$REFRESH_LOCK" 2>/dev/null; then printf '%s\n' 'error: another Runmesh enrollment refresh is already running' >&2; exit 1; fi
  trap 'stty echo < /dev/tty 2>/dev/null || true; rmdir "$REFRESH_LOCK" 2>/dev/null || true; release_install_lock' EXIT
  step 'Refreshing credentials for the existing Runmesh Runner.'
  if [ "$CODE_ARG_SET" -eq 1 ]; then
    ENROLLMENT_CODE="$ENROLLMENT_CODE_ARG"
    unset ENROLLMENT_CODE_ARG
  else
    printf '%s' 'Paste the one-time enrollment code (input is hidden): ' >/dev/tty
    stty -echo < /dev/tty || { printf '%s\n' 'error: terminal input cannot be protected' >&2; exit 1; }
    TTY_ECHO_DISABLED=1
    IFS= read -r ENROLLMENT_CODE < /dev/tty || { stty echo < /dev/tty 2>/dev/null || true; printf '\n%s\n' 'error: unable to read enrollment code from terminal' >&2; exit 1; }
    stty echo < /dev/tty 2>/dev/null || true; TTY_ECHO_DISABLED=0; printf '\n' >/dev/tty
  fi
  case "$ENROLLMENT_CODE" in *[!A-Za-z0-9_-]*) printf '%s\n' 'error: invalid one-time enrollment code' >&2; exit 1;; esac
  case "$ENROLLMENT_CODE" in ???????????????????????????????????????????) : ;; *) printf '%s\n' 'error: invalid one-time enrollment code' >&2; exit 1;; esac
  INSTALL_PHASE=enrollment
  ENROLLMENT_ATTEMPTED=1
  REFRESH_ENROLL_LOG="$INSTALL_ROOT/.refresh-enroll.$$.log"
  if printf '%s\n' "$ENROLLMENT_CODE" | "$EXISTING_RUNNER" enroll --profile "$PROFILE" --server "$ENROLLMENT_URL" --code-stdin --re-enroll __EXECUTION_MODE_FLAGS__ >"$REFRESH_ENROLL_LOG" 2>&1; then :; else rc=$?; report_failure 'Refreshing credentials for the existing Runmesh Runner.' "$REFRESH_ENROLL_LOG" "$rc"; exit "$rc"; fi
  unset ENROLLMENT_CODE
  INSTALL_PHASE=service_install
  REFRESH_INSTALL_LOG="$INSTALL_ROOT/.refresh-install.$$.log"
  if "$EXISTING_RUNNER" install --profile "$PROFILE" __EXECUTION_MODE_FLAGS__ --executable-path "$EXISTING_RUNNER" >"$REFRESH_INSTALL_LOG" 2>&1; then :; else rc=$?; report_failure 'Refreshing the installed service for the existing Runmesh Runner.' "$REFRESH_INSTALL_LOG" "$rc"; exit "$rc"; fi
  REFRESH_RESTART_LOG="$INSTALL_ROOT/.refresh-restart.$$.log"
  if "$EXISTING_RUNNER" restart --profile "$PROFILE" >"$REFRESH_RESTART_LOG" 2>&1; then :; else rc=$?; report_failure 'Restarting the existing Runmesh Runner service.' "$REFRESH_RESTART_LOG" "$rc"; exit "$rc"; fi
  ok 'Runmesh Runner credentials refreshed and service restarted in place.'
  trap - EXIT HUP INT TERM
  rmdir "$REFRESH_LOCK" 2>/dev/null || true
  release_install_lock
  return 0
}
if [ "$RUNMESH_ACTION" != uninstall ] && has_path "$INSTALL_ROOT/current" && has_path "$PROFILE" && has_path "$SERVICE_MANIFEST"; then refresh_existing; exit $?; fi
if [ "$RUNMESH_ACTION" != uninstall ] && { has_path "$INSTALL_ROOT/current" || has_path "$INSTALL_ROOT/current.new" || has_path "$INSTALL_ROOT/versions/$VERSION" || has_path "$INSTALL_ROOT/versions/$VERSION.staging.$$" || has_path "$PROFILE" || has_path "$SERVICE_MANIFEST"; }; then printf '%s\n' 'error: existing Runmesh installation or service state found; refusing to overwrite it' >&2; exit 1; fi
check_bootstrap_tools
[ "$AUTO_INSTALL_DEPS" -eq 1 ] || bootstrap_error RMI_RUNTIME_DISABLED 'Private runtime bootstrap was disabled.' 'Remove --no-auto-deps for a new installation; an existing verified installation can be refreshed without downloading a runtime.'
TMP="$(mktemp -d "__TEMP_PARENT__/runmesh-installer.XXXXXX")" || bootstrap_error RMI_TEMP_DIRECTORY 'Cannot create a private temporary directory.' 'Check /tmp free space and permissions.'
trap 'rm -rf "$TMP"; release_install_lock' EXIT
trap 'exit 1' HUP INT TERM
step 'Preparing runtime'
STAGE="$INSTALL_ROOT/versions/$VERSION.staging.$$"
CURRENT_NEW="$INSTALL_ROOT/current.new"
FINAL="$INSTALL_ROOT/versions/$VERSION"
RUNTIME_ARCHIVE="$TMP/$NODE_ASSET"
RUNTIME_ROOT="$TMP/node-runtime"
mkdir "$RUNTIME_ROOT"
RUNTIME_URL="$NODE_BASE/$NODE_ASSET"
prepare_private_runtime
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
CURRENT_NEW_CREATED=0
STAGE_CREATED=0
PROFILE_CREATED=0
ENROLLMENT_ATTEMPTED=0
# A failed enrollment does not prove ownership of a profile another operation
# may have created. Only successful enrollment authorizes profile rollback.
cleanup_tty() { if [ "$TTY_ECHO_DISABLED" -eq 1 ]; then stty echo < /dev/tty 2>/dev/null || true; TTY_ECHO_DISABLED=0; fi; }
cleanup() { cleanup_tty; rm -rf "$TMP"; release_install_lock; }
rollback() {
  rc="$1"
  printf 'error [RMI_INSTALL_FAILED] stage=%s: installation did not complete.\n' "$INSTALL_PHASE" >&2
  if [ "$ENROLLMENT_ATTEMPTED" -eq 0 ]; then
    printf '%s\n' '  Enrollment was not attempted. Retry after fixing the prerequisite; the code may still expire by its own validity window.' >&2
  else
    printf '%s\n' '  Enrollment was attempted and the code may have been consumed. Check credentials before retrying; do not repeatedly redeem the same code.' >&2
  fi
  if [ "$RUNMESH_ACTION" = uninstall ]; then cleanup; trap - EXIT HUP INT TERM; exit "$rc"; fi
  cleanup_tty
  if [ "$CURRENT_NEW_CREATED" -eq 1 ] && [ -L "$CURRENT_NEW" ]; then rm -f "$CURRENT_NEW"; fi
  if [ "$CURRENT_CREATED" -eq 1 ] && [ -L "$INSTALL_ROOT/current" ] && [ "$(readlink "$INSTALL_ROOT/current")" = "$FINAL" ]; then "$INSTALL_ROOT/current/bin/runmesh" uninstall --profile "$PROFILE" --json >/dev/null 2>&1 || true; rm -f "$INSTALL_ROOT/current"; fi
  if [ "$PROFILE_CREATED" -eq 1 ] && [ -f "$PROFILE" ]; then rm -f "$PROFILE"; fi
  if [ "$FINAL_CREATED" -eq 1 ]; then rm -rf "$FINAL"; fi
  if [ "$STAGE_CREATED" -eq 1 ]; then rm -rf "$STAGE"; fi
  rm -rf "$TMP"
  release_install_lock
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
    if curl -q --fail --silent --show-error --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 15 --max-time 120 --retry 0 --max-redirs 0 --max-filesize __MAX_RELEASE_ASSET_BYTES__ --dump-header "$headers" --output "$TMP/$name" --write-out '%{http_code}' "$url" > "$status_file"; then
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
INSTALL_PHASE=release_download
step 'Downloading Runner'
download manifest.json
download manifest.sig
download manifest.signature.json
download SHA256SUMS
download "$ARTIFACT"
INSTALL_PHASE=release_verification
step 'Verifying Runner'
VERIFY_LOG="$TMP/release-verify.log"
if "$NODE" --input-type=module - "$TMP" >"$VERIFY_LOG" 2>&1 <<'RUNMESH_VERIFY'
__VERIFIER__
RUNMESH_VERIFY
then :; else rc=$?; report_failure 'Verifying Runner' "$VERIFY_LOG" "$rc"; exit "$rc"; fi
ok 'Runner verified.'
if [ "$RUNMESH_ACTION" = uninstall ]; then
  step 'Preparing cleanup tools'
  MAINTENANCE="$TMP/maintenance"
  INSTALL_LOG="$TMP/maintenance-install.log"
  if (cd "$TMP" && "$NODE" "$NPM_CLI" --userconfig "$NPM_CONFIG_USERCONFIG" --globalconfig "$NPM_CONFIG_GLOBALCONFIG" install --global --ignore-scripts --offline --no-audit --no-fund --prefix "$MAINTENANCE" "$TMP/$ARTIFACT") >"$INSTALL_LOG" 2>&1; then :; else rc=$?; report_failure 'Preparing cleanup tools' "$INSTALL_LOG" "$rc"; exit "$rc"; fi
  "$NODE" "$MAINTENANCE/lib/node_modules/@aloneio/runmesh-runner/dist/runmesh.cjs" uninstall --purge --yes
  exit $?
fi
mkdir -p "$INSTALL_ROOT/versions"
if ! mkdir "$STAGE"; then printf '%s\n' 'error: installer staging path is already in use' >&2; exit 1; fi
STAGE_CREATED=1
INSTALL_PHASE=package_install
step 'Installing Runner'
export NPM_CONFIG_UPDATE_NOTIFIER=false
INSTALL_LOG="$TMP/npm-install.log"
if (
  cd "$TMP"
  "$NODE" "$NPM_CLI" --userconfig "$NPM_CONFIG_USERCONFIG" --globalconfig "$NPM_CONFIG_GLOBALCONFIG" install --global --ignore-scripts --offline --no-audit --no-fund --prefix "$STAGE" "$TMP/$ARTIFACT"
)> "$INSTALL_LOG" 2>&1; then :; else rc=$?; report_failure 'Installing Runner' "$INSTALL_LOG" "$rc"; exit "$rc"; fi
ok 'Runner installed.'
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
if [ "$CODE_ARG_SET" -eq 1 ]; then
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
case "$ENROLLMENT_CODE" in *[!A-Za-z0-9_-]*) printf '%s\n' 'error: invalid one-time enrollment code' >&2; exit 1;; esac
case "$ENROLLMENT_CODE" in ???????????????????????????????????????????) : ;; *) printf '%s\n' 'error: invalid one-time enrollment code' >&2; exit 1;; esac
INSTALL_PHASE=enrollment
ENROLLMENT_ATTEMPTED=1
step 'Connecting to control plane'
ENROLL_LOG="$TMP/enroll.log"
if printf '%s\n' "$ENROLLMENT_CODE" | "$RUNNER" enroll --profile "$PROFILE" --server "$ENROLLMENT_URL" --code-stdin __EXECUTION_MODE_FLAGS__ >"$ENROLL_LOG" 2>&1; then :; else rc=$?; report_failure 'Connecting to control plane' "$ENROLL_LOG" "$rc"; exit "$rc"; fi
PROFILE_CREATED=1
unset ENROLLMENT_CODE
mv "$STAGE" "$FINAL"
STAGE_CREATED=0
FINAL_CREATED=1
ln -s "$FINAL" "$INSTALL_ROOT/current.new"
CURRENT_NEW_CREATED=1
mv "$INSTALL_ROOT/current.new" "$INSTALL_ROOT/current"
CURRENT_NEW_CREATED=0
CURRENT_CREATED=1
INSTALL_PHASE=service_install
step 'Starting service'
SERVICE_LOG="$TMP/service-install.log"
if "$INSTALL_ROOT/current/bin/runmesh" install --profile "$PROFILE" __EXECUTION_MODE_FLAGS__ --executable-path "$INSTALL_ROOT/current/bin/runmesh" >"$SERVICE_LOG" 2>&1; then :; else rc=$?; report_failure 'Starting service' "$SERVICE_LOG" "$rc"; exit "$rc"; fi
ok "Runmesh Runner $VERSION is ready."
printf '%s\n' '  Service started automatically.' >&2
case "$(uname -s)" in Linux) printf '%s\n' '  Logs: journalctl -u runmesh-runner.service -n 60 --no-pager' >&2 ;; Darwin) printf '%s\n' '  Status: /opt/runmesh/current/bin/runmesh status --json' >&2 ;; esac
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
try { Add-Type -AssemblyName System.Net.Http } catch { throw '[RMI_POWERSHELL_RUNTIME] System.Net.Http is unavailable. Use a supported Windows PowerShell 5.1 or PowerShell 7 session. No enrollment attempted.' }
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
$RuntimePhase = 'arguments'
$EnrollmentAttempted = $false
$EnrollmentCodeArgument = $null
$MaintenanceAction = '__ACTION__'
$PurgeRequested = $false
$ConfirmPurge = $false
$CodeArgumentProvided = $false
$ExpectCodeArgument = $false
foreach ($Argument in $args) {
  if ($ExpectCodeArgument) {
    $EnrollmentCodeArgument = [string]$Argument; $ExpectCodeArgument = $false
    continue
  }
  if ($Argument -eq 'uninstall') { $MaintenanceAction = 'uninstall'; continue }
  if ($Argument -eq '--purge') { $PurgeRequested = $true; continue }
  if ($Argument -eq '--yes') { $ConfirmPurge = $true; continue }
  if ($Argument -in @('install', '--auto-deps', '--no-auto-deps', '--re-enroll')) { continue }
  if ($CodeArgumentProvided) { throw 'Enrollment code supplied more than once.' }
  if ($Argument -eq '--code') {
    $CodeArgumentProvided = $true; $ExpectCodeArgument = $true
  } elseif ($Argument -like '--code=*') {
    $CodeArgumentProvided = $true; $EnrollmentCodeArgument = [string]$Argument.Substring(7)
  } else {
    $CodeArgumentProvided = $true; $EnrollmentCodeArgument = [string]$Argument
  }
}
if ($ExpectCodeArgument) { throw '--code requires an enrollment code.' }
if ($CodeArgumentProvided -and $EnrollmentCodeArgument -notmatch '^[A-Za-z0-9_-]{43}\z') { throw 'Invalid one-time enrollment code.' }
function Read-EnrollmentCode([string]$CodeArgument) {
  if (-not [string]::IsNullOrEmpty($CodeArgument)) {
    if ($CodeArgument -notmatch '^[A-Za-z0-9_-]{43}\z') { throw 'Invalid one-time enrollment code.' }
    return $CodeArgument
  }
  $SecureCode = Read-Host 'Paste the one-time enrollment code (input is hidden)' -AsSecureString
  $CodePointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureCode)
  try { $Code = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($CodePointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($CodePointer); $SecureCode.Dispose() }
  if ($Code -notmatch '^[A-Za-z0-9_-]{43}\z') { throw 'Invalid one-time enrollment code.' }
  return $Code
}
if ($MaintenanceAction -eq 'uninstall') {
  if (-not $PurgeRequested -or -not $ConfirmPurge -or $CodeArgumentProvided) { throw 'Uninstall requires --purge --yes and no enrollment code.' }
} elseif ($PurgeRequested -or $ConfirmPurge) { throw 'Purge options are only valid for uninstall.' }
$InstallRoot = Join-Path $env:ProgramFiles 'Runmesh'
Write-Host ""; Write-Host "Runmesh Runner" -ForegroundColor Cyan; Write-Host ""
$Principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run from an elevated Administrator PowerShell session.' }
$NativeArchitecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture
if ($NativeArchitecture -ne [Runtime.InteropServices.Architecture]::X64 -and $NativeArchitecture -ne [Runtime.InteropServices.Architecture]::Arm64) { throw '[RMI_ARCHITECTURE] The signed Windows runtime supports x64 or ARM64; no enrollment attempted.' }
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
$InstallerMutex = [Threading.Mutex]::new($false, 'Global\RunmeshInstaller-v1')
$InstallerLockHeld = $false
try {
  try { $InstallerLockHeld = $InstallerMutex.WaitOne(0) }
  catch [Threading.AbandonedMutexException] { $InstallerLockHeld = $true }
  if (-not $InstallerLockHeld) { throw 'Another Runmesh installer or uninstaller is running.' }
$script:StepIndex = 0
function Write-Step([string]$Message) { $script:StepIndex += 1; Write-Host ("  [{0}] {1}" -f $script:StepIndex, $Message) -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host ("[OK] {0}" -f $Message) -ForegroundColor Green }
function Write-Fail([string]$Message) { Write-Host ("[FAIL] {0}" -f $Message) -ForegroundColor Red }
function Write-LogFailure([string]$Message, [string]$LogPath, [int]$ExitCode, $ErrorRecord = $null) {
  Write-Fail $Message
  Write-Host ("  exit code: {0}" -f $ExitCode) -ForegroundColor DarkGray
  if ($EnrollmentAttempted) {
    Write-Host '  Credential handoff was attempted. Output is withheld to protect the code; inspect service status and credential state before retrying.'
  } elseif (Test-Path -LiteralPath $LogPath -PathType Leaf) {
    Get-Content -LiteralPath $LogPath -TotalCount 60 -ErrorAction SilentlyContinue | ForEach-Object { $line = $_ -replace '[A-Za-z0-9_-]{43,}', '[redacted]'; Write-Host ("  | {0}" -f $line.Substring(0, [Math]::Min($line.Length, 1024))) }
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
  $ExistingVersion = (& $ExistingRunner --version)
  if ($LASTEXITCODE -ne 0 -or ([string]$ExistingVersion).Trim() -ne $Version) { throw 'Installed Runner version differs from the fixed release; perform a verified manual upgrade before re-enrollment.' }
  if (-not (Select-String -LiteralPath $ServiceManifest -SimpleMatch 'runmesh-runner-managed:' -Quiet)) { throw 'Existing service is not managed by Runmesh; refusing to modify it.' }
  $RefreshLock = Join-Path $InstallRoot '.refresh.lock'
  try { New-Item -ItemType Directory -Path $RefreshLock -ErrorAction Stop | Out-Null } catch { throw 'Another Runmesh enrollment refresh is already running.' }
  try {
    Write-Step 'Refreshing credentials for the existing Runmesh Runner.'
    $EnrollmentCode = Read-EnrollmentCode $EnrollmentCodeArgument
    $EnrollmentCodeArgument = $null
    if ([string]::IsNullOrWhiteSpace($EnrollmentCode) -or $EnrollmentCode -notmatch '^[A-Za-z0-9_-]{43}$') { throw 'Invalid one-time enrollment code.' }
    $RefreshEnrollLog = Join-Path $InstallRoot ('.refresh-enroll.{0}.log' -f $PID)
    $RuntimePhase = 'enrollment'
  $EnrollmentAttempted = $true
    $EnrollmentCode | & $ExistingRunner enroll --profile $Profile --server $EnrollmentUrl --code-stdin --re-enroll __EXECUTION_MODE_FLAGS__ *> $RefreshEnrollLog
    if ($LASTEXITCODE -ne 0) { Write-LogFailure 'Refreshing credentials for the existing Runmesh Runner.' $RefreshEnrollLog $LASTEXITCODE; throw 'Enrollment refresh failed.' }
    $RefreshInstallLog = Join-Path $InstallRoot ('.refresh-install.{0}.log' -f $PID)
    & $ExistingRunner install --profile $Profile __EXECUTION_MODE_FLAGS__ --executable-path $ExistingRunner *> $RefreshInstallLog
    if ($LASTEXITCODE -ne 0) { Write-LogFailure 'Refreshing the installed service for the existing Runmesh Runner.' $RefreshInstallLog $LASTEXITCODE; throw 'Service installation refresh failed.' }
    $RefreshRestartLog = Join-Path $InstallRoot ('.refresh-restart.{0}.log' -f $PID)
    & $ExistingRunner restart --profile $Profile *> $RefreshRestartLog
    if ($LASTEXITCODE -ne 0) { Write-LogFailure 'Restarting the existing Runmesh Runner service.' $RefreshRestartLog $LASTEXITCODE; throw 'Runner service restart failed.' }
    Write-Ok 'Runmesh Runner credentials refreshed and service restarted in place.'
    return $true
  } finally { Remove-Variable EnrollmentCode -ErrorAction SilentlyContinue; try { Remove-Item -LiteralPath $RefreshLock -Force -ErrorAction SilentlyContinue } catch {} }
}
if ($MaintenanceAction -ne 'uninstall' -and (Test-Path -LiteralPath $CurrentRoot) -and (Test-Path -LiteralPath $Profile) -and (Test-Path -LiteralPath $ServiceManifest)) { if (Refresh-Existing) { exit 0 } }
if ($MaintenanceAction -ne 'uninstall' -and ((Test-Path -LiteralPath $CurrentRoot) -or (Test-Path -LiteralPath $VersionRoot) -or (Test-Path -LiteralPath $CurrentNew) -or (Test-Path -LiteralPath $Stage) -or (Test-Path -LiteralPath $Profile) -or (Test-Path -LiteralPath $ServiceManifest))) { throw 'Existing Runmesh installation or service state found; refusing to overwrite it.' }
if (-not $AutoInstallDeps) { throw '[RMI_RUNTIME_DISABLED] A new installation requires the private runtime; omit --no-auto-deps. No enrollment attempted.' }
$RuntimePhase = 'preflight'
try { Add-Type -AssemblyName System.IO.Compression.FileSystem } catch { throw '[RMI_ZIP_SUPPORT] The .NET ZIP library is unavailable. Use a supported Windows PowerShell 5.1 or PowerShell 7 session. No enrollment attempted.' }
foreach ($RequiredCommand in @('Invoke-WebRequest', 'Get-FileHash')) { if (-not (Get-Command $RequiredCommand -ErrorAction SilentlyContinue)) { throw ('[RMI_MISSING_TOOLS] Required PowerShell command is missing: ' + $RequiredCommand + '. Restore the standard PowerShell modules; no enrollment attempted.') } }
$TempRoot = Join-Path ([IO.Path]::GetTempPath()) ('runmesh-installer-' + [guid]::NewGuid().ToString('N'))
$ServiceAttempted = $false
$EnrollmentAttempted = $false
$ProfileCreated = $false
$StageCreated = $false
$VersionCreated = $false
$CurrentNewCreated = $false
$CurrentCreated = $false
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
  $RuntimePhase = 'runtime_download'
  Write-Step 'Preparing runtime'
  $ProgressPreference = 'SilentlyContinue'
  $NodeArchivePath = Join-Path $TempRoot $NodeAsset
  try { Invoke-WebRequest -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 120 -Uri $NodeUrl -OutFile $NodeArchivePath } catch { throw '[RMI_DOWNLOAD] Official runtime download failed. Check DNS, HTTPS trust, system clock, proxy and temporary disk space; do not disable TLS verification.' }
  if ((Get-Item -LiteralPath $NodeArchivePath).Length -le 0 -or (Get-Item -LiteralPath $NodeArchivePath).Length -gt __MAX_NODE_RUNTIME_BYTES__) { throw 'Private Node.js runtime archive size is invalid.' }
  $RuntimePhase = 'runtime_checksum'
  $NodeDigest = (Get-FileHash -LiteralPath $NodeArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($NodeDigest -ne $NodeSha256) { throw '[RMI_CHECKSUM_MISMATCH] Private Node.js runtime checksum verification failed; no extraction or enrollment was attempted.' }
  $NodeExtract = Join-Path $TempRoot 'node-runtime'
  $RuntimePhase = 'runtime_extract'
  # Use the system .NET ZIP implementation, not the optional Archive module.
  try { [IO.Compression.ZipFile]::ExtractToDirectory($NodeArchivePath, $NodeExtract) }
  catch { throw '[RMI_EXTRACT] Verified ZIP extraction failed. Check free disk space, directory permissions and antivirus interference; no enrollment attempted.' }
  $NodeHome = Join-Path $NodeExtract ([IO.Path]::GetFileNameWithoutExtension($NodeAsset))
  $NodePath = Join-Path $NodeHome 'node.exe'
  $NpmPath = Join-Path $NodeHome 'npm.cmd'
  if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf) -or -not (Test-Path -LiteralPath $NpmPath -PathType Leaf)) { throw 'Private Node.js runtime extraction failed.' }
  $RuntimePhase = 'runtime_execute'
  try { $ActualNodeVersion = & $NodePath --version 2>&1 } catch { throw '[RMI_RUNTIME_COMPATIBILITY] Extracted Node cannot start. Check supported Windows version, architecture and application-control policy.' }
  if ($LASTEXITCODE -ne 0 -or ([string]$ActualNodeVersion).Trim() -ne 'v__NODE_VERSION__') { throw '[RMI_RUNTIME_VERSION] The verified runtime cannot start or does not match the pinned version; no enrollment attempted.' }
  $HttpHandler = [Net.Http.HttpClientHandler]::new()
  $HttpHandler.AllowAutoRedirect = $false
  $HttpHandler.AutomaticDecompression = [Net.DecompressionMethods]::GZip -bor [Net.DecompressionMethods]::Deflate
  $HttpClient = [Net.Http.HttpClient]::new($HttpHandler)
  $HttpClient.Timeout = [TimeSpan]::FromSeconds(60)
  # ResponseHeadersRead ends HttpClient.Timeout at the headers. Keep one
  # deadline across redirects and body reads, including streams whose
  # ReadAsync implementation does not promptly honor cancellation.
  function Wait-ReleaseDownloadTask([Threading.Tasks.Task]$Task, [Threading.CancellationTokenSource]$Cancellation, [Diagnostics.Stopwatch]$Clock) {
    $remaining = [int][Math]::Max(0, 60000 - $Clock.ElapsedMilliseconds)
    if ($remaining -eq 0 -or -not $Task.Wait($remaining)) {
      $Cancellation.Cancel()
      throw 'Release download timed out.'
    }
    return $Task.GetAwaiter().GetResult()
  }
  $RuntimePhase = 'release_download'
  Write-Step 'Downloading Runner'
  foreach ($Name in @('manifest.json', 'manifest.sig', 'manifest.signature.json', 'SHA256SUMS', $ArtifactName)) {
    $DownloadCancellation = [Threading.CancellationTokenSource]::new()
    $DownloadCancellation.CancelAfter(60000)
    $DownloadClock = [Diagnostics.Stopwatch]::StartNew()
    try {
    $current = [Uri]::new($ReleaseBase + '/' + $Name)
    $downloaded = $false
    for ($attempt = 0; $attempt -lt 6; $attempt++) {
      $currentOrigin = $current.GetLeftPart([UriPartial]::Authority).TrimEnd('/')
      if ($current.Scheme -ne 'https' -or -not [string]::IsNullOrEmpty($current.UserInfo) -or $AllowedReleaseOrigins -notcontains $currentOrigin) { throw 'Release redirect escaped pinned origins.' }
      $response = $null
      try {
        $response = Wait-ReleaseDownloadTask ($HttpClient.GetAsync($current, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $DownloadCancellation.Token)) $DownloadCancellation $DownloadClock
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
          $stream = Wait-ReleaseDownloadTask ($response.Content.ReadAsStreamAsync()) $DownloadCancellation $DownloadClock
          $file = [IO.File]::Create((Join-Path $TempRoot $Name))
          $buffer = New-Object byte[] 65536
          [long]$total = 0
          while (($read = Wait-ReleaseDownloadTask ($stream.ReadAsync($buffer, 0, $buffer.Length, $DownloadCancellation.Token)) $DownloadCancellation $DownloadClock) -gt 0) {
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
    } finally {
      $DownloadCancellation.Cancel()
      $DownloadCancellation.Dispose()
      $DownloadClock.Stop()
    }
  }
  $VerifyLog = Join-Path $TempRoot 'release-verify.log'
  $RuntimePhase = 'release_verification'
  Invoke-LoggedStep 'Verifying Runner' $VerifyLog {
    @'
__VERIFIER__
'@ | & $NodePath --input-type=module - $TempRoot
  }
  if ($MaintenanceAction -eq 'uninstall') {
    $Maintenance = Join-Path $TempRoot 'maintenance'
    $MaintenanceLog = Join-Path $TempRoot 'maintenance-install.log'
    Push-Location -LiteralPath $TempRoot
    try {
      Invoke-LoggedStep 'Preparing cleanup tools' $MaintenanceLog {
        & $NpmPath --userconfig $EmptyUserConfig --globalconfig $EmptyGlobalConfig install --global --ignore-scripts --offline --no-audit --no-fund --prefix $Maintenance (Join-Path $TempRoot $ArtifactName)
      }
    } finally { Pop-Location }
    $MaintenanceRunner = Join-Path $Maintenance 'node_modules\@aloneio\runmesh-runner\dist\runmesh.cjs'
    & $NodePath $MaintenanceRunner uninstall --purge --yes
    if ($LASTEXITCODE -ne 0) { throw 'Runmesh cleanup is incomplete; see the remaining items above.' }
    $Succeeded = $true
    exit 0
  }
  New-Item -ItemType Directory -Path $VersionsRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $Stage -ErrorAction Stop | Out-Null
  $StageCreated = $true
  Push-Location -LiteralPath $TempRoot
  try {
    $InstallLog = Join-Path $TempRoot 'npm-install.log'
    $RuntimePhase = 'package_install'
    Invoke-LoggedStep 'Installing Runner' $InstallLog {
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
  $EnrollmentCode = Read-EnrollmentCode $EnrollmentCodeArgument
  $EnrollmentCodeArgument = $null
  $RuntimePhase = 'enrollment'
  $EnrollmentAttempted = $true
  $EnrollLog = Join-Path $TempRoot 'enroll.log'
  Invoke-LoggedStep 'Connecting to control plane' $EnrollLog {
    $EnrollmentCode | & $Runner enroll --profile $Profile --server $EnrollmentUrl --code-stdin __EXECUTION_MODE_FLAGS__
  }
  $ProfileCreated = $true
  $EnrollmentCode = $null
  Move-Item -LiteralPath $Stage -Destination $VersionRoot
  $StageCreated = $false
  $VersionCreated = $true
  New-Item -ItemType Junction -Path $CurrentNew -Target $VersionRoot | Out-Null
  $CurrentNewCreated = $true
  Move-Item -LiteralPath $CurrentNew -Destination $CurrentRoot
  $CurrentNewCreated = $false
  $CurrentCreated = $true
  $CurrentRunner = Join-Path $CurrentRoot 'runmesh.cmd'
  $ServiceAttempted = $true
  $ServiceLog = Join-Path $TempRoot 'service-install.log'
  $RuntimePhase = 'service_install'
  Invoke-LoggedStep 'Starting service' $ServiceLog {
    & $CurrentRunner install --profile $Profile __EXECUTION_MODE_FLAGS__ --executable-path $CurrentRunner
  }
  $Succeeded = $true
  Write-Ok "Runmesh Runner $Version is ready."
  Write-Host '  Service started automatically.'
  Write-Host ('  Status: & "' + $CurrentRunner + '" status --json')
} catch {
  Write-Fail ("[RMI_INSTALL_FAILED] stage={0}: Runmesh Runner installation failed." -f $RuntimePhase)
  if ($EnrollmentAttempted) { Write-Host '  Enrollment may have consumed the code. Verify credentials before retrying; do not repeatedly redeem it.' }
  else { Write-Host ('  ' + ($_.Exception.Message -replace '[A-Za-z0-9_-]{43,}', '[redacted]')); Write-Host '  Enrollment was not attempted; existing credentials were not changed.' }
  Write-Host '  Any local files created by this attempt will be rolled back where safe.' -ForegroundColor DarkGray
  throw
} finally {
  if ($null -ne $HttpClient) { $HttpClient.Dispose() }
  if ($null -ne $HttpHandler) { $HttpHandler.Dispose() }
  if (-not $Succeeded -and $MaintenanceAction -ne 'uninstall') {
    if ($ServiceAttempted -and $null -ne $CurrentRunner -and (Test-Path -LiteralPath $CurrentRunner)) { try { & $CurrentRunner uninstall --profile $Profile --json *> $null } catch {} }
    if ($ProfileCreated -and (Test-Path -LiteralPath $Profile)) { try { Remove-Item -LiteralPath $Profile -Force } catch {} }
    if ($CurrentNewCreated -and (Test-Path -LiteralPath $CurrentNew)) { try { [IO.Directory]::Delete($CurrentNew) } catch {} }
    if ($CurrentCreated -and (Test-Path -LiteralPath $CurrentRoot)) { try { [IO.Directory]::Delete($CurrentRoot) } catch {} }
    if ($StageCreated -and (Test-Path -LiteralPath $Stage)) { try { Remove-Item -LiteralPath $Stage -Recurse -Force } catch {} }
    if ($VersionCreated -and (Test-Path -LiteralPath $VersionRoot)) { try { Remove-Item -LiteralPath $VersionRoot -Recurse -Force } catch {} }
  }
  if (Test-Path -LiteralPath $TempRoot) { try { Remove-Item -LiteralPath $TempRoot -Recurse -Force } catch {} }
}
} finally {
  if ($InstallerLockHeld) { $InstallerMutex.ReleaseMutex() }
  $InstallerMutex.Dispose()
}
`;

export type InstallerExecutionMode = "dedicated_user" | "privileged_host";

function replaceInstallerTemplate(template: string, enrollmentUrl: string, literal: (value: string) => string, executionMode: InstallerExecutionMode, action: "install" | "uninstall" = "install", release: InstallerReleaseTarget = FIXED_INSTALLER_RELEASE): string {
  if (executionMode !== "dedicated_user" && executionMode !== "privileged_host") throw new Error("invalid installer execution mode");
  const modeFlags = executionMode === "privileged_host"
    ? "--execution-mode privileged_host --confirm-privileged-host"
    : "--execution-mode dedicated_user";
  const node = FIXED_NODE_RUNTIME_ASSETS;
  return template
    .replace("__POSIX_INSTALLER_PREFLIGHT__", POSIX_INSTALLER_PREFLIGHT)
    .replace("__CODE_EQUALS_VALUE__", "${1#--code=}")
    .replace("__TEMP_PARENT__", "${TMPDIR:-/tmp}")
    .replaceAll("__ACTION__", action)
    .replaceAll("__NO_COLOR__", "${NO_COLOR:-}")    .replaceAll("__EXECUTION_MODE_FLAGS__", modeFlags)
    .replaceAll("__VERSION__", literal(release.version))
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
    .replaceAll("__RELEASE_BASE__", literal(release.release_base_url))
    .replaceAll("__ARTIFACT_NAME__", literal(release.artifact_name))
    .replaceAll("__ENROLLMENT_URL__", literal(enrollmentUrl))
    .replaceAll("__MAX_RELEASE_ASSET_BYTES__", String(MAX_RELEASE_ASSET_BYTES))
    .replace("__RELEASE_REDIRECT_ORIGINS_JSON__", JSON.stringify(FIXED_RELEASE_ALLOWED_REDIRECT_ORIGINS))
    .replace("__RELEASE_REDIRECT_ORIGINS_PS__", FIXED_RELEASE_ALLOWED_REDIRECT_ORIGINS.map((value) => powershellQuote(value)).join(", "))
    .replace("__VERIFIER__", verifierSource(release));
}

export function renderPosixInstaller(requestOrigin: string, executionMode: InstallerExecutionMode = "privileged_host", release: InstallerReleaseTarget = FIXED_INSTALLER_RELEASE): string {
  const publicOrigin = canonicalPublicOrigin(requestOrigin);
  return replaceInstallerTemplate(POSIX_TEMPLATE, `${publicOrigin}/runner/enroll`, shellLiteral, executionMode, "install", release);
}

export function renderPowerShellInstaller(requestOrigin: string, executionMode: InstallerExecutionMode = "privileged_host", release: InstallerReleaseTarget = FIXED_INSTALLER_RELEASE): string {
  const publicOrigin = canonicalPublicOrigin(requestOrigin);
  return replaceInstallerTemplate(POWERSHELL_TEMPLATE, `${publicOrigin}/runner/enroll`, powershellLiteral, executionMode, "install", release);
}

export function renderPosixUninstaller(requestOrigin: string, release: InstallerReleaseTarget = FIXED_INSTALLER_RELEASE): string {
  return replaceInstallerTemplate(POSIX_TEMPLATE, `${canonicalPublicOrigin(requestOrigin)}/runner/enroll`, shellLiteral, "dedicated_user", "uninstall", release);
}

export function renderPowerShellUninstaller(requestOrigin: string, release: InstallerReleaseTarget = FIXED_INSTALLER_RELEASE): string {
  return replaceInstallerTemplate(POWERSHELL_TEMPLATE, `${canonicalPublicOrigin(requestOrigin)}/runner/enroll`, powershellLiteral, "dedicated_user", "uninstall", release);
}
