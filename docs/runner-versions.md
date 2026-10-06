# Change a Runner version

[简体中文](runner-versions.zh-CN.md) · [Documentation](README.md)

Open **Runners**, select a computer, and use **Runner version** to install the latest release for your environment or an exact published version. You can choose an older version using the same form.

## Choose a version

1. Open the Runner's details in the control panel.
2. Choose the latest release, or select a specific version and enter its full number, such as `0.1.7` or `0.1.7-dev.123`.
3. Apply the change. The panel shows the requested version and its progress.

The latest release follows the control plane's environment: a dev instance selects a dev Runner, and a production instance selects a stable Runner. Entering an exact version selects that release directly, including earlier releases. Check the [release notes](release-notes.md) for the features available in your chosen version.

## What happens during the change

Runmesh verifies the published package, pauses new requests to that Runner, and waits for its local tasks to finish. It then switches the installed package and checks that the selected version reconnects to the control plane. The Runner keeps its identity, workspaces, credentials, task records and service account.

If the new version fails to start or reconnect, the version manager restores the previous package. The panel reports the result. An interrupted change is recovered from a local journal when the manager starts again.

Allow running tasks to finish before switching. If a task needs attention, resolve it in the task list or on the computer, then submit the version change again. A sleeping or disconnected computer picks up the request when its version manager can reach the control plane.

## Enable remote version management on an existing computer

New managed installations include the version manager. It runs separately from the selected Runner package, so choosing an older Runner leaves remote version management available.

Service commands such as `restart`, `install` and `uninstall` also use this independent manager after a version change. See [removing a Runner](runner-uninstall.md) for service removal and complete cleanup.

For an installation created before this feature, first update its package using the [existing installation guide](upgrading.md), then run the updated executable's `install` command with the existing profile. Use an administrator session for a system service, or the owning account with `--user` for a user service. This adds the version manager while retaining enrollment and the Runner's service identity.

The standard managed layout uses a `current` link and a `versions` directory. For a custom deployment layout, use the same package deployment process that created the service.
