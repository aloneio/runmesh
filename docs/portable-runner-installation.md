# Portable Runner installation and hosted bootstrap

Use this page when the Dashboard does not show a hosted installation command, when the target machine is offline, or when your organization's policy requires independent artifact verification. The normal product workflow is described in the [administrator guide](admin-guide.md).

Runmesh supports a **fixed signed bootstrap design**, but it remains deliberately disabled in the default/local environment of `v0.1.0-dev.4`. The checked-in production acknowledgement enables the already published, independently verified dev.4 signed release. Both dedicated_user and privileged_host selections use a one-command installer. A deployment exposes hosted commands only when that environment has a canonical external HTTPS `RUNMESH_PUBLIC_ORIGIN` and the exact `RUNMESH_SIGNED_RELEASE_AVAILABLE=0.1.0-dev.4` acknowledgement; both conditions are required, and setting the release acknowledgement alone never exposes the installer.

`RUNMESH_PUBLIC_ORIGIN` is a non-secret Worker variable. Set it in the Wrangler `vars` configuration to an externally reachable origin such as `https://mcp.example.com`, with no path, query, fragment, credentials, whitespace, wildcard, or `http://` scheme. A trailing slash is normalized. The configured public Host is accepted behind a proxy. Routed domains are also accepted when the HTTPS request URL and Host agree; mismatched authorities are rejected; an invalid or missing origin keeps the release descriptor non-distributable. Local development can omit the variable, but it cannot enable hosted signed bootstrap.

Until both prerequisites are satisfied, `/runner/releases/latest` and `/runner/releases/stable` return `distributable: false`, and `/runner/install.sh` and `/runner/install.ps1` fail closed. Do not treat a source change, an npm package, a branch artifact, or an arbitrary URL as release availability.

## Trust model

The one-command path (trust model A) treats the HTTPS Worker response that serves the installer as its bootstrap trust root. The installer pins all of the following in source:

- version `0.1.0-dev.4` and tag `v0.1.0-dev.4`;
- the exact GitHub release-asset URLs and `runmesh-runner-0.1.0-dev.4.tgz` name;
- signing key ID `runmesh-preview-2026-01`;
- the reviewed Ed25519 public key from `release/trust-keyring.json`.

Before installing, the script downloads only `manifest.json`, `manifest.sig`, `manifest.signature.json`, `SHA256SUMS`, and the fixed tarball. Every accepted local release asset must be non-empty and no larger than 8 MiB (`8,388,608` bytes): POSIX uses the HTTP/curl limit where available and then checks the completed file, while PowerShell enforces the bound while streaming. A chunked POSIX response may therefore be rejected after bytes have reached the temporary directory, but it can never proceed to verification or installation above the cap. The authenticated artifact size must also be within that cap. It verifies the detached Ed25519 signature, strict manifest project/version/tag/channel/protocol/commit/artifact fields, artifact size, SHA-256, and the additional checksum-file entry. It installs only that verified local tarball with npm scripts disabled. It never uses a downloaded `trust-keyring.json` as a trust root, consults an npm registry, accepts `latest`, or accepts a package name or caller-supplied URL.

A compromised Worker/bootstrap endpoint can replace the installer and its embedded key; a one-command script cannot detect that replacement itself. High-assurance environments must use the independent offline path below instead of executing a remote script.

## Enabled hosted-bootstrap commands

Use these commands **only when the authenticated Admin enrollment page says the fixed signed preview is available** and the command URL uses the configured public origin. The dashboard-generated convenience command includes a quoted one-time enrollment code for automatic registration. Scripts also accept `--code CODE` and `--code=CODE`. The optional manual snippets below omit the code and retain the hidden terminal prompt. In either case, the downstream Runner receives standard input, never a temporary credential file. Keep the entire convenience command private: it may remain in command history or process arguments. The Worker rejects mismatched authorities. A matching HTTPS URL and Host may identify a routed custom domain.

The `262144`-byte limit in the download snippets below applies only to the Worker-served installer script. After that script starts, its embedded downloader applies the separate 8 MiB limit to each fixed GitHub release asset; the repository's `pack:smoke` gate packs the actual Runner tarball and fails if it exceeds that bound.

Linux or macOS, from an elevated shell:

```sh
set -eu
installer="$(mktemp)"
trap 'rm -f "$installer"' EXIT
curl -q --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --max-redirs 0 --max-time 60 --max-filesize 262144 --output "$installer" 'https://your-runmesh.example/runner/install.sh'
test -s "$installer"
sudo sh "$installer"
```

