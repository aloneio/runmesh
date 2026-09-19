# Installer prerequisites and recovery

Use the installation command from your administrator enrollment page. The hosted installer downloads its own verified Node.js runtime; you do not need to install Node or npm first. Hosted installation must be enabled for that Worker's release channel. See [portable installation](portable-runner-installation.md) when it is unavailable.

## Before installation

Run the command from an elevated administrator terminal on a supported x64 or ARM64 host. Keep enough free space for the runtime download, extracted files and Runner package, and allow outbound HTTPS to your Worker, nodejs.org and the fixed GitHub release assets.

Linux/macOS need trusted standard shell utilities, Bash, curl, tar, gzip, and one checksum tool: `sha256sum`, `shasum` or OpenSSL. You do not need xz or awk. The installer checks a pinned official gzip archive against its embedded SHA-256 before extraction. Windows needs Windows PowerShell 5.1 or PowerShell 7, `Invoke-WebRequest`, `Get-FileHash` and the system .NET ZIP library; it does not require the optional `Expand-Archive` module.

Linux system-service installation requires a reachable systemd manager; containers without systemd need manual supervision. macOS requires launchctl. Missing tools are listed with package-manager suggestions, but the script does not run those commands. `--auto-deps` enables the private runtime bootstrap, not installation of system packages.

The Linux runtime requires a compatible glibc system. When `getconf` is available, glibc older than 2.28 is rejected before download. A startup check then verifies that the runtime can execute on the host. Alpine/musl and arbitrary older systems are not supported by these official runtime archives. Do not replace system libc to force installation.

Hidden interactive enrollment-code input requires `stty` and a terminal on POSIX. A command that already includes the code does not need them. On Windows, prompting requires an interactive elevated PowerShell session: if you remove the code from the copied command, also remove `-NonInteractive`. Treat a complete command containing the code as a credential because it may remain in shell history or process arguments.

## Existing installations

A complete managed installation can refresh enrollment only when its Runner version exactly matches the selected installer. This refresh uses the installed runtime, updates enrollment and service configuration, and restarts the service. It does not download or upgrade the package, and does not need download-only curl/gzip/checksum tools. Drain Jobs first. For a different version, follow the [upgrade guide](upgrading.md).

Hosted installation, refresh and uninstall share a lock. Wait for an active operation to finish. After an interrupted operation, check that no installer is still running before removing a stale lock; do not bypass it with a concurrent manual installation.

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

Download requests have time and size limits. A stalled response is a failed download, not a reason to bypass verification. Before enrollment begins, the diagnostic states that registration was not attempted; the code can still expire under its normal validity period. After enrollment is attempted, the code may already be consumed. Check the Runner and obtain a replacement code if needed instead of repeatedly submitting it. At that stage, potentially secret-bearing subprocess output is withheld.

Failed fresh-install cleanup removes only state created by that attempt, on a best-effort basis. A failed credential refresh does not restore the previous credential. Inspect service status and any remaining files before retrying.

## Verify the result

Run `doctor --json` using the installed Runner's absolute path and check the Runner's connection and policy state in the administrator page. A successful Worker build or `/health` response alone does not prove that the host installation succeeded. Updating a Worker or its installer does not replace an existing Runner package or restart that Runner.

Runtime references: [official Node checksums](https://nodejs.org/dist/v22.23.2/SHASUMS256.txt) and [Node platform requirements](https://github.com/nodejs/node/blob/v22.23.2/BUILDING.md).
