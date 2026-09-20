# Upgrade an existing installation

[简体中文](upgrading.zh-CN.md) · [Documentation](README.md)

For a compatible protocol-v2 upgrade, keep the current Worker, Durable Object namespaces, D1 database, secrets, Runner profiles and service layout. Use [legacy migration](migration.md) only for the older data boundary it names.

## Choose the target version

Read the [release notes](release-notes.md) and [release status](release-readiness.md). Production upgrades use published, independently verified signed packages; candidate and development prereleases belong in a separate test environment.

Plan these updates separately:

| Component | Update action |
| --- | --- |
| Worker | Deploy the reviewed control-plane code |
| Runner | Install the verified package on each host using its applicable service-update procedure |
| MCP client | Refresh cached tool definitions after the Worker update |

Capabilities depend on the complete combination. For example, Context `storage` and `prune` require support available in Runner 0.1.4. A compatible Worker returns `runner_upgrade_required` for an unsupported action. A supported Runner already connected during a Worker update may need to reconnect so its capabilities are recognized.

## Prepare a maintenance window

Record the expected Worker commit, each installed Runner version, service executable path and client tool catalog. Use the actual service executable for `runmesh --version`, with no additional arguments. Then run `runmesh doctor --json`; add `--profile` for a custom profile and `--user` for a user service.

Back up deployment configuration, secrets, control-plane data, Runner profile/state, service manifests, verified packages and project data. Rehearse restoration in a separate test instance.

Pause new submissions and drain queued/running Jobs before restarting a Runner. Inspect recovered `unknown` or `cancelling` processes on the host, and retain their Job IDs for follow-up. After revoking access, inspect running Jobs and their effects on the host.

## Apply the upgrade

1. **Rehearse the target combination.** Verify the signed release and exercise the Worker, Runner, service account and intended MCP client in a test environment.
2. **Deploy the Worker.** Use the existing production `main` deployment path, preserving resource bindings and secret values. Replacing `RUNNER_TOKEN_PEPPER` invalidates enrolled Runner credentials.
3. **Update each Runner.** Verify its archive against the trusted source keyring. For a standard hosted system installation, follow the managed upgrade procedure below. Preserve profile/state and keep the previous verified package available for recovery.
4. **Refresh the client catalog.** Reload the Runmesh connection and tool definitions in each MCP client.
5. **Complete acceptance checks**, then resume ordinary workloads.

Use the [portable installation examples](portable-runner-installation.md) for first installation. Existing installations keep their enrollment during package updates; credential recovery and complete removal have their own maintenance procedures.

## Update a standard managed Runner from 0.1.3 to 0.1.4

The hosted command handles fresh installation and same-version enrollment refresh. To update an existing package, stage the verified 0.1.4 package beside 0.1.3, switch the `current` link during the maintenance window, and start the existing service definition. This keeps the Runner ID, credential, workspace policy, profile/state, service account and service arguments intact.

This procedure covers standard **system installations created by the hosted installer**. Confirm that the service launches through the `current` path below, that `current` is a link to the corresponding `versions` directory, and that the existing launchers use their relative private runtime. Use your service owner's deployment procedure for user services, custom paths or an external Node layout.

| System | Stable executable | Unchanged service definition |
| --- | --- | --- |
| Linux | `/opt/runmesh/current/bin/runmesh` | `/etc/systemd/system/runmesh-runner.service` and its existing overrides |
| macOS | `/opt/runmesh/current/bin/runmesh` | `/Library/LaunchDaemons/io.alone.runmesh.runner.plist` |
| Windows | `C:\Program Files\Runmesh\current\runmesh.cmd` | Existing `RunmeshRunner` scheduled task; source XML at `C:\ProgramData\Runmesh\RunmeshRunner.xml` |

