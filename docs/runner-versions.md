# Change a Runner version

[简体中文](runner-versions.zh-CN.md) · [Documentation](README.md)

Open **Runners**, select a computer, and use **Runner version** to install the latest release for your environment or an exact published version. You can choose an older version using the same form.

Remote version management requires a 0.1.8-series control plane and initial installation of the independent manager from a matching Runner package. Check [release status](release-readiness.md) for the current stable package and the [development channel](dev-runner-prereleases.md) for preview releases.

## Choose a version

1. Open the Runner's details in the control panel.
2. Choose the latest release, or select a specific version and enter its full number, using the full version shown in [release status](release-readiness.md) or the development channel.
3. Apply the change. The panel shows the requested version and its progress.

The latest release follows the control plane's environment: a dev instance selects a dev Runner, and a production instance selects a stable Runner. Entering an exact version selects that release directly, including earlier releases. Check the [release notes](release-notes.md) for the features available in your chosen version.

## What happens during the change

Runmesh verifies the published package, pauses new requests to that Runner, and waits for its local tasks to finish. It then switches the installed package and checks that the selected version reconnects to the control plane. The Runner keeps its identity, workspaces, credentials, task records and service account.

If the new version fails to start or reconnect, the version manager attempts to restore the previous package. The panel reports the result. An interrupted change resumes recovery from a local journal when the manager starts again. If the panel reports `rollback_failed` or `local_state_invalid`, inspect the host's service and retained update state before requesting another change. A failed rollback keeps the maintenance hold in place while recovery is incomplete.

Complete an unfinished version change using its original Runner registration and control-plane address. If re-enrollment or a server change interrupts recovery, retain the local journal and restore the original profile before retrying.

Allow running tasks to finish before switching. Each wait for local work has a 15-minute limit; if the panel reports `busy_local_jobs`, resolve the task in the task list or on the computer, then submit the version change again. A sleeping or disconnected computer picks up the request when its version manager can reach the control plane. The manager normally checks for requests every 30–60 seconds while idle.

## Enable remote version management on an existing computer

Signed Runner packages that include the version manager provide remote updates for standard managed installations. The [upgrade guide](upgrading.md) covers package selection and first setup. It runs separately from the selected Runner package, so choosing an older Runner leaves remote version management available.

Changing the Runner version keeps the version manager already installed on that computer.

Service commands such as `restart`, `install` and `uninstall` also use this independent manager after a version change. See [removing a Runner](runner-uninstall.md) for service removal and complete cleanup.

For a standard system installation without a manager, follow the executable [managed Runner upgrade steps](upgrading.md#update-a-standard-managed-runner-without-a-version-manager), including [first manager setup](upgrading.md#enable-the-manager-after-the-package-switch). They support older dev packages such as `0.1.6-dev.26`, verify the exact signed target and its independent maintenance artifact, and preserve the existing profile, state, Runner identity and service parameters. No reenrollment or purge is needed. An already installed manager remains usable after a rollback to an older Runner; check the host before choosing the first-time procedure.

First setup runs `install` with the original profile and execution mode; an existing `privileged_host` system service still requires `--confirm-privileged-host`. Confirm `remote_version_management: available`, the local manager service and progress of the control-panel request. Inspect the queued target before startup; the manager processes that request first. Finish it or follow the recovery steps in the upgrade guide before requesting another target.

The standard managed layout uses a `current` link and a `versions` directory. For a user service, use the [user-service procedure](upgrading.md#update-a-user-service) in its owning account with `--user`. For a custom deployment layout, use the same package deployment process that created the service; `manual` / `custom_service_layout` requires inspecting the effective service definition.

## A request stays queued or the installer reports a version mismatch

If a request keeps waiting for the host manager, check the version manager service on the computer. For a Runner predating this feature, complete the initial setup above, then follow the original version request.

If the installer reports `installed Runner version differs from the fixed release`, the existing installation is still present. Hosted setup handles fresh installations and same-version enrollment refresh. To change versions on a standard managed installation without a manager, use the [parameterized package migration](upgrading.md#update-a-standard-managed-runner-without-a-version-manager), retaining the identity, configuration and task records.

Complete removal retires the installation and deletes local task records while preserving project workspaces. Use the current signed maintenance package. For a directory-overlap warning, follow [Runner removal](runner-uninstall.md) to check the workspace and installation paths before continuing.
