# Installer prerequisites and recovery

Use the installation command from your administrator enrollment page when that Worker's release channel is available. The hosted installer includes a verified Node.js runtime. For manual setup, follow [portable installation](portable-runner-installation.md).

## Before installation

Run the command from an elevated administrator terminal on an x64 or ARM64 host that meets the requirements below. Keep enough free space for the runtime download, extracted files and Runner package, and allow outbound HTTPS to your Worker, nodejs.org and the GitHub release assets.

Linux/macOS need trusted standard shell utilities, Bash, curl, tar, gzip, and one checksum tool: `sha256sum`, `shasum` or OpenSSL. The installer verifies the pinned gzip archive's SHA-256 before extraction. Windows needs Windows PowerShell 5.1 or PowerShell 7, `Invoke-WebRequest`, `Get-FileHash` and the system .NET ZIP library.

Linux system-service installation uses systemd; in a container, choose an image with systemd or manage the Runner process through the container's supervisor. macOS uses launchctl. Install any missing system tools using the package-manager suggestions in the error. `--auto-deps` controls the installer's private runtime download.

The official Linux runtime requires glibc 2.28 or newer. For an Alpine/musl environment, use a glibc-based system or container image for the hosted installer. The installer checks the library version with `getconf` when available and confirms that the downloaded runtime starts.

Hidden interactive enrollment-code input requires `stty` and a terminal on POSIX. A supplied code uses the non-interactive path. On Windows, prompting requires an interactive elevated PowerShell session: if you remove the code from the copied command, also remove `-NonInteractive`. Treat a complete command containing the code as a credential because it may remain in shell history or process arguments.

## Existing installations

To refresh enrollment for a complete managed installation, select an installer matching the installed Runner version. It uses the existing runtime, updates enrollment and service configuration, and restarts the service while retaining the installed package. Drain Jobs before refreshing enrollment. To change the package version, follow the [upgrade guide](upgrading.md).

Run one installation, enrollment refresh or uninstall at a time. These operations share a lock. After an interruption, check for running maintenance processes before removing a stale lock or changing installation files.

## Resolve an installation error

Bootstrap diagnostics include an `RMI_*` code, a phase and a recovery hint:

| Code | Action |
| --- | --- |
| `RMI_MISSING_TOOLS` / `RMI_CHECKSUM_TOOL` | Install the listed tools, then rerun the installer and its verification checks |
| `RMI_SERVICE_MANAGER` | Check systemd/launchctl or use manual supervision |
| `RMI_TEMP_DIRECTORY` / `RMI_DOWNLOAD_WRITE` | Check temporary space and permissions |
| `RMI_TLS_CERTIFICATE` | Check CA certificates, system time and proxy trust |
| `RMI_DOWNLOAD` / `RMI_CURL_VERSION` | Check connectivity or update curl through the OS package manager |
| `RMI_CHECKSUM_MISMATCH` | Stop: the download does not match the pinned digest |
| `RMI_DECOMPRESS` / `RMI_EXTRACT` / `RMI_ZIP_SUPPORT` | Check gzip/tar or .NET ZIP support, free space and permissions |
| `RMI_RUNTIME_COMPATIBILITY` / `RMI_RUNTIME_VERSION` | Check OS, CPU, libraries, noexec mounts and the pinned runtime version |
| `RMI_RUNTIME_DISABLED` | Omit `--no-auto-deps` for a new installation |

If `/tmp` is mounted with `noexec`, use the standard `TMPDIR` variable to choose a trusted writable location that permits execution. The installer creates a private subdirectory there. The gzip archive and intermediate tar need additional free space. Keep TLS, hash and signature verification enabled.

Use the error codes above to investigate an interrupted download. A failure before enrollment leaves the code available until its normal expiry. After an enrollment attempt, check the Runner's state before retrying; generate a replacement code if the original has been consumed.

After a failed fresh installation, review the cleanup result, service status and remaining files before retrying. If enrollment refresh was interrupted, compare the local profile and dashboard first: the credential may already have been replaced.

## Verify the result

Run `doctor --json` using the installed Runner's absolute path, then check its connection and policy state in the administrator page. Finally, use the intended MCP client to list workspaces and read a harmless file. Plan a later package upgrade through the [upgrade guide](upgrading.md).

Runtime references: [official Node checksums](https://nodejs.org/dist/v22.23.2/SHASUMS256.txt) and [Node platform requirements](https://github.com/nodejs/node/blob/v22.23.2/BUILDING.md).