Run the steps in one root/elevated administrator session with no other installation or maintenance running. First complete the backup and Job-draining steps above. Verify `runmesh-runner-0.1.4.tgz` using the [independent signature and checksum procedure](portable-runner-installation.md#independently-verify-a-downloaded-package). Use a trusted Node/npm installation for staging. The retained private Node must satisfy 22.23.2+ within 22.x, or 24.21.0+ within 24.x.

### Stage the package on Linux or macOS

Set `ARTIFACT` to the absolute path of the independently verified archive. These commands create only the new version directory; the running service continues to use the old version.

```sh
set -eu
umask 022
ARTIFACT='/absolute/path/runmesh-runner-0.1.4.tgz'
ROOT=/opt/runmesh
NEW="$ROOT/versions/0.1.4"
test -L "$ROOT/current"
OLD=$(CDPATH= cd "$ROOT/current" && pwd -P)
case "$OLD" in "$ROOT"/versions/*) ;; *) exit 1 ;; esac
test "$("$OLD/bin/runmesh" --version)" = 0.1.3
test -f "$OLD/runtime/node" && test ! -L "$OLD/runtime/node"
test -f "$OLD/bin/runmesh" && test ! -L "$OLD/bin/runmesh"
test -f "$OLD/bin/runmesh-runner" && test ! -L "$OLD/bin/runmesh-runner"
test ! -e "$NEW" && test ! -L "$NEW"
test ! -e "$ROOT/current.next" && test ! -L "$ROOT/current.next"
"$OLD/runtime/node" -e 'const [m,n,p]=process.versions.node.split(".").map(Number);if(!((m===22&&(n>23||n===23&&p>=2))||(m===24&&(n>21||n===21&&p>=0))))process.exit(1)'
NPM_CONFIG_DIR=$(mktemp -d /tmp/runmesh-upgrade-npm.XXXXXX)
: > "$NPM_CONFIG_DIR/user.npmrc"
: > "$NPM_CONFIG_DIR/global.npmrc"
mkdir "$NEW"
(cd "$NPM_CONFIG_DIR" && npm --userconfig "$NPM_CONFIG_DIR/user.npmrc" --globalconfig "$NPM_CONFIG_DIR/global.npmrc" install --global --ignore-scripts --offline --no-audit --no-fund --prefix "$NEW" "$ARTIFACT")
mkdir "$NEW/runtime"
cp "$OLD/runtime/node" "$NEW/runtime/node"
# Replace npm's new symlinks before copying the private-runtime launchers.
rm "$NEW/bin/runmesh" "$NEW/bin/runmesh-runner"
cp "$OLD/bin/runmesh" "$OLD/bin/runmesh-runner" "$NEW/bin/"
chmod 0755 "$NEW/runtime/node" "$NEW/bin/runmesh" "$NEW/bin/runmesh-runner"
test "$("$NEW/bin/runmesh" --version)" = 0.1.4
"$NEW/bin/runmesh" --help
chmod -R a-w "$NEW"
printf 'Previous version directory: %s\n' "$OLD"
```

Retain the printed `OLD` path for rollback. Keep the new tree owned by the administrator and readable/executable by the existing service account; preserve any site-specific access policy.

### Switch the POSIX service

On **Linux**, run `systemctl stop runmesh-runner.service` and confirm `systemctl show runmesh-runner.service --property=ActiveState --value` reports `inactive` and `MainPID` is `0`.

On **macOS**, run `launchctl bootout system/io.alone.runmesh.runner` and confirm the old Runner process has exited. Booting out the loaded job keeps its `KeepAlive` setting from restarting it during the switch; the plist stays unchanged.

Once stopped, switch the link atomically with the retained private Node:

```sh
ln -s "$NEW" "$ROOT/current.next"
"$OLD/runtime/node" -e 'const fs=require("node:fs");const [current,next,old]=process.argv.slice(1);if(!fs.lstatSync(current).isSymbolicLink()||fs.realpathSync(current)!==old)throw Error("Current installation changed");fs.renameSync(next,current)' "$ROOT/current" "$ROOT/current.next" "$OLD"
```

Start **Linux** with `systemctl start runmesh-runner.service`. Start **macOS** with `launchctl bootstrap system /Library/LaunchDaemons/io.alone.runmesh.runner.plist`. Run `/opt/runmesh/current/bin/runmesh --version` and `/opt/runmesh/current/bin/runmesh doctor --json`, then complete the acceptance checks below.

### Stage and switch on Windows

Use elevated PowerShell. Confirm the task's current action, principal, arguments and enabled state; keep that task definition. Set `$Artifact` to the verified archive. The current junction and both version directories must reside under the standard install root.

```powershell
$ErrorActionPreference = 'Stop'
$Artifact = 'C:\absolute\path\runmesh-runner-0.1.4.tgz'
$Root = 'C:\Program Files\Runmesh'
$Current = Join-Path $Root 'current'
$New = Join-Path $Root 'versions\0.1.4'
$Previous = Join-Path $Root 'current.previous-0.1.3'
$Next = Join-Path $Root 'current.next'
$Link = Get-Item -LiteralPath $Current -Force
if ($Link.LinkType -ne 'Junction') { throw 'Expected the managed current junction.' }
$Old = [IO.Path]::GetFullPath([string]$Link.Target)
if (-not $Old.StartsWith(($Root + '\versions\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Current target is outside the managed versions directory.' }
foreach ($Path in @($New, $Previous, $Next)) {
  if (Test-Path -LiteralPath $Path) { throw "Inspect the existing upgrade path: $Path" }
}
$OldRunner = Join-Path $Old 'runmesh.cmd'
if ((& $OldRunner --version).Trim() -ne '0.1.3' -or $LASTEXITCODE -ne 0) { throw 'Expected Runner 0.1.3.' }
& (Join-Path $Old 'runtime\node.exe') -e 'const [m,n,p]=process.versions.node.split(".").map(Number);if(!((m===22&&(n>23||n===23&&p>=2))||(m===24&&(n>21||n===21&&p>=0))))process.exit(1)'
if ($LASTEXITCODE -ne 0) { throw 'Use a verified compatible private runtime before upgrading.' }
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
Copy-Item -LiteralPath (Join-Path $Old 'runtime\node.exe') -Destination (Join-Path $New 'runtime\node.exe')
Copy-Item -LiteralPath (Join-Path $New 'node_modules\@aloneio\runmesh-runner\dist\runmesh.cjs') -Destination (Join-Path $New 'runmesh.cjs')
foreach ($Name in @('runmesh.cmd', 'runmesh-runner.cmd')) {
  Copy-Item -LiteralPath (Join-Path $Old $Name) -Destination (Join-Path $New $Name) -Force
}
$NewRunner = Join-Path $New 'runmesh.cmd'
if ((& $NewRunner --version).Trim() -ne '0.1.4' -or $LASTEXITCODE -ne 0) { throw 'Staged Runner version differs.' }
& $NewRunner --help
if ($LASTEXITCODE -ne 0) { throw 'Staged Runner help check failed.' }
```

Confirm the new files retain administrator ownership and the existing service account's read/execute access through the install root's ACL. In the same session, disable the existing task temporarily, stop it, wait for termination, and switch only its junction:

```powershell
$Task = Get-ScheduledTask -TaskName 'RunmeshRunner' -TaskPath '\'
$WasEnabled = [bool]$Task.Settings.Enabled
Disable-ScheduledTask -TaskName 'RunmeshRunner' -TaskPath '\' | Out-Null
Stop-ScheduledTask -TaskName 'RunmeshRunner' -TaskPath '\'
$Deadline = (Get-Date).AddSeconds(30)
while ((Get-ScheduledTask -TaskName 'RunmeshRunner' -TaskPath '\').State -eq 'Running') {
  if ((Get-Date) -ge $Deadline) { throw 'Wait for the old Runner to stop before switching.' }
  Start-Sleep -Milliseconds 200
}
New-Item -ItemType Junction -Path $Next -Target $New | Out-Null
Rename-Item -LiteralPath $Current -NewName 'current.previous-0.1.3'
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

An originally disabled task stays disabled; its operator chooses when to start it. Preserve the old version directory and `current.previous-0.1.3` junction through acceptance.

### Recover the previous package

If acceptance fails, pause the service using the same platform steps. On POSIX, create `current.next` pointing to the recorded `OLD` directory and rename it over `current` with the same Node command, supplying the current 0.1.4 target as the expected old argument. On Windows, while the task is disabled and stopped, rename the new `current` junction to an unused `current.failed-0.1.4` name, then rename `current.previous-0.1.3` back to `current`. Start through the unchanged service definition and restore the task's previous enabled state.

Keep profile, state and verified packages until the compatible recovery combination is confirmed. Once acceptance is complete, remove only the maintenance staging/config files that you created and retain the previous package according to your backup policy.

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

Restore data and binaries together according to the rehearsed plan. Older binaries may interpret newer state or history settings differently. Keep durable state and immutable release assets intact while investigating.
