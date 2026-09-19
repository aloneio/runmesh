# Installer prerequisites and recovery

Use the installation command from your administrator enrollment page when that Worker's release channel is available. The hosted installer includes a verified Node.js runtime. For manual setup, follow [portable installation](portable-runner-installation.md).

## Before installation

Run the command from an elevated administrator terminal on a supported x64 or ARM64 host. Keep enough free space for the runtime download, extracted files and Runner package, and allow outbound HTTPS to your Worker, nodejs.org and the fixed GitHub release assets.

Linux/macOS need trusted standard shell utilities, Bash, curl, tar, gzip, and one checksum tool: `sha256sum`, `shasum` or OpenSSL. The installer verifies the pinned gzip archive's SHA-256 before extraction. Windows needs Windows PowerShell 5.1 or PowerShell 7, `Invoke-WebRequest`, `Get-FileHash` and the system .NET ZIP library.

Linux system-service installation requires a reachable systemd manager; containers without systemd need manual supervision. macOS requires launchctl. Install any missing system tools using the package-manager suggestions in the error. `--auto-deps` controls the installer's private runtime download.

Use a glibc-compatible Linux host for the official runtime; Alpine/musl needs a different supported deployment plan. When `getconf` is available, the installer requires glibc 2.28 or newer before download, then checks that the runtime actually starts. For an incompatible host, select a compatible system or container image.

Hidden interactive enrollment-code input requires `stty` and a terminal on POSIX. A supplied code uses the non-interactive path. On Windows, prompting requires an interactive elevated PowerShell session: if you remove the code from the copied command, also remove `-NonInteractive`. Treat a complete command containing the code as a credential because it may remain in shell history or process arguments.

## Existing installations

A complete managed installation can refresh enrollment only when its Runner version exactly matches the selected installer. This refresh uses the installed runtime, updates enrollment and service configuration, and restarts the service. The package remains at its installed version, and download-only tools are unnecessary for this path. Drain Jobs first. For a different version, follow the [upgrade guide](upgrading.md).

Hosted installation, refresh and uninstall share a lock. Wait for an active operation to finish. After interruption, inspect running processes before handling a stale lock, and keep manual filesystem changes outside the maintenance window.

## Resolve an installation error

Bootstrap diagnostics include an `RMI_*` code, a phase and a recovery hint:

| Code | Action |
| --- | --- |
| `RMI_MISSING_TOOLS` / `RMI_CHECKSUM_TOOL` | Install the listed tools and retry; verification is still required |
| `RMI_SERVICE_MANAGER` | Check systemd/launchctl or use manual supervision |
| `RMI_TEMP_DIRECTORY` / `RMI_DOWNLOAD_WRITE` | Check temporary space and permissions |
| `RMI_TLS_CERTIFICATE` | Check CA certificates, system time and proxy trust |
| `RMI_DOWNLOAD` / `RMI_CURL_VERSION` | Check connectivity or update curl through the OS package manager |
| `RMI_CHECKSUM_MISMATCH` | Stop: the download does not match the pinned digest |
| `RMI_DECOMPRESS` / `RMI_EXTRACT` / `RMI_ZIP_SUPPORT` | Check gzip/tar or .NET ZIP support, free space and permissions |
| `RMI_RUNTIME_COMPATIBILITY` / `RMI_RUNTIME_VERSION` | Check OS, CPU, libraries, noexec mounts and the pinned runtime version |
| `RMI_RUNTIME_DISABLED` | Omit `--no-auto-deps` for a new installation |

If `/tmp` is mounted with `noexec`, use the standard `TMPDIR` variable to choose a trusted writable location that permits execution. The installer creates a private subdirectory there. The gzip archive and intermediate tar need additional free space. Keep TLS, hash and signature verification enabled.

Download requests have time and size limits; troubleshoot a stalled response using its error code above. A failure before enrollment leaves the code available until its normal expiry. After an enrollment attempt, check the Runner and obtain a replacement code if needed, because the previous code may already be consumed. Subprocess output that could contain credentials is withheld at that stage.

Failed fresh-install cleanup attempts to remove the state created by that attempt. Inspect service status and remaining files before retrying. A failed credential refresh may already have replaced the old credential; reconcile the profile and dashboard before recovery.

## Verify the result

Run `doctor --json` using the installed Runner's absolute path, then check its connection and policy state in the administrator page. Finally, use the intended MCP client to list workspaces and read a harmless file. Plan a later package upgrade through the [upgrade guide](upgrading.md).

Runtime references: [official Node checksums](https://nodejs.org/dist/v22.23.2/SHASUMS256.txt) and [Node platform requirements](https://github.com/nodejs/node/blob/v22.23.2/BUILDING.md).