Windows, from an elevated PowerShell session:

```powershell
$ErrorActionPreference = 'Stop'
$installer = Join-Path ([IO.Path]::GetTempPath()) ('runmesh-installer-' + [guid]::NewGuid().ToString('N') + '.ps1')
try {
  Invoke-WebRequest -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 60 -ErrorAction Stop -OutFile $installer -Uri 'https://your-runmesh.example/runner/install.ps1'
  # HTTP errors terminate with ErrorAction Stop; OutFile does not return a response object.
  if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw 'Installer download did not produce a file.' }
  $length = (Get-Item -LiteralPath $installer).Length
  if ($length -le 0 -or $length -gt 262144) { throw 'Installer download size is invalid.' }
  & ([scriptblock]::Create([IO.File]::ReadAllText($installer)))
} finally {
  Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
}
```

The installers require elevation and a clean Runmesh installation; they do not require a host-provided Node.js or npm. They select the host OS/CPU archive for the pinned Node.js `22.19.0` runtime, verify its embedded SHA-256 digest, and place only the Node executable inside the versioned Runmesh root. Fresh installation refuses conflicting paths, profiles and service manifests. A managed same-version installation may refresh enrollment; an older/different version is rejected before code input and requires a separately verified manual upgrade. They stage the package under the versioned Runmesh root, validate both `runmesh` and `runmesh-runner` entry points, and do not make an unverified `latest` update. The private runtime's npm CLI is used only inside the temporary staging directory, with empty user/global config and cache paths, `--offline`, and `--ignore-scripts`; no host npm configuration can change the install. The installed service wrapper invokes the private runtime directly, so the service continues to work even when Node.js/npm are absent from the host PATH. Local artifact installation happens before code redemption, so verification and staging failures do not consume the code. If a later local service step fails, the installer best-effort uninstalls only its newly created managed service, removes the newly created profile, current pointer, and version root, and exits nonzero. There is no automatic package update, rollback, or import of an earlier profile/service layout: retain the prior verified package and managed `current`/service state separately for manual recovery. Enrollment redemption itself is remote and single-use and cannot be restored; generate a replacement code before retrying.

## High-assurance offline verification path

For an independently verifiable installation, obtain a reviewed source checkout or other separately authenticated copy of:

```text
release/trust-keyring.json
```

The current preview key ID is `runmesh-preview-2026-01`. A keyring downloaded beside a release artifact is informational only; compare it with the independent keyring after verification, never before.

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

Keep the trusted source checkout outside that download directory. Verify the assets with the checkout's trusted keyring; the keyring downloaded beside the artifact is informational only.

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

Node.js 20 or newer is required. Install only from the local verified file; do not replace it with a package name or a moving URL. The managed service must use an executable installed under the Runmesh service layout, not an unrelated npm global prefix. The examples below run npm from a private empty temporary directory and pass empty user/global config files, so a root, global, or caller-working-directory npmrc cannot alter the privileged install; keep the explicit `--offline` and `--ignore-scripts` flags.

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

Use an equivalent verified local path on Windows and inspect the actual `runmesh.cmd` npm shim before using it for a service. Do not delete an existing `current` link/junction to make room for an install.

After local verification, run the platform-specific enrollment and service activation steps below without putting the code in argv, shell history, configuration, or a URL.

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

Run the version/help checks from the same absolute executable used by the
service. `doctor --json` is the service-health probe; `status --json` is only a
redacted profile summary and intentionally does not query the host service
manager.

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

On Windows PowerShell (use the exact shim path discovered during installation):

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

`runmesh --version` must equal the manifest version, and `doctor --json`
must return structured checks. The enrollment code is single-use and is not a
long-term Runner credential; never place it in logs, shell history, issue
reports, or configuration management. The resulting long-lived Runner token is private profile material.

## One-command mode selection

The authenticated enrollment page supplies the complete single-line command,
including the one-time code. For dedicated-user installation it fetches
`/runner/install.sh?execution_mode=dedicated_user` on Linux/macOS, or
`/runner/install.ps1?execution_mode=dedicated_user` on Windows. For an explicitly
confirmed privileged-host installation it uses the original bare script URL.
The script downloads and verifies the runtime and signed Runner, enrolls it,
installs the selected service identity, and starts the service automatically.
The longer offline-verification examples remain an optional advanced path,
not the default dashboard installation flow.
