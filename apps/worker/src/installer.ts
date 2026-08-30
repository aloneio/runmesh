/**
 * Fixed, source-reviewed hosted-bootstrap contract. The Worker HTTPS endpoint
 * that serves an installer is the one-command bootstrap trust root. Release
 * assets are authenticated with this embedded key; a downloaded keyring is
 * never fetched or used by an installer.
 */
export const FIXED_RELEASE_VERSION = "0.1.0-dev.2";
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

function origin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") throw new Error("installer origin must be HTTPS without credentials, query, or fragment");
  return url.origin;
}

/* This source deliberately has no trust-keyring download. */
const VERIFY_RELEASE = String.raw`import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
const directory = process.argv[2];
const version = "__VERSION__";
const keyId = "__KEY_ID__";
const artifactName = "__ARTIFACT_NAME__";
const artifactUrl = "__ARTIFACT_URL__";
const publicKeyPem = __PUBLIC_KEY_PEM__;
const fail = (message) => { throw new Error("release verification failed: " + message); };
const parse = async (name) => { try { return JSON.parse(await readFile(join(directory, name), "utf8")); } catch { fail("invalid " + name); } };
const manifestBytes = await readFile(join(directory, "manifest.json"));
const descriptor = await parse("manifest.signature.json");
if (descriptor?.schema_version !== 1 || descriptor.algorithm !== "ed25519" || descriptor.key_id !== keyId || descriptor.encoding !== "base64" || descriptor.signed_file !== "manifest.json") fail("invalid signature descriptor");
const encodedSignature = (await readFile(join(directory, "manifest.sig"), "utf8")).trim();
if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encodedSignature)) fail("signature is not canonical base64");
const signature = Buffer.from(encodedSignature, "base64");
if (signature.length !== 64 || signature.toString("base64") !== encodedSignature || !verify(null, manifestBytes, createPublicKey(publicKeyPem), signature)) fail("signature does not verify");
const manifest = await parse("manifest.json");
const artifact = Array.isArray(manifest?.artifacts) && manifest.artifacts.length === 1 ? manifest.artifacts[0] : undefined;
if (manifest?.schema_version !== 1 || manifest.project !== "runmesh" || manifest.version !== version || manifest.tag !== "v" + version || manifest.channel !== "dev" || manifest.prerelease !== true || !/^[0-9a-f]{40}$/.test(manifest.commit_sha) || manifest.protocol_min !== 2 || manifest.protocol_max !== 2 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(manifest.published_at)) fail("manifest fields are not the fixed preview contract");
if (artifact?.name !== artifactName || artifact.platform !== "node" || artifact.architecture !== "portable" || artifact.node_major_min !== 20 || artifact.url !== artifactUrl || !Number.isSafeInteger(artifact.size) || artifact.size <= 0 || !/^[0-9a-f]{64}$/.test(artifact.sha256)) fail("manifest artifact is invalid");
const artifactPath = join(directory, artifactName);
const metadata = await stat(artifactPath);
const digest = createHash("sha256").update(await readFile(artifactPath)).digest("hex");
if (!metadata.isFile() || metadata.size !== artifact.size || digest !== artifact.sha256) fail("artifact size or SHA-256 mismatch");
const sums = await readFile(join(directory, "SHA256SUMS"), "utf8");
if (!sums.split(/\r?\n/).some((line) => line === digest + "  " + artifactName || line === digest + " *" + artifactName)) fail("SHA256SUMS does not match authenticated artifact");
`;

function verifierSource(): string {
  return VERIFY_RELEASE
    .replaceAll("__VERSION__", FIXED_RELEASE_VERSION)
    .replaceAll("__KEY_ID__", FIXED_RELEASE_KEY_ID)
    .replaceAll("__ARTIFACT_NAME__", FIXED_ARTIFACT_NAME)
    .replaceAll("__ARTIFACT_URL__", FIXED_ARTIFACT_URL)
    .replace("__PUBLIC_KEY_PEM__", JSON.stringify(FIXED_RELEASE_PUBLIC_KEY_PEM));
}

