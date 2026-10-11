# Upgrade an existing installation

[简体中文](upgrading.zh-CN.md) · [Documentation](README.md)

For a compatible protocol-v2 upgrade, keep the current Worker, Durable Object namespaces, D1 database, secrets, Runner profiles and service layout. For earlier installations, check the starting version covered by [legacy migration](migration.md).

## Choose the target version

Review the MCPs and Skills shared with the instance's clients before upgrading. After deployment, refresh client catalogs and Skill versions. Manage sharing and client access in the control panel as described in the [MCP and Skill guide](central-administration.md). Computer access continues to use the configured Runner and workspace permissions.

Read the [release notes](release-notes.md) and [release status](release-readiness.md). Production upgrades use published, independently verified signed packages; candidate and development prereleases belong in a separate test environment.

Keep the MCP and Skill bindings alongside the existing Registry and Runner namespaces. Preserve resource identities and both existing secrets; OAuth encryption uses `INTERNAL_CONTROL_SECRET`. Deploy the compatible Worker and verify it before updating Runners. The managed system-service procedure below accepts the actual installed version and an exact verified target, including an older dev installation such as `0.1.6-dev.26`.

For first-time remote version management, choose a [verified development package](dev-runner-prereleases.md) containing the independent `dist/maintenance.cjs` artifact. Set `ENABLE_MANAGER=1` or `$EnableManager = $true` in the shared staging steps, then [enable the manager](#enable-the-manager-after-the-package-switch). A package-only upgrade can leave that option off; the published 0.1.7 package predates this feature.

Plan these updates separately:

| Component | Update action |
| --- | --- |
| Worker | Deploy the reviewed control-plane code |
| Runner | Choose a release in the control panel; see [Change a Runner version](runner-versions.md) |
| MCP client | Refresh cached tool definitions after the Worker update |

Capabilities depend on the complete combination. For example, Context `storage` and `prune` are available from Runner 0.1.4. If an action returns `runner_upgrade_required`, install a compatible Runner and reconnect it so the Worker can read its current capabilities.

## Prepare a maintenance window

Record the expected Worker commit, each installed Runner version, service executable path and client tool catalog. Use the actual service executable for `runmesh --version`, with no additional arguments. Then run `runmesh doctor --json`; add `--profile` for a custom profile and `--user` for a user service.

Back up deployment configuration, secrets, control-plane data, Runner profile/state, service manifests, verified packages and project data. Rehearse restoration in a separate test instance.

Pause new submissions and finish or cancel queued/running Jobs before restarting a Runner. If a recovered Job reports `unknown` or `cancelling`, inspect its process on the host and retain its Job ID for follow-up. Include running Jobs in this check when revoking access.

## Apply the upgrade

1. **Rehearse the target combination.** Verify the signed release and exercise the Worker, Runner, service account and intended MCP client in a test environment.
2. **Deploy the Worker.** Use the existing production `main` deployment path, preserving resource bindings and secret values. Replacing `RUNNER_TOKEN_PEPPER` invalidates enrolled Runner credentials.
3. **Update each Runner.** Use [remote version management](runner-versions.md) for a managed installation with a version manager. For its first package update or a custom deployment, follow the applicable procedure below, keeping profile/state and the previous verified package available for recovery.
4. **Refresh the client catalog.** Reload the Runmesh connection and tool definitions in each MCP client.
5. **Complete acceptance checks**, then resume ordinary workloads.

Use the [portable installation examples](portable-runner-installation.md) for first installation. Existing installations keep their enrollment during package updates; credential recovery and complete removal have their own maintenance procedures.

## Update a user service

For user services on Linux, macOS and Windows, perform the update in the account that owns the service. Complete the maintenance preparation above, stop the service through its service manager, and update the verified package using your existing deployment method. Keep the service's executable path pointing to the updated package and retain its profile, state and service definition.

Run these commands with that updated executable and the existing profile. `install --user` refreshes the managed service and starts it. From 0.1.7, it also updates the user-service launch flag while preserving custom executable paths and other arguments.

On Linux or macOS:

```sh
set -e
RUNNER='/absolute/path/to/service/bin/runmesh'
PROFILE='/absolute/path/to/existing/profile.json'
"$RUNNER" --version
"$RUNNER" install --user --profile "$PROFILE"
"$RUNNER" doctor --user --profile "$PROFILE" --json
```

On Windows, use PowerShell in the service owner's session:

```powershell
$Runner = 'C:\path\to\service\runmesh.cmd'
$RunnerProfile = 'C:\path\to\existing\profile.json'
& $Runner --version
if ($LASTEXITCODE -ne 0) { throw 'Check the Runner executable path.' }
& $Runner install --user --profile $RunnerProfile
if ($LASTEXITCODE -ne 0) { throw 'Review the service installation output.' }
& $Runner doctor --user --profile $RunnerProfile --json
if ($LASTEXITCODE -ne 0) { throw 'Review the Runner health checks.' }
```

Confirm the displayed version matches your target, then complete the acceptance checks below. The existing Runner registration and profile carry over.

## Update a standard managed Runner without a version manager

The hosted command handles fresh installation and same-version enrollment refresh. For an older package, stage the exact verified target beside the installed version, switch `current` during the maintenance window, and start the existing service. This preserves the Runner ID, credential, workspace policy, profile/state, service account and service arguments. Do not use enrollment or `uninstall --purge` to perform this migration.

This procedure covers standard **system installations created by the hosted installer**. Confirm that the service launches through the `current` path below, that `current` is a link to the corresponding `versions` directory, and that the existing launchers use their relative private runtime. For user services, follow [Update a user service](#update-a-user-service). For custom system paths or an external Node layout, use your service owner's package-deployment procedure.

| System | Stable executable | Unchanged service definition |
| --- | --- | --- |
| Linux | `/opt/runmesh/current/bin/runmesh` | `/etc/systemd/system/runmesh-runner.service` and its existing overrides |
| macOS | `/opt/runmesh/current/bin/runmesh` | `/Library/LaunchDaemons/io.alone.runmesh.runner.plist` |
| Windows | `C:\Program Files\Runmesh\current\runmesh.cmd` | Existing `RunmeshRunner` scheduled task; source XML at `C:\ProgramData\Runmesh\RunmeshRunner.xml` |

Run the steps in one root/elevated administrator session with no other installation or maintenance running. If `manager` already exists under the installation root, use its [version-management or recovery procedure](runner-versions.md) instead. Complete backup and Job draining first. Obtain the matching release assets and a separately trusted source checkout using the [independent verification procedure](portable-runner-installation.md#independently-verify-a-downloaded-package). The steps below repeat its signature, release-contract, artifact-size and digest verification immediately before staging, using the trusted checkout's verifier and keyring.

Set `TARGET_VERSION` / `$TargetVersion` to the exact signed version you selected, and `DOWNLOAD` / `$Download` to its local asset directory. Use a trusted Node/npm installation for staging. The new package's private Node must satisfy 22.23.2+ within 22.x, or 24.21.0+ within 24.x. `STAGING_NODE` / `$StagingNode` defaults to the old private runtime; if that runtime is incompatible, set this optional input to a separately verified compatible Node executable. The steps copy it into the new package without modifying the old runtime.

Hosted installations may retain only the private Node executable and have no `npm` command. Before staging, obtain the matching OS/architecture distribution from the [official Node.js release directory](https://nodejs.org/download/release/), verify its signed checksums, and extract it into an administrator-owned temporary directory. Use a compatible version from the range above. Add that distribution's `bin` directory (POSIX), or the directory containing `node.exe` and `npm.cmd` (Windows), to this maintenance session's `PATH`; confirm `node --version` and `npm --version` succeed. The [local tarball installation procedure](portable-runner-installation.md#install-from-the-verified-local-tarball) uses the same offline npm method.

Before first manager setup, inspect the control panel's requested version. With no outstanding request, select the exact target being staged; an existing request for that target can remain. An outstanding request for a different version cannot be replaced through the form. Verify that queued release and decide whether to let the new manager finish it, then request your intended target after it reaches a terminal state. If that intermediate switch is unsuitable, perform only the package update with `ENABLE_MANAGER=0` / `$EnableManager = $false` and leave the manager uninstalled; the queued request remains pending. A newly started manager processes the existing request, even if you have just staged a newer package. First manager setup intentionally starts the Runner and manager; schedule it when both services may run.

### Stage the package on Linux or macOS

Replace the three input placeholders, and set the optional staging runtime if needed. Use `ENABLE_MANAGER=1` for first manager setup, or `0` for a package-only upgrade. Staging leaves the running service on the old package.

```sh
set -eu
unset NODE_OPTIONS NODE_PATH
umask 022
TARGET_VERSION='<verified-version>'
DOWNLOAD='/absolute/path/to/release-assets'
TRUSTED_CHECKOUT='/absolute/path/to/trusted-runmesh-checkout'
STAGING_NODE=''
ENABLE_MANAGER=1
KEY_ID=runmesh-preview-2026-01
ROOT=/opt/runmesh
case "$ENABLE_MANAGER" in 0|1) ;; *) exit 1 ;; esac
test ! -e "$ROOT/manager" && test ! -L "$ROOT/manager"
test -L "$ROOT/current"
OLD=$(CDPATH= cd "$ROOT/current" && pwd -P)
test "$(dirname "$OLD")" = "$ROOT/versions"
test -f "$OLD/runtime/node" && test ! -L "$OLD/runtime/node"
test -f "$OLD/bin/runmesh" && test ! -L "$OLD/bin/runmesh"
test -f "$OLD/bin/runmesh-runner" && test ! -L "$OLD/bin/runmesh-runner"
OLD_VERSION=$("$OLD/bin/runmesh" --version)
if [ -z "$STAGING_NODE" ]; then STAGING_NODE="$OLD/runtime/node"; fi
test -f "$STAGING_NODE" && test ! -L "$STAGING_NODE"
"$STAGING_NODE" -e 'const [m,n,p]=process.versions.node.split(".").map(Number);if(!((m===22&&(n>23||n===23&&p>=2))||(m===24&&(n>21||n===21&&p>=0))))process.exit(1)'
"$STAGING_NODE" "$TRUSTED_CHECKOUT/scripts/release-verify.mjs" "$DOWNLOAD/manifest.json" "$DOWNLOAD/manifest.sig" "$DOWNLOAD/manifest.signature.json" "$TRUSTED_CHECKOUT/release/trust-keyring.json" "$KEY_ID" "$TARGET_VERSION"
ARTIFACT="$DOWNLOAD/runmesh-runner-$TARGET_VERSION.tgz"
test -f "$ARTIFACT"
NEW="$ROOT/versions/$TARGET_VERSION"
test ! -e "$NEW" && test ! -L "$NEW"
test ! -e "$ROOT/current.next" && test ! -L "$ROOT/current.next"
case "$(uname -s)" in
  Linux) PROFILE=/etc/runmesh/profile.json ;;
  Darwin) PROFILE='/Library/Application Support/Runmesh/profile.json' ;;
  *) exit 1 ;;
esac
ORIGINAL_MODE=$("$STAGING_NODE" -e 'const p=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));if(!["dedicated_user","privileged_host"].includes(p.execution_mode))throw Error("Inspect the existing profile execution mode");console.log(p.execution_mode)' "$PROFILE")
printf 'Installed: %s; target: %s; execution mode: %s\n' "$OLD_VERSION" "$TARGET_VERSION" "$ORIGINAL_MODE"
NPM_CONFIG_DIR=$(mktemp -d /tmp/runmesh-upgrade-npm.XXXXXX)
: > "$NPM_CONFIG_DIR/user.npmrc"
: > "$NPM_CONFIG_DIR/global.npmrc"
mkdir "$NEW"
(cd "$NPM_CONFIG_DIR" && npm --userconfig "$NPM_CONFIG_DIR/user.npmrc" --globalconfig "$NPM_CONFIG_DIR/global.npmrc" install --global --ignore-scripts --offline --no-audit --no-fund --prefix "$NEW" "$ARTIFACT")
mkdir "$NEW/runtime"
cp "$STAGING_NODE" "$NEW/runtime/node"
# Replace npm's new symlinks before copying the private-runtime launchers.
rm "$NEW/bin/runmesh" "$NEW/bin/runmesh-runner"
cp "$OLD/bin/runmesh" "$OLD/bin/runmesh-runner" "$NEW/bin/"
chmod 0755 "$NEW/runtime/node" "$NEW/bin/runmesh" "$NEW/bin/runmesh-runner"
test "$("$NEW/bin/runmesh" --version)" = "$TARGET_VERSION"
"$NEW/bin/runmesh" --help
if [ "$ENABLE_MANAGER" -eq 1 ]; then
  MAINTENANCE_BUNDLE="$NEW/lib/node_modules/@aloneio/runmesh-runner/dist/maintenance.cjs"
  test -f "$MAINTENANCE_BUNDLE" && test ! -L "$MAINTENANCE_BUNDLE"
  "$NEW/runtime/node" "$MAINTENANCE_BUNDLE" --help > "$NPM_CONFIG_DIR/maintenance-help.txt"
  grep -q 'maintenance-agent' "$NPM_CONFIG_DIR/maintenance-help.txt"
fi
chmod -R a-w "$NEW"
printf 'Previous version directory: %s\n' "$OLD"
```

Retain the printed `OLD` path for rollback. Keep the new tree owned by the administrator and readable/executable by the existing service account; preserve any site-specific access policy.

### Switch the POSIX service

On **Linux**, run `systemctl stop runmesh-runner.service` and confirm `systemctl show runmesh-runner.service --property=ActiveState --value` reports `inactive` and `MainPID` is `0`.

On **macOS**, run `launchctl bootout system/io.alone.runmesh.runner` and confirm the old Runner process has exited. Booting out the loaded job keeps its `KeepAlive` setting from restarting it during the switch; the plist stays unchanged.

Once stopped, switch the link atomically with the verified new private Node:

```sh
ln -s "$NEW" "$ROOT/current.next"
"$NEW/runtime/node" -e 'const fs=require("node:fs");const [current,next,old]=process.argv.slice(1);if(!fs.lstatSync(current).isSymbolicLink()||fs.realpathSync(current)!==old)throw Error("Current installation changed");fs.renameSync(next,current)' "$ROOT/current" "$ROOT/current.next" "$OLD"
```

Start **Linux** with `systemctl start runmesh-runner.service`. Start **macOS** with `launchctl bootstrap system /Library/LaunchDaemons/io.alone.runmesh.runner.plist`. Run `/opt/runmesh/current/bin/runmesh --version` and `/opt/runmesh/current/bin/runmesh doctor --json`. For `ENABLE_MANAGER=1`, continue to [first manager setup](#enable-the-manager-after-the-package-switch) in the same shell; otherwise proceed to acceptance.

### Stage and switch on Windows

Use elevated PowerShell. Confirm the task's current action, principal, arguments and enabled state; keep that task definition. Replace the three input placeholders and set `$EnableManager` for first manager setup. The current junction and both version directories must reside under the standard install root.

```powershell
$ErrorActionPreference = 'Stop'
$TargetVersion = '<verified-version>'
$Download = 'C:\absolute\path\release-assets'
$TrustedCheckout = 'C:\absolute\path\trusted-runmesh-checkout'
$StagingNode = ''
$EnableManager = $true
$KeyId = 'runmesh-preview-2026-01'
$env:NODE_OPTIONS = $null
$env:NODE_PATH = $null
$env:NPM_CONFIG_UPDATE_NOTIFIER = 'false'
$env:npm_config_update_notifier = 'false'
$Root = 'C:\Program Files\Runmesh'
$Current = Join-Path $Root 'current'
$Next = Join-Path $Root 'current.next'
if (Test-Path -LiteralPath (Join-Path $Root 'manager')) { throw 'Use the already installed manager for version changes or recovery.' }
$Link = Get-Item -LiteralPath $Current -Force
if ($Link.LinkType -ne 'Junction') { throw 'Expected the managed current junction.' }
$Old = [IO.Path]::GetFullPath([string]$Link.Target)
if ([IO.Path]::GetDirectoryName($Old) -ine (Join-Path $Root 'versions')) { throw 'Current target is outside the managed versions directory.' }
$OldRunner = Join-Path $Old 'runmesh.cmd'
$OldVersion = (& $OldRunner --version).Trim()
if ($LASTEXITCODE -ne 0 -or $OldVersion -notmatch '^\d+\.\d+\.\d+(?:-dev\.\d+)?$') { throw 'Cannot identify the installed version.' }
if (-not $StagingNode) { $StagingNode = Join-Path $Old 'runtime\node.exe' }
@'
const [m,n,p] = process.versions.node.split(".").map(Number);
if (!((m === 22 && (n > 23 || n === 23 && p >= 2)) || (m === 24 && (n > 21 || n === 21 && p >= 0)))) process.exit(1);
'@ | & $StagingNode -
if ($LASTEXITCODE -ne 0) { throw 'Use a verified compatible private runtime before upgrading.' }
& $StagingNode (Join-Path $TrustedCheckout 'scripts\release-verify.mjs') (Join-Path $Download 'manifest.json') (Join-Path $Download 'manifest.sig') (Join-Path $Download 'manifest.signature.json') (Join-Path $TrustedCheckout 'release\trust-keyring.json') $KeyId $TargetVersion
if ($LASTEXITCODE -ne 0) { throw 'Release signature, identity or artifact verification failed.' }
$Artifact = Join-Path $Download "runmesh-runner-$TargetVersion.tgz"
$New = Join-Path $Root "versions\$TargetVersion"
$Previous = Join-Path $Root "current.previous-$OldVersion"
foreach ($Path in @($New, $Previous, $Next)) {
  if (Test-Path -LiteralPath $Path) { throw "Inspect the existing upgrade path: $Path" }
}
$RunnerProfile = 'C:\ProgramData\Runmesh\profile.json'
$OriginalMode = @'
const p = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"));
if (!["dedicated_user", "privileged_host"].includes(p.execution_mode)) throw Error("Inspect the existing profile execution mode");
console.log(p.execution_mode);
'@ | & $StagingNode - $RunnerProfile
if ($LASTEXITCODE -ne 0) { throw 'Inspect the existing profile; do not replace its enrollment.' }
$OriginalMode = ([string]$OriginalMode).Trim()
Write-Host "Installed: $OldVersion; target: $TargetVersion; execution mode: $OriginalMode"
$NpmConfig = Join-Path ([IO.Path]::GetTempPath()) ('runmesh-upgrade-npm-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $NpmConfig, $New | Out-Null
$UserConfig = Join-Path $NpmConfig 'user.npmrc'
$GlobalConfig = Join-Path $NpmConfig 'global.npmrc'
[IO.File]::WriteAllText($UserConfig, '')
[IO.File]::WriteAllText($GlobalConfig, '')
Push-Location -LiteralPath $NpmConfig
try {
  npm.cmd --userconfig $UserConfig --globalconfig $GlobalConfig install --global --ignore-scripts --offline --no-audit --no-fund --prefix $New $Artifact
  if ($LASTEXITCODE -ne 0) { throw 'Package staging failed.' }
} finally { Pop-Location }
New-Item -ItemType Directory -Path (Join-Path $New 'runtime') | Out-Null
Copy-Item -LiteralPath $StagingNode -Destination (Join-Path $New 'runtime\node.exe')
Copy-Item -LiteralPath (Join-Path $New 'node_modules\@aloneio\runmesh-runner\dist\runmesh.cjs') -Destination (Join-Path $New 'runmesh.cjs')
foreach ($Name in @('runmesh.cmd', 'runmesh-runner.cmd')) {
  Copy-Item -LiteralPath (Join-Path $Old $Name) -Destination (Join-Path $New $Name) -Force
}
$NewRunner = Join-Path $New 'runmesh.cmd'
if ((& $NewRunner --version).Trim() -ne $TargetVersion -or $LASTEXITCODE -ne 0) { throw 'Staged Runner version differs.' }
& $NewRunner --help
if ($LASTEXITCODE -ne 0) { throw 'Staged Runner help check failed.' }
if ($EnableManager) {
  $MaintenanceBundle = Join-Path $New 'node_modules\@aloneio\runmesh-runner\dist\maintenance.cjs'
  if (-not (Test-Path -LiteralPath $MaintenanceBundle -PathType Leaf)) { throw 'This target has no independent maintenance artifact.' }
  $MaintenanceHelp = & (Join-Path $New 'runtime\node.exe') $MaintenanceBundle --help
  if ($LASTEXITCODE -ne 0 -or ($MaintenanceHelp -join "`n") -notmatch 'maintenance-agent') { throw 'The maintenance artifact is incompatible.' }
}
```

Confirm the new files retain administrator ownership and the existing service account's read/execute access through the install root's ACL. In the same session, disable the existing task temporarily, stop it, and wait until it has no running instances and its state is Disabled or Ready. A disabled task can still have running instances. Then switch only its junction:

```powershell
$Task = Get-ScheduledTask -TaskName 'RunmeshRunner' -TaskPath '\'
$WasEnabled = [bool]$Task.Settings.Enabled
if ($EnableManager -and -not $WasEnabled) { throw 'First manager setup starts both services. Schedule explicit Runner activation before continuing.' }
Disable-ScheduledTask -TaskName 'RunmeshRunner' -TaskPath '\' | Out-Null
Stop-ScheduledTask -TaskName 'RunmeshRunner' -TaskPath '\'
$TaskScheduler = New-Object -ComObject Schedule.Service
$TaskScheduler.Connect()
$Deadline = [DateTime]::UtcNow.AddSeconds(30)
do {
  $StoppedTask = $TaskScheduler.GetFolder('\').GetTask('RunmeshRunner')
  if (-not [bool]$StoppedTask.Enabled -and ($StoppedTask.GetInstances(0)).Count -eq 0 -and ([int]$StoppedTask.State -eq 1 -or [int]$StoppedTask.State -eq 3)) { break }
  if ([DateTime]::UtcNow -ge $Deadline) { throw 'Wait for the old Runner to stop before switching.' }
  Start-Sleep -Milliseconds 200
} while ($true)
New-Item -ItemType Junction -Path $Next -Target $New | Out-Null
Rename-Item -LiteralPath $Current -NewName ([IO.Path]::GetFileName($Previous))
Rename-Item -LiteralPath $Next -NewName 'current'
if ($WasEnabled) {
  Enable-ScheduledTask -TaskName 'RunmeshRunner' -TaskPath '\' | Out-Null
  Start-ScheduledTask -TaskName 'RunmeshRunner' -TaskPath '\'
}
& (Join-Path $Current 'runmesh.cmd') --version
if ($LASTEXITCODE -ne 0) { throw 'Review the active Runner executable.' }
if ($WasEnabled) {
  & (Join-Path $Current 'runmesh.cmd') doctor --json
  if ($LASTEXITCODE -ne 0) { throw 'Review Runner health before resuming work.' }
}
```

A package-only update preserves an originally disabled task's state. Preserve `$Old` and `$Previous` through acceptance. For `$EnableManager = $true`, continue below in the same PowerShell session.

### Enable the manager after the package switch

Run this section only after the staged Runner reconnects with its original identity and the original execution mode matches its service account. Keep the mode read from the existing profile; `privileged_host` requires `--confirm-privileged-host` even for an existing full-host service. `install` below uses the existing canonical profile and omits `--executable-path`, preserving the managed service's selected executable, arguments and account. It may refresh known generated service fields.

On Linux/macOS, in the same root shell:

```sh
test "$ENABLE_MANAGER" -eq 1
test "$(cd "$ROOT/current" && pwd -P)" = "$NEW"
set -- install --profile "$PROFILE" --execution-mode "$ORIGINAL_MODE" --json
if [ "$ORIGINAL_MODE" = privileged_host ]; then set -- "$@" --confirm-privileged-host; fi
"$ROOT/current/bin/runmesh" "$@" > "$NPM_CONFIG_DIR/manager-install.json"
"$NEW/runtime/node" -e 'const r=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));if(r.remote_version_management!=="available"||r.execution_mode!==process.argv[2])throw Error("Inspect manager installation result");console.log("remote_version_management: available; execution_mode: "+r.execution_mode)' "$NPM_CONFIG_DIR/manager-install.json" "$ORIGINAL_MODE"
case "$(uname -s)" in
  Linux) systemctl is-active --quiet runmesh-manager.service ;;
  Darwin) launchctl print system/io.alone.runmesh.manager ;;
esac
"$ROOT/current/bin/runmesh" doctor --profile "$PROFILE" --json
```

On Windows, in the same elevated PowerShell session:

```powershell
if (-not $EnableManager) { throw 'Manager setup was not selected during staging.' }
if ([IO.Path]::GetFullPath([string](Get-Item -LiteralPath $Current -Force).Target) -ine $New) { throw 'Current installation changed.' }
$InstallArguments = @('install', '--profile', $RunnerProfile, '--execution-mode', $OriginalMode, '--json')
if ($OriginalMode -eq 'privileged_host') { $InstallArguments += '--confirm-privileged-host' }
$ManagerResult = & (Join-Path $Current 'runmesh.cmd') @InstallArguments
if ($LASTEXITCODE -ne 0) { throw 'Review manager installation output before retrying.' }
$ManagerReport = ($ManagerResult -join "`n") | ConvertFrom-Json
if ($ManagerReport.remote_version_management -ne 'available' -or $ManagerReport.execution_mode -ne $OriginalMode) { throw 'The manager or execution mode did not pass verification.' }
if ((Get-ScheduledTask -TaskName 'RunmeshManager' -TaskPath '\').State -ne 'Running') { throw 'Inspect the manager task and its logs.' }
& (Join-Path $Current 'runmesh.cmd') doctor --profile $RunnerProfile --json
if ($LASTEXITCODE -ne 0) { throw 'Review Runner health before resuming work.' }
```

The manager is copied from the verified package into the separate `manager` directory. Confirm the panel advances beyond waiting for a host manager, completes the requested target and shows the same Runner identity and policy. Service startup alone does not prove that an update was claimed. If setup reports `manual` / `custom_service_layout`, inspect the effective service definition and overrides; do not discard custom arguments to force activation.

### Recover the previous package

If a manager was started, stop it through the native service manager before a manual rollback and retain its package and journal. An unfinished version operation must be recovered before changing `current`; do not delete its journal or installation lock. Reconcile the panel's requested version before starting the manager again.

Once no maintenance operation is active, pause the Runner using the same platform steps. Read and record the actual physical target of `current` again, verify its package identity and confirm it is a direct child of the managed `versions` directory. A manager operation can change this path even when it installs the same version, so do not assume it still equals `NEW` / `$New`. On POSIX, record that path as `ROLLBACK_FROM`, create `current.next` pointing to the recorded `OLD` directory, and rename it over `current` with the same Node command, passing `ROLLBACK_FROM` as the expected current target. On Windows, while the task is disabled and stopped, rename the actual `current` junction to an unused recovery name, then rename the saved `$Previous` junction back to `current`. Check all resolved paths are still within `$Root` before renaming. Start through the preserved service definition and restore the task's previous enabled state.

Keep the profile, state and verified packages until the restored service passes its checks. Once acceptance is complete, remove the maintenance staging/config files created for this upgrade and retain the previous package according to your backup policy.

## Accept the result

Confirm the Worker's expected commit, then each actual service executable's version and `doctor --json` checks. Confirm Runner connectivity and workspace-policy acknowledgement.

From the intended MCP client, verify the selected Runner, list workspaces, read a harmless file and run a harmless command in an approved test workspace. Save the receipt, then query the same Job and its retained logs with the original `job_id` and `workspace_id`. Include an expected permission-denial check.

If your workflow uses input, cancellation, queueing or optional history, exercise those on controlled test Jobs. Record the component versions and the results before restoring ordinary work.

## Recover a failed step

| Observation | Action |
| --- | --- |
| Signature, hash, version or source mismatch | Stop activation and obtain a matching verified artifact |
| Uncertain command or edit result | Inspect the original Job or files before retrying |
| Service or compatibility failure | Preserve logs and state, then restore a tested compatible package/deployment/state combination |
| Credential loss, expiry or revocation | Use the appropriate access-extension, rotation or recovery enrollment procedure |

Restore the program, configuration and data versions together according to the rehearsed plan. Keep a copy of the current state and verified packages while investigating a failed upgrade.
