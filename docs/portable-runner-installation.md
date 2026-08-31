# Portable Runner artifact verification and installation

This page describes the manual, reproducible installation path for a Runmesh Runner `.tgz` release asset. Hosted bootstrap, automatic download, update, and rollback are not included in `v0.1.0-dev.2`.

## Trust root

Do not trust a `trust-keyring.json` merely because it was downloaded beside the artifact. Start from a reviewed Runmesh source checkout at the release commit, or another independently authenticated copy of:

```text
release/trust-keyring.json
```

Record the expected signing key ID from that trusted checkout. The current preview key ID is:

```text
runmesh-preview-2026-01
```

The downloaded `trust-keyring.json` is informational. Compare it byte-for-byte with the trusted checkout only after verifying the manifest with the trusted checkout keyring.

## Download

Download these assets for the selected prerelease into an empty directory:

```text
runmesh-runner-<version>.tgz
manifest.json
manifest.sig
manifest.signature.json
SHA256SUMS
trust-keyring.json
LICENSE
NOTICE
THIRD_PARTY_NOTICES.md
```

Keep the trusted source checkout outside that download directory.

## Verify the signature and checksums

From the trusted source checkout, set the download directory and expected key ID. The
POSIX commands below are intended for Linux, macOS, `bash`, or `zsh`:

```bash
set -eu
DOWNLOAD=/absolute/path/to/runmesh-release-download
TRUSTED_KEYRING="$PWD/release/trust-keyring.json"
KEY_ID=runmesh-preview-2026-01

node scripts/release-verify.mjs \
  "$DOWNLOAD/manifest.json" \
  "$DOWNLOAD/manifest.sig" \
  "$DOWNLOAD/manifest.signature.json" \
  "$TRUSTED_KEYRING" \
  "$KEY_ID" \
  '<version>'

(
  cd "$DOWNLOAD"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c SHA256SUMS
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -c SHA256SUMS
  else
    printf '%s\n' 'Neither sha256sum nor shasum is available.' >&2
    exit 1
  fi
)

cmp "$DOWNLOAD/trust-keyring.json" "$TRUSTED_KEYRING"
```

Stop if any command fails. `release-verify.mjs` verifies the manifest signature with `TRUSTED_KEYRING`, validates the manifest schema/version, and compares the local tarball size and SHA-256 digest to the authenticated `manifest.artifacts[]` entry. It never trusts the downloaded keyring as a trust root. `SHA256SUMS` is an additional convenience check.

Confirm that the manifest identifies the expected version and source commit before installation:

```sh
node -e '
const fs = require("node:fs");
const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
console.log({ version: m.version, tag: m.tag, commit_sha: m.commit_sha, artifacts: m.artifacts });
' "$DOWNLOAD/manifest.json"
```

On Windows, run the equivalent checks from an elevated PowerShell session. The
checksum parser rejects paths that would escape the download directory:

```powershell
$ErrorActionPreference = 'Stop'
$Download = 'C:\path\to\runmesh-release-download'
$TrustedCheckout = 'C:\path\to\trusted-runmesh-checkout'
$TrustedKeyring = Join-Path $TrustedCheckout 'release\trust-keyring.json'
$KeyId = 'runmesh-preview-2026-01'
$Version = '<version>'

node (Join-Path $TrustedCheckout 'scripts\release-verify.mjs') `
  (Join-Path $Download 'manifest.json') `
  (Join-Path $Download 'manifest.sig') `
  (Join-Path $Download 'manifest.signature.json') `
  $TrustedKeyring $KeyId $Version
if ($LASTEXITCODE -ne 0) { throw 'Release signature and manifest verification failed.' }

foreach ($line in Get-Content -LiteralPath (Join-Path $Download 'SHA256SUMS')) {
  if ($line -notmatch '^(?<hash>[0-9a-fA-F]{64})  (?<name>.+)$') { throw "Malformed SHA256SUMS line" }
  $name = $Matches.name
  if ([IO.Path]::GetFileName($name) -cne $name) { throw "Unsafe checksum filename: $name" }
  $path = Join-Path $Download $name
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing checksum file: $name" }
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
  if ($actual -cne $Matches.hash.ToLowerInvariant()) { throw "Checksum mismatch: $name" }
}

$downloadedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Download 'trust-keyring.json')).Hash
$trustedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $TrustedKeyring).Hash
if ($downloadedHash -cne $trustedHash) { throw 'Downloaded trust-keyring.json differs from the trusted checkout.' }
node -e "const fs=require('node:fs'); const m=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); console.log({version:m.version,tag:m.tag,commit_sha:m.commit_sha,artifacts:m.artifacts});" (Join-Path $Download 'manifest.json')
```

## Install from the verified local tarball

Node.js 20 or newer is required. Install only from the local verified file; do not replace it with a package name or a moving URL. The managed service must use an executable installed under the Runmesh service layout, not an unrelated npm global prefix.

### Linux

```bash
set -eu
VERSION='<version>'
ARTIFACT="$DOWNLOAD/runmesh-runner-$VERSION.tgz"
if [ -e /opt/runmesh/current ] || [ -L /opt/runmesh/current ] || [ -e "/opt/runmesh/versions/$VERSION" ]; then
  printf '%s\n' 'An existing Runmesh installation was found; stop and inspect it before installing.' >&2
  exit 1
fi
sudo mkdir -p "/opt/runmesh/versions/$VERSION"
sudo npm install --global --ignore-scripts \
  --offline --no-audit --no-fund \
  --prefix "/opt/runmesh/versions/$VERSION" \
  "$ARTIFACT"
sudo ln -s "/opt/runmesh/versions/$VERSION" /opt/runmesh/current.new
sudo mv /opt/runmesh/current.new /opt/runmesh/current
sudo "/opt/runmesh/current/bin/coding-runner" --version
```

