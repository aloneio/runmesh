# Runner maintenance and complete uninstall

## One command, including old or incomplete installations

The administrator enrollment page provides the current one-command uninstall.
It downloads and authenticates the maintenance package in a temporary directory,
then runs cleanup outside the installed runtime. It needs no enrollment code,
working old executable, valid profile or preinstalled Node/npm. Network access
to the configured Worker and its pinned release assets is required.

Linux/macOS, run locally from an administrator terminal:

```sh
curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --max-redirs 0 --max-time 60 --max-filesize 262144 'https://runmesh.aloneio.workers.dev/runner/uninstall.sh' | sudo sh -s -- --purge --yes
```

On Windows, copy the PowerShell uninstall command from the administrator page.
The matching endpoint is `/runner/uninstall.ps1`; it also requires `--purge --yes`.
The temporary maintenance runtime avoids trying to delete its own Windows executable.
Do not run uninstall through the Runner connection being removed: service shutdown
will interrupt that connection. Use a local console or SSH session outside the service.

A locally verified dev.5-or-newer portable CLI can also run `uninstall --purge --yes`
on POSIX. Older releases' same-spelled command only removed their service/profile;
use the hosted maintenance command to clean those versions. A downloaded but
unverified CLI is not a substitute for the authenticated maintenance package.

## What complete purge removes

**This intentionally deletes local Runner job history and log files.** Export
anything needed first. Without `--purge`, the CLI retains its service-only behavior.
No interactive confirmation is added when `--purge --yes` is already supplied.

On Linux, cleanup covers `/opt/runmesh` (all versions, current/current.new,
staging directories and refresh locks), `/etc/runmesh`, `/var/lib/runmesh`,
`/var/log/runmesh`, the corresponding supported `runmesh-runner` config/state/log
locations, and `/run/runmesh`, `/run/runmesh-runner` plus their `/var/run` aliases.
Only symlink command shims which point into the managed installation are removed.

The exact `runmesh-runner.service` unit is handled in `/etc/systemd/system`,
`/run/systemd/system`, `/usr/local/lib/systemd/system`, `/usr/lib/systemd/system`
and `/lib/systemd/system`. Its drop-in directory and exact-name links in
`.wants`/`.requires` are removed, without deleting those shared directories.
Systemd is stopped/disabled before file cleanup, reloaded after it, and the
Runner's failed state is reset. Provider/permission failures are not silently
reported as success. Missing files are acceptable and repeated cleanup is safe.

macOS uses the managed LaunchDaemon/LaunchAgent and Runmesh application-support
layout. Windows uses the managed RunmeshRunner task, Program Files installation
and ProgramData layout. `--user` selects only the current user's layout when
using a local CLI, never every user's home directory.

## Safety boundaries and intentional retention

Project workspaces, application databases, other services, other users' installs,
existing system accounts/groups, and the shared system journal are retained.
Do not place unique project data inside application runtime directories. A cached
policy identifying a workspace nested inside a purge root blocks cleanup so that
workspace can be moved first. Custom profile paths do not authorize deleting their
parent directories; custom/npm-managed installations need their own package manager.

Symlinks are removed as links, not followed into their targets. Unexpected symlink
ancestors, unknown same-named services and mounted data filesystems stop cleanup.
Linux recursive cleanup uses pinned directory handles; Windows/macOS have identity
and confinement checks, not an equivalent hostile-local-mutator guarantee.
Run maintenance from a trusted host identity without concurrent install/uninstall.

A failed step returns nonzero and lists the remaining items. It is not labelled
successful merely because the service or profile disappeared. When data removal
fails, the installed maintenance CLI is retained where possible for diagnosis.
Control-plane Runner records and remote audit data are not deleted by local purge;
remove the Runner record separately in the administrator console.

## Installation output

Normal output shows numbered preparation/download/verification/install/connection/
service stages and a final ready message. Raw checksum success paths and release-
engineering terminology are hidden. HTTPS restrictions, size limits, pinned runtime
digests and release signature verification remain mandatory. Failures retain useful
exit-code and bounded diagnostic output. Installer rollback is deliberately separate
from full purge: it removes only state created by that installation attempt.