const POSIX_TEMPLATE = String.raw`#!/usr/bin/env sh
# Fixed signed Runmesh preview bootstrap. This Worker HTTPS response is the
# bootstrap trust root. This script verifies the GitHub artifact with its
# embedded Ed25519 public key and never trusts a downloaded keyring.
set -eu
umask 077
VERSION='__VERSION__'
RELEASE_BASE='__RELEASE_BASE__'
ARTIFACT='__ARTIFACT_NAME__'
ENROLLMENT_URL='__ENROLLMENT_URL__'
INSTALL_ROOT='/opt/runmesh'
if [ "$(id -u)" -ne 0 ]; then printf '%s\n' 'error: run from an elevated root shell' >&2; exit 1; fi
case "$(uname -s)" in
  Linux) PROFILE='/etc/runmesh/profile.json'; SERVICE_MANIFEST='/etc/systemd/system/runmesh-runner.service' ;;
  Darwin) PROFILE='/Library/Application Support/Runmesh/profile.json'; SERVICE_MANIFEST='/Library/LaunchDaemons/io.alone.runmesh.runner.plist' ;;
  *) printf '%s\n' 'error: Linux or macOS is required' >&2; exit 1;;
esac
for command_name in curl node npm stty readlink; do command -v "$command_name" >/dev/null 2>&1 || { printf '%s\n' "error: $command_name is required" >&2; exit 1; }; done
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
case "$NODE_MAJOR" in ''|*[!0-9]*) printf '%s\n' 'error: unable to determine Node.js version' >&2; exit 1;; esac
if [ "$NODE_MAJOR" -lt 20 ]; then printf '%s\n' 'error: Node.js 20 or newer is required' >&2; exit 1; fi
has_path() { [ -e "$1" ] || [ -L "$1" ]; }
if has_path "$INSTALL_ROOT/current" || has_path "$INSTALL_ROOT/versions/$VERSION" || has_path "$INSTALL_ROOT/versions/$VERSION.staging.$$" || has_path "$PROFILE" || has_path "$SERVICE_MANIFEST"; then printf '%s\n' 'error: existing Runmesh installation or service state found; refusing to overwrite it' >&2; exit 1; fi
TMP="$(mktemp -d /tmp/runmesh-installer.XXXXXX)"
STAGE="$INSTALL_ROOT/versions/$VERSION.staging.$$"
CURRENT_NEW="$INSTALL_ROOT/current.new"
TTY_ECHO_DISABLED=0
FINAL_CREATED=0
CURRENT_CREATED=0
cleanup_tty() { if [ "$TTY_ECHO_DISABLED" -eq 1 ]; then stty echo < /dev/tty 2>/dev/null || true; TTY_ECHO_DISABLED=0; fi; }
cleanup() { cleanup_tty; rm -rf "$TMP"; }
rollback() {
  rc="$1"
  cleanup_tty
  if [ "$CURRENT_CREATED" -eq 1 ] && [ -L "$CURRENT_NEW" ]; then rm -f "$CURRENT_NEW"; fi
  if [ "$CURRENT_CREATED" -eq 1 ] && [ -L "$INSTALL_ROOT/current" ] && [ "$(readlink "$INSTALL_ROOT/current")" = "$FINAL" ]; then "$INSTALL_ROOT/current/bin/coding-runner" uninstall --profile "$PROFILE" --purge --yes --json >/dev/null 2>&1 || true; rm -f "$INSTALL_ROOT/current"; fi
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
trap on_exit EXIT HUP INT TERM
download() { curl --fail --location --proto '=https' --tlsv1.2 --retry 0 --output "$TMP/$1" "$RELEASE_BASE/$1"; }
download manifest.json
download manifest.sig
download manifest.signature.json
download SHA256SUMS
download "$ARTIFACT"
node --input-type=module - "$TMP" <<'RUNMESH_VERIFY'
__VERIFIER__
RUNMESH_VERIFY
mkdir -p "$INSTALL_ROOT/versions"
npm install --global --ignore-scripts --offline --no-audit --no-fund --prefix "$STAGE" "$TMP/$ARTIFACT"
RUNNER="$STAGE/bin/coding-runner"
RUNMESH_RUNNER="$STAGE/bin/runmesh-runner"
[ -x "$RUNNER" ] || { printf '%s\n' 'error: verified package did not install coding-runner' >&2; exit 1; }
[ -x "$RUNMESH_RUNNER" ] || { printf '%s\n' 'error: verified package did not install runmesh-runner' >&2; exit 1; }
[ "$("$RUNNER" --version)" = "$VERSION" ] || { printf '%s\n' 'error: installed coding-runner version mismatch' >&2; exit 1; }
[ "$("$RUNMESH_RUNNER" --version)" = "$VERSION" ] || { printf '%s\n' 'error: installed runmesh-runner version mismatch' >&2; exit 1; }
"$RUNNER" --help | grep -F 'usage: runmesh-runner' >/dev/null
"$RUNMESH_RUNNER" --help | grep -F 'usage: runmesh-runner' >/dev/null
printf '%s' 'Paste the one-time enrollment code (input is hidden): ' >/dev/tty
stty -echo < /dev/tty || { printf '%s\n' 'error: terminal input cannot be protected' >&2; exit 1; }
TTY_ECHO_DISABLED=1
if ! IFS= read -r ENROLLMENT_CODE < /dev/tty; then printf '\n%s\n' 'error: unable to read enrollment code from terminal' >&2; exit 1; fi
cleanup_tty
printf '\n' >/dev/tty
printf '%s\n' "$ENROLLMENT_CODE" | "$RUNNER" enroll --profile "$PROFILE" --server "$ENROLLMENT_URL" --code-stdin
unset ENROLLMENT_CODE
mv "$STAGE" "$FINAL"
FINAL_CREATED=1
ln -s "$FINAL" "$INSTALL_ROOT/current.new"
mv "$INSTALL_ROOT/current.new" "$INSTALL_ROOT/current"
CURRENT_CREATED=1
"$INSTALL_ROOT/current/bin/coding-runner" install --profile "$PROFILE" --executable-path "$INSTALL_ROOT/current/bin/coding-runner"
printf '%s\n' "Runmesh Runner $VERSION installed and enrolled."
`;

