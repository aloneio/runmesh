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
```

Keep the trusted source checkout outside that download directory.

## Verify the signature and checksums

From the trusted source checkout, set the download directory and expected key ID:

```sh
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
  sha256sum -c SHA256SUMS
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

## Install from the verified local tarball

Node.js 20 or newer is required. Install only from the local verified file; do not replace it with a package name or a moving URL. The managed service must use an executable installed under the Runmesh service layout, not an unrelated npm global prefix.

### Linux

```sh
VERSION='<version>'
ARTIFACT="$DOWNLOAD/runmesh-runner-$VERSION.tgz"
sudo mkdir -p "/opt/runmesh/versions/$VERSION"
sudo npm install --global --ignore-scripts \
  --prefix "/opt/runmesh/versions/$VERSION" \
  "$ARTIFACT"
sudo ln -sfn "/opt/runmesh/versions/$VERSION" /opt/runmesh/current
sudo "/opt/runmesh/current/bin/coding-runner" --version
sudo "/opt/runmesh/current/bin/coding-runner" install \
  --executable-path /opt/runmesh/current/bin/coding-runner
```

### macOS

Use the same versioned `/opt/runmesh` layout from an elevated shell:

```sh
VERSION='<version>'
ARTIFACT="$DOWNLOAD/runmesh-runner-$VERSION.tgz"
sudo mkdir -p "/opt/runmesh/versions/$VERSION"
sudo npm install --global --ignore-scripts \
  --prefix "/opt/runmesh/versions/$VERSION" \
  "$ARTIFACT"
sudo ln -sfn "/opt/runmesh/versions/$VERSION" /opt/runmesh/current
sudo "/opt/runmesh/current/bin/coding-runner" install \
  --executable-path /opt/runmesh/current/bin/coding-runner
```

### Windows PowerShell

Run an elevated PowerShell session:

```powershell
$Version = '<version>'
$Artifact = Join-Path $Download "runmesh-runner-$Version.tgz"
$VersionRoot = "C:\Program Files\Runmesh\versions\$Version"
$CurrentRoot = "C:\Program Files\Runmesh\current"
New-Item -ItemType Directory -Force -Path $VersionRoot | Out-Null
npm install --global --ignore-scripts --prefix $VersionRoot $Artifact
if (Test-Path $CurrentRoot) { Remove-Item -Recurse -Force $CurrentRoot }
New-Item -ItemType Junction -Path $CurrentRoot -Target $VersionRoot | Out-Null
& "$CurrentRoot\coding-runner.cmd" install --executable-path "$CurrentRoot\coding-runner.cmd"
```

The exact npm Windows shim location can vary by npm version. Confirm the installed `coding-runner.cmd` path under `$VersionRoot` before creating the junction; pass that exact absolute path to `--executable-path`.

## Confirm the installed Runner

Run all three checks from the service-layout executable (shown below for Linux/macOS):

```sh
/opt/runmesh/current/bin/coding-runner --version
/opt/runmesh/current/bin/coding-runner --help
/opt/runmesh/current/bin/coding-runner doctor --json
```

`coding-runner --version` must equal the manifest version. `--help` must print the `coding-runner` usage. `doctor --json` can report expected configuration or service failures before enrollment, but it must return structured JSON checks rather than failing to load the program.

After verification and installation, redeem the short-lived one-time code shown by the Admin Panel and install the service:

```sh
coding-runner enroll \
  --server https://your-runmesh.example/runner/enroll \
  --code '<one-time-enrollment-code>'

coding-runner install
coding-runner status --json
```

The enrollment code is single-use and is not a long-term Runner credential. Do not place it in logs, shell history, issue reports, or configuration management.
