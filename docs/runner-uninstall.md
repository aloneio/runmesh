# Uninstall a Runner

Export any local Job history and logs you need before complete removal. **`--purge --yes` deletes that data immediately, without another confirmation.** Project workspaces are preserved.

Run the removal from a local console or an independent SSH session, so you can finish the operation after the Runner service stops.

## Choose the removal method

When its release channel is available, the enrollment page offers a hosted maintenance command. It downloads and authenticates a temporary runtime and maintenance package, then cleans up the installed layout. This works with old or incomplete installations and needs outbound HTTPS to the Worker and its pinned assets.

Check [release status](release-readiness.md) and your Worker's release channel before using its hosted maintenance command. For offline package preparation, obtain an independently verified maintenance release. A verified portable CLI with complete purge support can run `uninstall --purge --yes` on POSIX. Check its release notes, because older versions accept the same flags while removing fewer files.

On Windows, prefer the hosted maintenance command: it runs outside the installation being removed.

## Run complete removal

For Linux/macOS, replace the hostname with your Worker and run in an administrator terminal:

```sh
set -eu
maintenance="$(mktemp)"
trap 'rm -f "$maintenance"' EXIT
curl -q --fail --silent --show-error --proto '=https' --proto-redir '=https' --tlsv1.2 --max-redirs 0 --max-time 60 --max-filesize 262144 --output "$maintenance" 'https://your-runmesh.example/runner/uninstall.sh'
test -s "$maintenance"
sudo sh "$maintenance" --purge --yes
```

On Windows, copy the PowerShell removal command from the administrator page. The hosted endpoint is `/runner/uninstall.ps1`, also using `--purge --yes`.

For a local CLI, `--user` selects the current user's service layout. Omitting `--purge` selects ordinary service removal.

## What is removed

| Platform | Managed installation data and service |
| --- | --- |
| Linux | `/opt/runmesh` versions and staging, `/etc/runmesh`, `/var/lib/runmesh`, `/var/log/runmesh`, supported `runmesh-runner` config/state/log paths, and Runmesh runtime directories under `/run` or `/var/run` |
| macOS | Managed LaunchDaemon/LaunchAgent and Runmesh application-support layout |
| Windows | Managed RunmeshRunner task, Program Files installation and ProgramData layout |

On Linux, cleanup handles the exact `runmesh-runner.service` unit in the standard systemd locations, its drop-ins and exact-name links under `.wants`/`.requires`. It stops and disables the unit before cleanup, reloads systemd afterward and clears the failed state. Managed command symlinks pointing into the installation are removed.

Project workspaces, other services and installations, system accounts/groups and the shared system journal remain. Keep project data outside Runmesh runtime directories. If a cached policy identifies a workspace inside a purge directory, move that workspace before continuing. Use the appropriate package manager for custom or npm-managed layouts.

## Handle an interrupted cleanup

Run one installation, enrollment refresh or uninstall at a time. These operations share a lock. After an interruption, check for running maintenance processes before removing a stale lock or changing installation files.

If cleanup reports a symlinked parent directory, a same-named service from another installation, or a mounted data filesystem, inspect that path or service and confirm its ownership before retrying. Removing a selected symlink preserves its target.

A failed step returns a nonzero status and lists remaining items. Inspect that list; the maintenance CLI is retained where possible for diagnosis. Retry with the same verified maintenance release after correcting the cause.

## Confirm removal

Check the exit status, any remaining-item report and the host service manager. Confirm the expected local directories have been removed.

Then delete the Runner record in the administrator console if you also want to retire its remote identity. Remote audit/history follows its own retention rules.