### macOS

Use the same versioned `/opt/runmesh` layout from an elevated shell:

```bash
set -eu
VERSION='<version>'
ARTIFACT="$DOWNLOAD/runmesh-runner-$VERSION.tgz"
if [ -e /opt/runmesh/current ] || [ -L /opt/runmesh/current ] || [ -e "/opt/runmesh/versions/$VERSION" ]; then
  printf '%s\n' 'An existing Runmesh installation was found; stop and inspect it before installing.' >&2
  exit 1
fi
sudo mkdir -p "/opt/runmesh/versions/$VERSION"
sudo npm install --global --ignore-scripts \
  --offline --no-audit --no-fund \
  --prefix "/opt/runmesh/versions/$VERSION" \
  "$ARTIFACT"
sudo ln -s "/opt/runmesh/versions/$VERSION" /opt/runmesh/current.new
sudo mv /opt/runmesh/current.new /opt/runmesh/current
sudo "/opt/runmesh/current/bin/coding-runner" --help
```

### Windows PowerShell

Run an elevated PowerShell session:

```powershell
$Download = 'C:\path\to\runmesh-release-download'
$Version = '<version>'
$Artifact = Join-Path $Download "runmesh-runner-$Version.tgz"
$VersionRoot = "C:\Program Files\Runmesh\versions\$Version"
$CurrentRoot = "C:\Program Files\Runmesh\current"
if ((Test-Path -LiteralPath $CurrentRoot) -or (Test-Path -LiteralPath $VersionRoot)) { throw 'An existing Runmesh installation was found; stop and inspect it before installing.' }
New-Item -ItemType Directory -Force -Path $VersionRoot | Out-Null
npm.cmd install --global --ignore-scripts --offline --no-audit --no-fund --prefix $VersionRoot $Artifact
if ($LASTEXITCODE -ne 0) { throw 'Local Runner artifact installation failed.' }
$Runner = Get-ChildItem -LiteralPath $VersionRoot -Filter 'coding-runner.cmd' -File -Recurse | Select-Object -First 1
if ($null -eq $Runner) { throw 'coding-runner.cmd was not found under the versioned install root.' }
& $Runner.FullName --version
if ($LASTEXITCODE -ne 0) { throw 'Installed Runner version check failed.' }
New-Item -ItemType Junction -Path $CurrentRoot -Target $VersionRoot | Out-Null
```

The exact npm Windows shim location can vary by npm version. Confirm the installed `coding-runner.cmd` path under `$VersionRoot` before creating the junction; pass that exact absolute path to `--executable-path`.

## Confirm and activate the installed Runner

Run the version/help checks from the same absolute executable used by the
service. `doctor --json` is the service-health probe; `status --json` is only a
redacted profile summary and intentionally does not query the host service
manager.

On Linux or macOS (in `bash` or `zsh`):

```bash
set -euo pipefail
RUNNER=/opt/runmesh/current/bin/coding-runner
SERVER=https://your-runmesh.example/runner/enroll
"$RUNNER" --version
"$RUNNER" --help

printf '%s' 'One-time enrollment code: ' >&2
read -r -s RUNMESH_ENROLLMENT_CODE
printf '\n' >&2
printf '%s\n' "$RUNMESH_ENROLLMENT_CODE" | sudo "$RUNNER" enroll --server "$SERVER" --code-stdin
unset RUNMESH_ENROLLMENT_CODE

sudo "$RUNNER" install --executable-path "$RUNNER"
sudo "$RUNNER" doctor --json
```

On Windows PowerShell (use the exact shim path discovered during installation):

```powershell
$ErrorActionPreference = 'Stop'
$CurrentRoot = 'C:\Program Files\Runmesh\current'
$RunnerPath = (Get-ChildItem -LiteralPath $CurrentRoot -Filter 'coding-runner.cmd' -File -Recurse | Select-Object -First 1).FullName
if ([string]::IsNullOrWhiteSpace($RunnerPath)) { throw 'coding-runner.cmd was not found under the current install.' }
$Server = 'https://your-runmesh.example/runner/enroll'
& $RunnerPath --version
if ($LASTEXITCODE -ne 0) { throw 'Installed Runner version check failed.' }
& $RunnerPath --help
if ($LASTEXITCODE -ne 0) { throw 'Installed Runner help check failed.' }

try {
  $EnrollmentCode = Read-Host 'One-time enrollment code'
  $EnrollmentCode | & $RunnerPath enroll --server $Server --code-stdin
  if ($LASTEXITCODE -ne 0) { throw 'Runner enrollment failed.' }
} finally {
  Remove-Variable EnrollmentCode -ErrorAction SilentlyContinue
}

& $RunnerPath install --executable-path $RunnerPath
if ($LASTEXITCODE -ne 0) { throw 'Runner service installation failed.' }
& $RunnerPath doctor --json
if ($LASTEXITCODE -ne 0) { throw 'Runner doctor check failed.' }
```

`coding-runner --version` must equal the manifest version, and `doctor --json`
must return structured checks. The enrollment code is single-use and is not a
long-term Runner credential; never place it in logs, shell history, issue
reports, or configuration management.
