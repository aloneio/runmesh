# Installer prerequisites and recovery

## Compatible bootstrap

Linux/macOS use the same pinned official Node release as gzip archives instead of xz archives. All four SHA256 values come from the version-specific official SHASUMS256.txt. Verification precedes extraction. gzip and tar run as separate checked commands, so a failed decompressor cannot be hidden by a successful pipeline consumer. No TLS/checksum bypass or unverified mirror is introduced.

Windows keeps the pinned ZIP assets and extracts with the system .NET ZipFile implementation, not the optional Expand-Archive module. Runtime execution must report the exact fixed version. This Worker-only repair does not replace the immutable Runner v0.1.3 package or restart installed services.

## Requirements

A new POSIX installation needs trusted standard shell utilities, Bash, curl with the secure options used by the script, tar, gzip, and one checksum tool: sha256sum, shasum or OpenSSL. No xz or awk is required. stty and a usable terminal are needed only for hidden interactive code entry. A provided code does not require either.

Managed Linux installation checks that the system systemd manager is reachable before enrollment. Minimal containers without systemd need manual supervision. macOS requires launchctl. Missing prerequisites are listed with OS-package-manager suggestions; those commands are not executed automatically. --auto-deps means private runtime bootstrap, not permission to install arbitrary system packages. A verified existing installation can refresh without download-only curl/gzip/checksum prerequisites.

Official Linux runtime compatibility is checked before registration. getconf, when available, rejects glibc older than 2.28 before download. The actual startup probe identifies an unexecutable runtime, including architecture, libraries or noexec problems. This is not Alpine/musl or arbitrary old-OS support. Do not replace system libc to force installation.

## Error contract

Errors include an RMI_* code, phase and recovery hint:

| Code | Action |
| --- | --- |
| RMI_MISSING_TOOLS / RMI_CHECKSUM_TOOL | Install the listed tools; verification remains required |
| RMI_SERVICE_MANAGER | Check systemd/launchctl or use manual supervision |
| RMI_TEMP_DIRECTORY / RMI_DOWNLOAD_WRITE | Check temporary space and permissions |
| RMI_TLS_CERTIFICATE | Check CA certificates, system time and proxy trust, not insecure TLS |
| RMI_DOWNLOAD / RMI_CURL_VERSION | Check connectivity or update curl from the OS package manager |
| RMI_CHECKSUM_MISMATCH | Stop: bytes do not match the source-pinned digest; nothing is extracted |
| RMI_DECOMPRESS / RMI_EXTRACT | Check gzip/tar or .NET ZIP support, free space and directory permissions |
| RMI_RUNTIME_COMPATIBILITY / RMI_RUNTIME_VERSION | Check OS/CPU/noexec and exact pinned runtime identity |

The standard TMPDIR can choose a trusted writable/executable temporary filesystem; the script still creates a private mktemp subdirectory. Gzip and the temporary uncompressed tar require more space than the former xz path. Never make a shared directory world-writable or disable verification as a workaround.

Pre-enrollment errors explicitly say registration was not attempted. A code can still expire under its own validity period. After enrollment is attempted it may have been consumed, so redemption is never automatically retried. Diagnostics then withhold potentially secret-bearing subprocess logs and PowerShell source locations. Only the fixed official runtime GET has bounded retry behavior.

## Validation and rollout

Tests execute actual generated shell helpers in an isolated PATH without xz, awk or system Node. They cover real gzip/tar extraction, checksum alternatives, missing tools, unavailable service manager, old glibc, TLS/network/disk-write errors, wrong digests, corrupt gzip and unexecutable runtime. Native Windows CI additionally executes the emitted .NET ZIP extraction block.

An independent oci0 test downloaded node-v22.23.2-linux-arm64.tar.gz (56,749,972 bytes), verified SHA256 `013b59cfd2819703a6f4a14ab891fc46fc2a4e3f5bcd92de3fb4929b43e35b30`, extracted with xz/awk absent from PATH, and ran Node v22.23.2 with crypto/zlib. It made no enrollment or service changes. This is not a full real-host installation on every distribution.

References: https://nodejs.org/dist/v22.23.2/SHASUMS256.txt and https://github.com/nodejs/node/blob/v22.23.2/BUILDING.md

Merge through protected main and GitLab deployment, then verify the public installer actually contains gzip and RMI_* diagnostics. A successful CI/push alone does not prove the public script changed. Current namespaces, keys, profiles, live services and signed release assets remain intact.
