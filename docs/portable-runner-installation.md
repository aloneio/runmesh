# Portable Runner installation and hosted bootstrap

Use this page to transfer a package from another machine, verify it independently, or install it manually. Verification and local package installation can run offline; enrollment and ordinary Runner operation require access to the Worker. For dashboard setup, start with the [administrator guide](admin-guide.md).

Choose a package using [release status](release-readiness.md). The latest published stable package is **0.1.4**. Reviewed activation enables stable hosted distribution in source; check your Worker's release descriptor below before installing. Development has its own verified prerelease channel. Manual installation needs an external Node runtime: 22.23.2+ within 22.x, or 24.21.0+ within 24.x.

Ordinary HTTPS deployments use the validated request address. For a reverse proxy, configure the optional `RUNMESH_PUBLIC_ORIGIN` as described in [runtime configuration](runtime-config.md). An invalid origin closes hosted installation.

For hosted installation, check `channel` and `distributable` in `/runner/releases/latest`. The `/runner/releases/stable` and `/runner/releases/dev` descriptors show the separate channels. When the public origin and verified release are available, the matching `/runner/install.sh` or `/runner/install.ps1` can be used.

## Choose how to verify

The one-command path trusts the script served by your HTTPS Worker. The current stable installer template fixes these release inputs:

- version `0.1.4` and tag `v0.1.4`;
- the exact GitHub release-asset URLs and `runmesh-runner-0.1.4.tgz` name;
- signing key ID `runmesh-preview-2026-01`;
- the reviewed Ed25519 public key from `release/trust-keyring.json`.

The development installer fixes the exact verified dev version and tag selected by the Worker, using the same embedded trust key. Availability follows the release descriptor above.

The installer fetches the signed manifest, signature metadata, checksums and fixed tarball. Each accepted asset must be non-empty and at most 8 MiB. It verifies the Ed25519 signature, release identity, artifact size and SHA-256, then installs the local tarball with npm scripts disabled. Keep these fixed-asset and signature checks enabled.

For verification independent of the Worker-delivered script and its embedded key, use the offline path below with a separately trusted source keyring.

## Enabled hosted-bootstrap commands

Use these commands when the authenticated enrollment page shows the release as available, and replace the hostname with your configured public origin. The snippets prompt for the enrollment code; dashboard convenience commands include it. Scripts also accept `--code CODE` and `--code=CODE`, then pass the code to the Runner through standard input. Keep commands containing a code private, including shell history and process arguments.

The snippets limit the installer script to 256 KiB; the script applies a separate 8 MiB limit to each fixed release asset.

Linux or macOS, from an elevated shell:

```sh
set -eu
installer="$(mktemp)"
trap 'rm -f "$installer"' EXIT
curl -q --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --max-redirs 0 --max-time 60 --max-filesize 262144 --output "$installer" 'https://your-runmesh.example/runner/install.sh?execution_mode=dedicated_user'
test -s "$installer"
sudo sh "$installer"
```

Windows, from an elevated **interactive** PowerShell session:

```powershell
$ErrorActionPreference = 'Stop'
$installer = Join-Path ([IO.Path]::GetTempPath()) ('runmesh-installer-' + [guid]::NewGuid().ToString('N') + '.ps1')
try {
  Invoke-WebRequest -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 60 -ErrorAction Stop -OutFile $installer -Uri 'https://your-runmesh.example/runner/install.ps1?execution_mode=dedicated_user'
  # HTTP errors terminate with ErrorAction Stop; OutFile does not return a response object.
  if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw 'Installer download did not produce a file.' }
  $length = (Get-Item -LiteralPath $installer).Length
  if ($length -le 0 -or $length -gt 262144) { throw 'Installer download size is invalid.' }
  & ([scriptblock]::Create([IO.File]::ReadAllText($installer)))
} finally {
  Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
}
```

This example prompts for the enrollment code. If you remove the code from a
dashboard-generated Windows command, also remove `-NonInteractive` from its
PowerShell invocation and run it in an interactive administrator terminal
so the hidden prompt can read input.

Run the installer with administrator privileges. A new installation downloads and verifies the host-specific Node.js `22.23.2` runtime into the versioned Runmesh directory. It checks the staged CLI before enrollment and installs with private npm configuration/cache paths, `--offline` and `--ignore-scripts`. The service uses that private runtime. Existing paths, profiles or service conflicts require inspection before proceeding.

