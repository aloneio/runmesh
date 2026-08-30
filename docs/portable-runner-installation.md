# Portable Runner installation and hosted bootstrap

Runmesh supports a **fixed signed bootstrap design**, but it is deliberately disabled by default in `v0.1.0-dev.2`. The repository currently does **not** assert that the corresponding `v0.1.0-dev.2` GitHub release exists. A deployment may expose hosted commands only after an operator has published and independently verified that exact immutable release, then explicitly sets `RUNMESH_SIGNED_RELEASE_AVAILABLE=0.1.0-dev.2` for the Worker deployment.

Until then, `/runner/releases/latest` and `/runner/releases/stable` return `distributable: false`, and `/runner/install.sh` and `/runner/install.ps1` fail closed. Do not treat a source change, an npm package, a branch artifact, or an arbitrary URL as release availability.

## Trust model

The one-command path (trust model A) treats the HTTPS Worker response that serves the installer as its bootstrap trust root. The installer pins all of the following in source:

- version `0.1.0-dev.2` and tag `v0.1.0-dev.2`;
- the exact GitHub release-asset URLs and `runmesh-runner-0.1.0-dev.2.tgz` name;
- signing key ID `runmesh-preview-2026-01`;
- the reviewed Ed25519 public key from `release/trust-keyring.json`.

Before installing, the script downloads only `manifest.json`, `manifest.sig`, `manifest.signature.json`, `SHA256SUMS`, and the fixed tarball. It verifies the detached Ed25519 signature, strict manifest project/version/tag/channel/protocol/commit/artifact fields, artifact size, SHA-256, and the additional checksum-file entry. It installs only that verified local tarball with npm scripts disabled. It never uses a downloaded `trust-keyring.json` as a trust root, consults an npm registry, accepts `latest`, or accepts a package name or caller-supplied URL.

A compromised Worker/bootstrap endpoint can replace the installer and its embedded key; a one-command script cannot detect that replacement itself. High-assurance environments must use the independent offline path below instead of executing a remote script.

## Enabled hosted-bootstrap commands

Use these commands **only when the authenticated Admin enrollment page says the fixed signed preview is available**. They contain no enrollment code. The script validates the artifact first, then asks locally for the single-use code and sends it only to `coding-runner enroll --code-stdin`; it is not put in the URL, copied command, or process arguments.

Linux or macOS, from an elevated shell:

```sh
curl --fail --location --proto '=https' --tlsv1.2 https://your-runmesh.example/runner/install.sh | sudo sh
```

Windows, from an elevated PowerShell session:

```powershell
Invoke-WebRequest -UseBasicParsing https://your-runmesh.example/runner/install.ps1 | Invoke-Expression
```

The installers require Node.js 20+, npm, elevation, and a clean Runmesh installation. They refuse an existing `current`, same-version/staging root, canonical system profile, or service manifest. They stage the package under the versioned Runmesh root, validate both `coding-runner` and `runmesh-runner` entry points, and do not make an unverified `latest` update. Local artifact installation happens before code redemption, so verification and staging failures do not consume the code. If a later local service step fails, the installer best-effort uninstalls only its newly created managed service, removes the newly created profile, current pointer, and version root, and exits nonzero. Enrollment redemption itself is remote and single-use and cannot be restored; generate a replacement code before retrying.

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
```

Verify them with the checkout's trusted keyring:

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

Stop on any failure. `release-verify.mjs` verifies the signature using only `TRUSTED_KEYRING`, validates the release contract, and checks the artifact size and digest from the authenticated manifest.

Install only the verified local tarball into a versioned Runmesh root. Do not substitute an npm package name, a moving URL, or an unverified global install. The service layout resolves the active executable through `/opt/runmesh/current/bin/coding-runner`; do not point it at `/opt/runmesh/current/coding-runner`. For example on Linux/macOS, after reviewing your host's existing-installation state:

```sh
VERSION='<version>'
ARTIFACT="$DOWNLOAD/runmesh-runner-$VERSION.tgz"
sudo npm install --global --ignore-scripts --no-audit --no-fund \
  --prefix "/opt/runmesh/versions/$VERSION" "$ARTIFACT"
sudo "/opt/runmesh/versions/$VERSION/bin/coding-runner" --version
sudo "/opt/runmesh/versions/$VERSION/bin/coding-runner" --help
```

Use an equivalent verified local path on Windows and inspect the actual `coding-runner.cmd` npm shim before using it for a service. Do not delete an existing `current` link/junction to make room for an install.

After local verification, run the CLI without putting the code in argv, shell history, configuration, or a URL:

```sh
coding-runner enroll --server https://your-runmesh.example/runner/enroll --code-stdin
coding-runner install
coding-runner status --json
```

Paste the single-use code only when the command reads standard input. It is never stored in the Runner profile or printed by the CLI; the resulting long-lived Runner token is private profile material.