const POWERSHELL_TEMPLATE = String.raw`$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# This Worker HTTPS response is the bootstrap trust root. Release assets are
# verified with the embedded Ed25519 key below, never a downloaded keyring.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Version = '__VERSION__'
$ReleaseBase = '__RELEASE_BASE__'
$ArtifactName = '__ARTIFACT_NAME__'
$EnrollmentUrl = '__ENROLLMENT_URL__'
$InstallRoot = Join-Path $env:ProgramFiles 'Runmesh'
$Principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run from an elevated Administrator PowerShell session.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'Node.js 20 or newer and npm are required.' }
$NodeMajor = [int]((& node --version).Trim().TrimStart('v').Split('.')[0])
if ($NodeMajor -lt 20) { throw 'Node.js 20 or newer is required.' }
$VersionsRoot = Join-Path $InstallRoot 'versions'
$VersionRoot = Join-Path $VersionsRoot $Version
$CurrentRoot = Join-Path $InstallRoot 'current'
$CurrentNew = Join-Path $InstallRoot 'current.new'
$Profile = Join-Path $env:ProgramData 'Runmesh\profile.json'
$ServiceManifest = Join-Path $env:ProgramData 'Runmesh\RunmeshRunner.xml'
if ((Test-Path -LiteralPath $CurrentRoot) -or (Test-Path -LiteralPath $VersionRoot) -or (Test-Path -LiteralPath $CurrentNew) -or (Test-Path -LiteralPath $Profile) -or (Test-Path -LiteralPath $ServiceManifest)) { throw 'Existing Runmesh installation or service state found; refusing to overwrite it.' }
$TempRoot = Join-Path ([IO.Path]::GetTempPath()) ('runmesh-installer-' + [guid]::NewGuid().ToString('N'))
$Stage = Join-Path $VersionsRoot ($Version + '.staging.' + $PID)
$ServiceAttempted = $false
$Succeeded = $false
$CurrentRunner = $null
New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null
try {
  foreach ($Name in @('manifest.json', 'manifest.sig', 'manifest.signature.json', 'SHA256SUMS', $ArtifactName)) {
    Invoke-WebRequest -UseBasicParsing -MaximumRedirection 5 -Uri ($ReleaseBase + '/' + $Name) -OutFile (Join-Path $TempRoot $Name)
  }
  @'
__VERIFIER__
'@ | node --input-type=module - $TempRoot
  if ($LASTEXITCODE -ne 0) { throw 'Release verification failed.' }
  New-Item -ItemType Directory -Path $VersionsRoot -Force | Out-Null
  npm.cmd install --global --ignore-scripts --offline --no-audit --no-fund --prefix $Stage (Join-Path $TempRoot $ArtifactName)
  if ($LASTEXITCODE -ne 0) { throw 'Verified local tarball installation failed.' }
  $Runner = Get-ChildItem -LiteralPath $Stage -Filter 'coding-runner.cmd' -File -Recurse | Select-Object -First 1
  $RunmeshRunner = Get-ChildItem -LiteralPath $Stage -Filter 'runmesh-runner.cmd' -File -Recurse | Select-Object -First 1
  if ($null -eq $Runner -or $null -eq $RunmeshRunner) { throw 'Verified package did not install both Runner entry points.' }
  if ((& $Runner.FullName --version).Trim() -ne $Version) { throw 'Installed coding-runner version mismatch.' }
  if ((& $RunmeshRunner.FullName --version).Trim() -ne $Version) { throw 'Installed runmesh-runner version mismatch.' }
  & $Runner.FullName --help | Select-String -SimpleMatch 'usage: runmesh-runner' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Installed coding-runner help check failed.' }
  & $RunmeshRunner.FullName --help | Select-String -SimpleMatch 'usage: runmesh-runner' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Installed runmesh-runner help check failed.' }
  $SecureCode = Read-Host 'Paste the one-time enrollment code (input is hidden)' -AsSecureString
  $CodePointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureCode)
  try { $EnrollmentCode = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($CodePointer) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($CodePointer) }
  if ([string]::IsNullOrWhiteSpace($EnrollmentCode)) { throw 'An enrollment code is required.' }
  $EnrollmentCode | & $Runner.FullName enroll --profile $Profile --server $EnrollmentUrl --code-stdin
  $EnrollmentCode = $null
  $SecureCode = $null
  if ($LASTEXITCODE -ne 0) { throw 'Enrollment failed.' }
  Move-Item -LiteralPath $Stage -Destination $VersionRoot
  New-Item -ItemType Junction -Path $CurrentNew -Target $VersionRoot | Out-Null
  Move-Item -LiteralPath $CurrentNew -Destination $CurrentRoot
  $CurrentRunner = Join-Path $CurrentRoot 'coding-runner.cmd'
  $ServiceAttempted = $true
  & $CurrentRunner install --profile $Profile --executable-path $CurrentRunner
  if ($LASTEXITCODE -ne 0) { throw 'Service installation failed after enrollment.' }
  $Succeeded = $true
  Write-Output "Runmesh Runner $Version installed and enrolled."
} finally {
  if (-not $Succeeded) {
    if ($ServiceAttempted -and $null -ne $CurrentRunner -and (Test-Path -LiteralPath $CurrentRunner)) { try { & $CurrentRunner uninstall --profile $Profile --purge --yes --json *> $null } catch {} }
    foreach ($Path in @($CurrentNew, $CurrentRoot, $Stage, $VersionRoot)) { if (Test-Path -LiteralPath $Path) { try { Remove-Item -LiteralPath $Path -Recurse -Force } catch {} } }
  }
  if (Test-Path -LiteralPath $TempRoot) { try { Remove-Item -LiteralPath $TempRoot -Recurse -Force } catch {} }
}
`;

function replaceInstallerTemplate(template: string, enrollmentUrl: string): string {
  return template
    .replaceAll("__VERSION__", FIXED_RELEASE_VERSION)
    .replaceAll("__RELEASE_BASE__", FIXED_RELEASE_BASE_URL)
    .replaceAll("__ARTIFACT_NAME__", FIXED_ARTIFACT_NAME)
    .replaceAll("__ENROLLMENT_URL__", enrollmentUrl)
    .replace("__VERIFIER__", verifierSource());
}

export function renderPosixInstaller(requestOrigin: string): string {
  return replaceInstallerTemplate(POSIX_TEMPLATE, `${origin(requestOrigin)}/runner/enroll`);
}

export function renderPowerShellInstaller(requestOrigin: string): string {
  return replaceInstallerTemplate(POWERSHELL_TEMPLATE, `${origin(requestOrigin)}/runner/enroll`);
}