A complete managed installation of the **same exact version** uses the installed runtime to refresh enrollment and service configuration, then **restarts the service**. For a version change, follow the [upgrade guide](upgrading.md). Drain Jobs before either operation.

Hosted installation, enrollment refresh and hosted uninstall share one lock. Wait for the active operation to finish, and inspect interrupted processes before handling a stale lock.

Verification and staging occur before code redemption. After a failed new install, inspect the cleanup report and remaining service/files before retrying. A failed refresh may already have changed the credential; reconcile the local profile and dashboard, and obtain a replacement single-use code when needed.

## Independently verify a downloaded package

For an independently verifiable installation, obtain a reviewed source checkout or other separately authenticated copy of:

```text
release/trust-keyring.json
```

The current key ID is `runmesh-preview-2026-01`. Use the independently obtained keyring as your trust source throughout verification.

Download the prospective release assets into an empty directory while keeping the trusted source checkout separate:

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

Keep the source checkout outside the download directory. After signature verification, compare the supplied keyring with your trusted copy.

## Verify the signature and checksums

From the trusted source checkout, set the download directory and expected key ID. The POSIX commands below are intended for Linux, macOS, `bash`, or `zsh`:

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

Stop on any failure. `release-verify.mjs` verifies the signature using only `TRUSTED_KEYRING`, validates the release contract, and checks the artifact size and digest from the authenticated manifest.

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

These examples create a fresh installation. Keep their existing-installation checks: if one fails, preserve the current layout and use the [upgrade guide](upgrading.md).

Use Node 22.23.2+ within 22.x or 24.21.0+ within 24.x. Install the verified local tarball under the Runmesh service layout. The examples use a private temporary directory and empty npm configuration files; preserve the `--offline` and `--ignore-scripts` flags.

### Linux

```bash
set -eu
VERSION='<version>'
ARTIFACT="$DOWNLOAD/runmesh-runner-$VERSION.tgz"
NPM_CONFIG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/runmesh-npm-config.XXXXXX")"
trap 'rm -rf "$NPM_CONFIG_DIR"' EXIT
: > "$NPM_CONFIG_DIR/user.npmrc"
: > "$NPM_CONFIG_DIR/global.npmrc"
if [ -e /opt/runmesh/current ] || [ -L /opt/runmesh/current ] || [ -e "/opt/runmesh/versions/$VERSION" ]; then
  printf '%s\n' 'An existing Runmesh installation was found; stop and inspect it before installing.' >&2
  exit 1
fi
sudo mkdir -p "/opt/runmesh/versions/$VERSION"
(
  cd "$NPM_CONFIG_DIR"
  sudo npm --userconfig "$NPM_CONFIG_DIR/user.npmrc" --globalconfig "$NPM_CONFIG_DIR/global.npmrc" install --global --ignore-scripts \
    --offline --no-audit --no-fund \
    --prefix "/opt/runmesh/versions/$VERSION" \
    "$ARTIFACT"
)
sudo ln -s "/opt/runmesh/versions/$VERSION" /opt/runmesh/current.new
sudo mv /opt/runmesh/current.new /opt/runmesh/current
sudo "/opt/runmesh/current/bin/runmesh" --version
sudo "/opt/runmesh/current/bin/runmesh" --help
```

On Windows, follow the dedicated steps below to locate the verified `runmesh.cmd` shim and create a fresh service layout.

After verification, use the enrollment prompts below to keep the code out of command arguments and saved configuration.

### macOS

Use the same versioned `/opt/runmesh` layout from an elevated shell:

```bash
set -eu
VERSION='<version>'
ARTIFACT="$DOWNLOAD/runmesh-runner-$VERSION.tgz"
NPM_CONFIG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/runmesh-npm-config.XXXXXX")"
trap 'rm -rf "$NPM_CONFIG_DIR"' EXIT
: > "$NPM_CONFIG_DIR/user.npmrc"
: > "$NPM_CONFIG_DIR/global.npmrc"
if [ -e /opt/runmesh/current ] || [ -L /opt/runmesh/current ] || [ -e "/opt/runmesh/versions/$VERSION" ]; then
  printf '%s\n' 'An existing Runmesh installation was found; stop and inspect it before installing.' >&2
  exit 1
fi
sudo mkdir -p "/opt/runmesh/versions/$VERSION"
(
  cd "$NPM_CONFIG_DIR"
  sudo npm --userconfig "$NPM_CONFIG_DIR/user.npmrc" --globalconfig "$NPM_CONFIG_DIR/global.npmrc" install --global --ignore-scripts \
    --offline --no-audit --no-fund \
    --prefix "/opt/runmesh/versions/$VERSION" \
    "$ARTIFACT"
)
sudo ln -s "/opt/runmesh/versions/$VERSION" /opt/runmesh/current.new
sudo mv /opt/runmesh/current.new /opt/runmesh/current
sudo "/opt/runmesh/current/bin/runmesh" --help
```

