/** Shared by the generated installer and maintenance script. All checks and
 * runtime staging happen before enrollment or modification of installed state.
 * gzip is intentional: GNU tar -J depends on an optional external xz binary.
 */
export const POSIX_INSTALLER_PREFLIGHT = String.raw`
bootstrap_error() {
  printf 'error [%s] stage=%s: %s\n' "$1" "$INSTALL_PHASE" "$2" >&2
  printf '  Recovery: %s\n' "$3" >&2
  if [ "$ENROLLMENT_ATTEMPTED" -eq 0 ]; then
    printf '%s\n' '  Enrollment was not attempted; installed Runner files and credentials have not been changed.' >&2
  else
    printf '%s\n' '  Enrollment may already have consumed the code. Check credential state before retrying.' >&2
  fi
  exit 1
}

dependency_hint() {
  # Guidance only. Never run a package manager or install software implicitly.
  if command -v apt-get >/dev/null 2>&1; then printf '%s' 'Review and run as root: apt-get update && apt-get install -y ca-certificates curl tar gzip coreutils bash'
  elif command -v dnf >/dev/null 2>&1; then printf '%s' 'Review and run as root: dnf install -y ca-certificates curl tar gzip coreutils bash'
  elif command -v yum >/dev/null 2>&1; then printf '%s' 'Review and run as root: yum install -y ca-certificates curl tar gzip coreutils bash'
  elif command -v zypper >/dev/null 2>&1; then printf '%s' 'Review and run as root: zypper install ca-certificates curl tar gzip coreutils bash'
  elif command -v pacman >/dev/null 2>&1; then printf '%s' 'Review and run as root: pacman -S --needed ca-certificates curl tar gzip coreutils bash'
  else printf '%s' 'Install the listed tools from the OS package manager. macOS supplies these tools; restore trusted system tools or use the documented manual installation route.'
  fi
}

check_base_tools() {
  MISSING_TOOLS=''
  for command_name in id uname readlink grep mkdir rmdir rm mktemp sed wc tr mv cp ln chmod cat dirname; do
    if ! command -v "$command_name" >/dev/null 2>&1; then MISSING_TOOLS="$MISSING_TOOLS $command_name"; fi
  done
  if [ -n "$MISSING_TOOLS" ]; then bootstrap_error RMI_MISSING_TOOLS "Required tools are missing:$MISSING_TOOLS" "$(dependency_hint)"; fi
  if [ "$RUNMESH_ACTION" != uninstall ] && [ "$CODE_ARG_SET" -eq 0 ]; then
    command -v stty >/dev/null 2>&1 || bootstrap_error RMI_TERMINAL 'Hidden code entry needs stty.' 'Install stty or use the private one-time command supplied by the administrator.'
    if ! (stty -g < /dev/tty) >/dev/null 2>&1; then bootstrap_error RMI_TERMINAL 'No usable terminal is available for hidden code entry.' 'Use an interactive terminal or the private one-time command; do not publish its code.'; fi
  fi
}

check_service_prerequisites() {
  [ "$RUNMESH_ACTION" != uninstall ] || return 0
  command -v bash >/dev/null 2>&1 || bootstrap_error RMI_MISSING_TOOLS 'The Runner Host shell requires Bash.' "$(dependency_hint)"
  case "$(uname -s)" in
    Linux)
      command -v systemctl >/dev/null 2>&1 || bootstrap_error RMI_SERVICE_MANAGER 'Managed Linux installation requires systemd; systemctl was not found.' 'Use a systemd-managed host, or the documented manually supervised Runner route. Installing xz cannot fix a missing service manager.'
      if ! systemctl --system show --property=Version --value >/dev/null 2>&1; then bootstrap_error RMI_SERVICE_MANAGER 'The system systemd manager is not accessible.' 'Check systemd/PID 1 and the system bus. A minimal container without systemd needs the manually supervised route; no registration was attempted.'; fi
      ;;
    Darwin)
      command -v launchctl >/dev/null 2>&1 || bootstrap_error RMI_SERVICE_MANAGER 'Managed macOS installation requires launchctl.' 'Restore the system launchctl command before installing a managed service.'
      ;;
  esac
}

check_bootstrap_tools() {
  MISSING_TOOLS=''
  for command_name in curl tar gzip; do
    if ! command -v "$command_name" >/dev/null 2>&1; then MISSING_TOOLS="$MISSING_TOOLS $command_name"; fi
  done
  if [ -n "$MISSING_TOOLS" ]; then bootstrap_error RMI_MISSING_TOOLS "Runtime bootstrap tools are missing:$MISSING_TOOLS (xz is not required)." "$(dependency_hint)"; fi
  if command -v sha256sum >/dev/null 2>&1; then RUNTIME_HASH_TOOL=sha256sum
  elif command -v shasum >/dev/null 2>&1; then RUNTIME_HASH_TOOL=shasum
  elif command -v openssl >/dev/null 2>&1; then RUNTIME_HASH_TOOL=openssl
  else bootstrap_error RMI_CHECKSUM_TOOL 'No SHA-256 verifier is installed.' 'Install sha256sum (coreutils), shasum, or OpenSSL. Verification cannot be skipped.'
  fi
  if [ "$(uname -s)" = Linux ] && command -v getconf >/dev/null 2>&1; then
    if LIBC_INFO=$(getconf GNU_LIBC_VERSION 2>/dev/null); then
      LIBC_VERSION=$(printf '%s' "$LIBC_INFO" | sed -n 's/^glibc //p')
      LIBC_MAJOR=$(printf '%s' "$LIBC_VERSION" | sed 's/\..*//')
      LIBC_MINOR=$(printf '%s' "$LIBC_VERSION" | sed 's/^[^.]*\.//;s/\..*//')
      case "$LIBC_MAJOR:$LIBC_MINOR" in ''|:*|*:|*[!0-9:]*) : ;;
        *) if [ "$LIBC_MAJOR" -lt 2 ] || { [ "$LIBC_MAJOR" -eq 2 ] && [ "$LIBC_MINOR" -lt 28 ]; }; then
          bootstrap_error RMI_RUNTIME_COMPATIBILITY 'The pinned official Node runtime requires glibc 2.28 or newer.' 'Use a supported OS image; do not replace system libc or download an unverified runtime to force installation.'
        fi ;;
      esac
    fi
  fi
}

prepare_private_runtime() {
  INSTALL_PHASE=runtime_download
  # Only this fixed official GET is retried. Enrollment/service mutations are
  # never retried automatically. TLS and the source-pinned SHA256 stay mandatory.
  if curl -q --fail --silent --show-error --proto '=https' --proto-redir '=https' --tlsv1.2 --max-redirs 0 --connect-timeout 15 --max-time 180 --retry 2 --retry-delay 1 --retry-max-time 30 --max-filesize __MAX_NODE_RUNTIME_BYTES__ --output "$RUNTIME_ARCHIVE" "$RUNTIME_URL" >"$TMP/runtime-download.log" 2>&1; then :
  else
    download_rc=$?
    case "$download_rc" in
      60|77) bootstrap_error RMI_TLS_CERTIFICATE 'Runtime download could not validate HTTPS certificates.' 'Install/update ca-certificates and check the system clock or trusted proxy configuration. Do not disable TLS verification.' ;;
      23) bootstrap_error RMI_DOWNLOAD_WRITE 'Runtime download could not write the temporary file.' 'Check /tmp space, permissions and filesystem health.' ;;
      63) bootstrap_error RMI_RUNTIME_SIZE 'Runtime download exceeded the fixed size limit.' 'Stop and report the runtime version/platform; do not bypass the download limit.' ;;
      2|4|48) bootstrap_error RMI_CURL_VERSION 'curl does not support the required secure download options.' 'Update curl from the OS package manager; do not remove HTTPS/size checks.' ;;
      *) bootstrap_error RMI_DOWNLOAD "The official runtime download failed (curl exit $download_rc)." 'Check DNS, outbound HTTPS, proxy settings and nodejs.org availability, then retry. Enrollment has not started.' ;;
    esac
  fi
  RUNTIME_SIZE=$(wc -c < "$RUNTIME_ARCHIVE" | tr -d '[:space:]')
  case "$RUNTIME_SIZE" in ''|*[!0-9]*) bootstrap_error RMI_RUNTIME_SIZE 'Invalid runtime archive length.' 'Retry the official download; never execute a partial archive.' ;; esac
  [ "$RUNTIME_SIZE" -gt 0 ] && [ "$RUNTIME_SIZE" -le __MAX_NODE_RUNTIME_BYTES__ ] || bootstrap_error RMI_RUNTIME_SIZE 'Empty or oversized runtime archive.' 'Retry after checking the network and temporary disk space.'
  INSTALL_PHASE=runtime_checksum
  case "$RUNTIME_HASH_TOOL" in
    sha256sum) HASH_OUTPUT=$(sha256sum "$RUNTIME_ARCHIVE") || bootstrap_error RMI_CHECKSUM_TOOL 'sha256sum failed to read the archive.' 'Check file permissions and disk health.' ;;
    shasum) HASH_OUTPUT=$(shasum -a 256 "$RUNTIME_ARCHIVE") || bootstrap_error RMI_CHECKSUM_TOOL 'shasum could not verify the archive.' 'Restore the OS checksum tool; verification is required.' ;;
    openssl) HASH_OUTPUT=$(openssl dgst -sha256 -r "$RUNTIME_ARCHIVE") || bootstrap_error RMI_CHECKSUM_TOOL 'OpenSSL SHA-256 failed.' 'Restore a working OpenSSL checksum tool; verification is required.' ;;
  esac
  NODE_DIGEST=$(printf '%s\n' "$HASH_OUTPUT" | sed 's/[[:space:]].*$//')
  [ "$NODE_DIGEST" = "$NODE_SHA256" ] || bootstrap_error RMI_CHECKSUM_MISMATCH 'Official runtime SHA-256 does not match the pinned digest.' 'Do not extract or run this archive. Check proxy/cache integrity and retry from the official source.'
  INSTALL_PHASE=runtime_extract
  # Separate commands: a failed gzip cannot be hidden by a successful pipeline
  # consumer. tar does not need -J/-z support or an external xz executable.
  if gzip -dc "$RUNTIME_ARCHIVE" > "$TMP/node-runtime.tar" 2>"$TMP/runtime-extract.log"; then :
  else bootstrap_error RMI_DECOMPRESS 'The verified gzip runtime could not be decompressed.' 'Check gzip, temporary disk space and filesystem health; no enrollment was attempted.'; fi
  if tar -xf "$TMP/node-runtime.tar" -C "$RUNTIME_ROOT" >"$TMP/runtime-extract.log" 2>&1; then :
  else bootstrap_error RMI_EXTRACT 'The verified runtime tar archive could not be extracted.' 'Check tar support, free disk space and directory permissions. xz is not used.'; fi
  rm -f "$TMP/node-runtime.tar"
  NODE_DIRECTORY=$(printf '%s' "$NODE_ASSET" | sed 's/\.tar\.gz$//')
  NODE_HOME="$RUNTIME_ROOT/$NODE_DIRECTORY"
  NODE="$NODE_HOME/bin/node"
  NPM_CLI="$NODE_HOME/lib/node_modules/npm/bin/npm-cli.js"
  [ -x "$NODE" ] && [ -f "$NPM_CLI" ] || bootstrap_error RMI_RUNTIME_LAYOUT 'The verified archive is missing Node or npm.' 'Stop and report the pinned runtime version and platform; do not use partial installation files.'
  INSTALL_PHASE=runtime_execute
  if NODE_ACTUAL=$("$NODE" --version 2>"$TMP/runtime-execute.log"); then :
  else bootstrap_error RMI_RUNTIME_COMPATIBILITY 'The extracted Node runtime cannot execute on this host.' 'Check noexec on the temporary filesystem, CPU architecture and OS runtime libraries. Choose a trusted executable TMPDIR when /tmp is noexec. Official Linux archives require glibc; minimal musl-only images need a separately supported manual runtime.'; fi
  [ "$NODE_ACTUAL" = 'v__NODE_VERSION__' ] || bootstrap_error RMI_RUNTIME_VERSION 'The extracted runtime version does not match the fixed version.' 'Do not substitute a system Node or skip the pinned runtime check.'
}
`;