### Windows PowerShell

Run an elevated PowerShell session:

```powershell
$Download = 'C:\path\to\runmesh-release-download'
$Version = '<version>'
$Artifact = Join-Path $Download "runmesh-runner-$Version.tgz"
$VersionRoot = "C:\Program Files\Runmesh\versions\$Version"
$CurrentRoot = "C:\Program Files\Runmesh\current"
$NpmConfigRoot = Join-Path ([IO.Path]::GetTempPath()) ('runmesh-npm-config-' + [guid]::NewGuid().ToString('N'))
$EmptyUserConfig = Join-Path $NpmConfigRoot 'empty-user.npmrc'
$EmptyGlobalConfig = Join-Path $NpmConfigRoot 'empty-global.npmrc'
if ((Test-Path -LiteralPath $CurrentRoot) -or (Test-Path -LiteralPath $VersionRoot)) { throw 'An existing Runmesh installation was found; stop and inspect it before installing.' }
New-Item -ItemType Directory -Force -Path $VersionRoot | Out-Null
New-Item -ItemType Directory -Force -Path $NpmConfigRoot | Out-Null
[IO.File]::WriteAllText($EmptyUserConfig, '')
[IO.File]::WriteAllText($EmptyGlobalConfig, '')
try {
  Push-Location -LiteralPath $NpmConfigRoot
  try {
    npm.cmd --userconfig $EmptyUserConfig --globalconfig $EmptyGlobalConfig install --global --ignore-scripts --offline --no-audit --no-fund --prefix $VersionRoot $Artifact
    $npmExitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($npmExitCode -ne 0) { throw 'Local Runner artifact installation failed.' }
} finally {
  Remove-Item -LiteralPath $NpmConfigRoot -Recurse -Force -ErrorAction SilentlyContinue
}
$Runner = Get-ChildItem -LiteralPath $VersionRoot -Filter 'runmesh.cmd' -File -Recurse | Select-Object -First 1
if ($null -eq $Runner) { throw 'runmesh.cmd was not found under the versioned install root.' }
& $Runner.FullName --version
if ($LASTEXITCODE -ne 0) { throw 'Installed Runner version check failed.' }
New-Item -ItemType Junction -Path $CurrentRoot -Target $VersionRoot | Out-Null
```

The exact npm Windows shim location can vary by npm version. Confirm the installed `runmesh.cmd` path under `$VersionRoot` before creating the junction; pass that exact absolute path to `--executable-path`.

## Confirm and activate the installed Runner

Use the same absolute executable for the version/help checks and service
installation. Run `doctor --json` for service-health checks and `status --json`
when you need the redacted profile summary.

On Linux or macOS (in `bash` or `zsh`):

```bash
set -euo pipefail
RUNNER=/opt/runmesh/current/bin/runmesh
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

On interactive Windows PowerShell (use the exact shim path discovered during installation):

```powershell
$ErrorActionPreference = 'Stop'
$CurrentRoot = 'C:\Program Files\Runmesh\current'
$RunnerPath = (Get-ChildItem -LiteralPath $CurrentRoot -Filter 'runmesh.cmd' -File -Recurse | Select-Object -First 1).FullName
if ([string]::IsNullOrWhiteSpace($RunnerPath)) { throw 'runmesh.cmd was not found under the current install.' }
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

Confirm that `runmesh --version` matches the manifest and review the required
checks from `doctor --json`. Keep both the single-use code and the resulting
long-lived profile credential private.

## One-command mode selection

The authenticated enrollment page supplies the complete single-line command,
including the one-time code. For dedicated-user installation it fetches
`/runner/install.sh?execution_mode=dedicated_user` on Linux/macOS, or
`/runner/install.ps1?execution_mode=dedicated_user` on Windows. For an explicitly
confirmed privileged-host installation it uses the original bare script URL.
For a new installation, the script downloads and verifies the runtime and signed
Runner, enrolls it, installs the selected service identity, and starts the service.
A complete managed installation of the same version instead refreshes enrollment
and restarts the existing service.
Use the dashboard's hosted path for routine setup and the offline path when
you need independent verification or transferred installation assets.
