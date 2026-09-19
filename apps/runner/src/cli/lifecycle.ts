import { assertManagedServiceManifest } from "../service.js";
import { assertSystemInstallationPrivilege } from "./service-plan.js";
import type { CliDependencies } from "./contracts.js";
import { createServiceManager } from "../service.js";
import { createServiceProvisioner } from "../service.js";
import { currentServicePlatform } from "../service.js";
import { expectedServiceIdentity } from "../service.js";
import { hostServiceManifestFilesystem } from "../service.js";
import { inferExecutionModeFromManifest } from "./service-plan.js";
import { installServiceManifest } from "../service.js";
import { isManagedService } from "../service.js";
import { managedServiceManifestFromContent } from "../service.js";
import type { ParsedCommand } from "./contracts.js";
import { probeServiceStatus } from "./service-plan.js";
import { profileExecutionMode } from "../profile.js";
import { ProfileStore } from "../profile.js";
import { purgeInstallation } from "../purge.js";
import { removeServiceManifest } from "../service.js";
import { renderService } from "../service.js";
import { report } from "./reporting.js";
import { restoreManifestSnapshot } from "./service-plan.js";
import type { RunnerProfile } from "../profile.js";
import { sameEnrollmentProfile } from "./enrollment.js";
import { serviceCommandNames } from "./service-plan.js";
import { serviceLayout } from "../service.js";
import type { ServiceManagerAdapter } from "../service.js";
import { serviceManifestFor } from "./service-plan.js";
import { servicePrivilegeState } from "../service.js";
import { serviceProfilePath } from "../service.js";
import type { ServiceProvisioner } from "../service.js";

export async function serviceCommand(parsed: ParsedCommand, store: ProfileStore, output: (line: string) => void, dependencies: CliDependencies): Promise<void> {
  if (parsed.command === "migrate" && parsed.values.user === true) {
    throw new Error("service migration is only available for system Runner services; remove --user");
  }
  const manifest = await serviceManifestFor(parsed, store, dependencies.servicePlatform, dependencies.serviceFilesystem);
  const manager = dependencies.serviceManager ?? createServiceManager({ platform: manifest.platform, mode: manifest.mode });
  if (manager.platform !== manifest.platform || manager.mode !== manifest.mode) throw new Error("service manager does not match the requested service mode");
  if (parsed.command === "install" || parsed.command === "migrate") {
    if (parsed.command === "migrate" && typeof parsed.values.executionMode !== "string") throw new Error("service migration requires --execution-mode dedicated_user or --execution-mode privileged_host");
    assertSystemInstallationPrivilege(manifest, dependencies);
    // A service manifest always points at the persisted Runner profile. Do not
    // install/activate a service that is known to have no credentials; it
    // would otherwise enter a restart loop and report a misleading success.
    const profileBefore = await store.load();
    if (profileBefore === undefined) throw new Error("runner is not enrolled; run enroll before installing the service");
    const filesystem = dependencies.serviceFilesystem ?? hostServiceManifestFilesystem;
    const existingManifest = await filesystem.read(manifest.path);
    const existingManaged = existingManifest !== undefined && isManagedService(existingManifest);
    // Reject an unmanaged file before creating accounts, changing ACLs, or
    // touching the profile. `installServiceManifest` performs the same check
    // at its write boundary, but doing it here keeps a failed attempt free of
    // unrelated provisioning side effects.
    if (existingManifest !== undefined && !existingManaged) throw new Error(`refusing to overwrite unmanaged service manifest: ${manifest.path}`);
    // Probe the service under the mode that was actually persisted before
    // changing it.  During dedicated_user -> privileged_host migration the
    // new manifest intentionally describes SYSTEM/root, so using it for the
    // preflight probe could misclassify an old runmesh process as privileged.
    const previousExecutionMode = profileExecutionMode(profileBefore);
    // The managed manifest is the native service's actual contract. Prefer it
    // over a stale/mismatched profile field when reconstructing the previous
    // lifecycle request, so rollback reloads the same identity that was
    // running before this attempt.
    const inferredPreviousMode = existingManaged && existingManifest !== undefined
      ? inferExecutionModeFromManifest(manifest.platform, existingManifest)
      : previousExecutionMode === "dedicated_user" || previousExecutionMode === "privileged_host" ? previousExecutionMode : "dedicated_user";
    const previousManifestCandidate = renderService({
      ...(dependencies.servicePlatform === undefined ? {} : { platform: dependencies.servicePlatform }),
      mode: manifest.mode,
      profilePath: store.filePath,
      executionMode: inferredPreviousMode,
      ...(typeof parsed.values.executablePath === "string" ? { executablePath: parsed.values.executablePath } : {}),
    });
    // Rollback and the preflight status probe must use the exact managed body
    // that was installed before this transaction.  Re-rendering here would
    // discard custom executable paths/accounts and could restart the old
    // service with a different contract after a failed migration.
    const previousManifest = existingManaged && existingManifest !== undefined
      ? managedServiceManifestFromContent(previousManifestCandidate, existingManifest, inferredPreviousMode)
      : previousManifestCandidate;
    const privilegedConfirmation = parsed.values.confirmPrivilegedHost === true || dependencies.confirmPrivilegedHost === true;
    if (manifest.mode === "system" && manifest.executionMode === "privileged_host" && !privilegedConfirmation) {
      // Fail before provisioning, status probes, or profile mutation.  In
      // particular, a custom provisioner must not get a chance to make host
      // changes before the operator has acknowledged the one-time risk.
      throw new Error("privileged_host service installation requires --confirm-privileged-host");
    }
    let previousStatus: Awaited<ReturnType<NonNullable<ServiceManagerAdapter["status"]>>> | undefined;
    let statusProbeFailed = false;
    if (manager.status !== undefined) {
      try { previousStatus = await manager.status(previousManifest); } catch { statusProbeFailed = true; previousStatus = undefined; }
    }
    const statusProbeReliable = previousStatus !== undefined && previousStatus.reliable !== false;
    // Compare the requested contract with the mode represented by the
    // existing managed manifest as well as the profile. This catches stale
    // legacy/mismatched states where the JSON omits (or disagrees with) the
    // native service identity, and forces a real restart/identity check.
    const modeChanged = inferredPreviousMode !== manifest.executionMode;
    const requiresReliableLifecycleProbe = parsed.command === "migrate" || modeChanged || manifest.executionMode === "privileged_host" || (manifest.mode === "system" && existingManifest === undefined);
    if (requiresReliableLifecycleProbe && (manager.status === undefined || statusProbeFailed || !statusProbeReliable)) {
      throw new Error("service status probe is required and must succeed before privileged_host installation or execution-mode migration");
    }
    // Even when a normal dedicated-user reinstall does not need an identity
    // check, an explicitly unreliable native result must never be treated as
    // evidence that it is safe to replace an unknown service registration.
    if (manager.status !== undefined && (statusProbeFailed || (previousStatus !== undefined && previousStatus.reliable === false))) {
      throw new Error("service status probe is unavailable or unreliable; refusing to change the service");
    }
    if (manifest.mode === "system" && existingManifest === undefined && (manager.status === undefined || statusProbeFailed || !statusProbeReliable)) {
      throw new Error("service status probe is required before installing a system Runner without a managed manifest");
    }
    // Never take over a native service whose managed manifest is absent.  A
    // disabled unit/task can still be started by the next `install` call, and
    // an active one may be running a different executable or credential. The
    // operator must first restore/remove that registration explicitly.
    if (!existingManaged && statusProbeReliable && previousStatus !== undefined
      && (previousStatus.registered === true || previousStatus.installed || previousStatus.active)) {
      throw new Error("refusing to manage an existing native Runner service without its managed manifest; restore or remove the service first");
    }
    const provisioner = dependencies.serviceProvisioner ?? createServiceProvisioner({ platform: manifest.platform });
    let provisioned: Awaited<ReturnType<ServiceProvisioner["provision"]>> | undefined;
    let profileUpdated = false;
    let manifestChanged = false;
    let manifestWriteAttempted = false;
    let lifecycleAttempted = false;
    let provisioningAttempted = false;
    const profileTarget = { ...profileBefore, execution_mode: manifest.executionMode } as RunnerProfile;
    try {
      // Persist the selected mode before provisioning so the final profile
      // inode is the one whose ownership/ACLs the provisioner secures.  This
      // matters on Windows, where ProfileStore's atomic replacement cannot
      // reproduce NTFS ACEs by itself.  The catch block restores the previous
      // profile if provisioning or lifecycle setup fails.
      if (manifest.mode === "system" && profileBefore.execution_mode !== manifest.executionMode) {
        // Set the rollback marker before the atomic profile replacement.  A
        // save can rename the new inode successfully and then fail while
        // applying its final mode/ACL; the catch path must still restore the
        // previous snapshot in that partial-success case.
        profileUpdated = true;
        await store.save(profileTarget);
      }
      // Provisioning can change ownership/ACLs in several steps before it
      // returns a result. Mark the attempt first so a partial failure still
      // gets a best-effort restore to the previously persisted mode.
      provisioningAttempted = true;
      provisioned = await provisioner.provision(manifest, store.filePath);
      // Every machine service must be able to read its credential under the
      // selected identity.  Native provisioners return false when the profile
      // is absent or ACL/ownership setup could not be completed; fail before
      // writing or activating a service that cannot start safely.
      if (manifest.mode === "system" && !provisioned.profileSecured) {
        throw new Error(provisioned.detail ?? `Runner profile could not be secured for ${manifest.executionMode}; enroll before installing the service`);
      }
      // The provisioner changes the profile inode's owner/group as part of
      // machine-service setup. Verify the resulting canonical contract before
      // writing or activating the native registration; mode bits alone would
      // allow an attacker-owned 0600 profile to be consumed by root.
      if (manifest.mode === "system" && (manifest.executionMode === "dedicated_user" || manifest.executionMode === "privileged_host")) {
        await store.assertServiceOwnership(manifest.executionMode, manifest.serviceGroup);
      }
      // The host implementation is atomic, but injectable/filesystem adapters
      // may report an error after replacing the target.  Record the attempt
      // only after the unmanaged-file preflight above so rollback can restore
      // a managed snapshot without ever deleting an unrelated file.
      manifestWriteAttempted = existingManifest === undefined || existingManaged;
      manifestChanged = await installServiceManifest(manifest, filesystem, { confirmPrivilegedHost: privilegedConfirmation });
      // Mark before invoking the native adapter: an adapter can create/load a
      // task and then throw while waiting for its final status.  Rollback must
      // still reload the prior definition in that partial-success case.
      lifecycleAttempted = true;
      await manager.install(manifest);
      // `enable --now`/the platform equivalent does not replace an already
      // running process.  A changed managed manifest therefore gets an
      // explicit restart; an inactive service is started by install above.
      if ((manifestChanged || modeChanged) && previousStatus?.active === true) await manager.restart(manifest);

      // Privileged installs and every manifest migration must verify the
      // native manager's post-start identity.  Keep the first dedicated-user
      // install's historical command seam lightweight; doctor remains the
      // explicit identity probe for that path.
      // A privileged install and an explicit migration must always prove the
      // native identity.  For a normal dedicated-user reinstall retain the
      // historical lightweight command seam (doctor can still be used for an
      // identity probe); a mode transition to privileged_host is covered by
      // the first branch above.
      const mustVerify = manifest.executionMode === "privileged_host" || parsed.command === "migrate" || modeChanged;
      let verified: Awaited<ReturnType<NonNullable<ServiceManagerAdapter["status"]>>> | undefined;
      if (mustVerify) {
        if (manager.status === undefined) throw new Error("service status probe is required to verify privileged_host installation or migration");
        verified = await manager.status(manifest);
        if (verified.reliable === false) throw new Error("Runner service status could not be verified after installation");
        if (!verified.installed || !verified.active) throw new Error("Runner service did not become active after installation");
        const state = servicePrivilegeState(manifest, verified.identity, verified.active);
        if (state !== "privileged" && state !== "restricted") {
          throw new Error(`Runner service identity does not match execution mode (expected ${expectedServiceIdentity(manifest) ?? "interactive"}, got ${verified.identity ?? "unknown"})`);
        }
      }
      const identity = verified?.identity ?? provisioned.identity;
      report(output, parsed.json, {
        action: parsed.command,
        manifest: manifest.path,
        mode: manifest.mode,
        execution_mode: manifest.executionMode,
        configured_execution_mode: manifest.executionMode,
        identity,
        actual_service_identity: verified?.identity ?? null,
        privilege_state: verified === undefined ? servicePrivilegeState(manifest, provisioned.identity, true) : servicePrivilegeState(manifest, verified.identity, verified.active),
        profile_secured: provisioned.profileSecured,
        manifest_changed: manifestChanged,
        restarted: (manifestChanged || modeChanged) && previousStatus?.active === true,
        commands: serviceCommandNames("install", manifest),
      });
      return;
    } catch (cause) {
      // A failed lifecycle operation must not leave the profile claiming a
      // mode that was never activated. Restore the prior managed manifest and
      // profile on a best-effort basis, while preserving the original error.
      // A no-manifest install has no native service identity whose profile
      // ACL can be restored by the provisioner.  Even when the requested
      // execution mode is unchanged (`profileUpdated === false`), the
      // provisioner may have widened a legacy profile before failing; keep
      // that path in the private rollback below as well.
      if (profileUpdated || (!existingManaged && provisioningAttempted)) {
        // Do not clobber a profile written by another local operation while
        // this transaction was in flight.  If the selected snapshot is still
        // current, restore the exact pre-attempt bytes; otherwise leave the
        // newer operator change intact and let doctor surface any mismatch.
        let currentProfile: RunnerProfile | undefined;
        let profileProbeFailed = false;
        try { currentProfile = await store.load(); } catch { profileProbeFailed = true; }
        const expectedProfileSnapshot = profileUpdated ? profileTarget : profileBefore;
        const ownsProfileSnapshot = !profileProbeFailed && currentProfile !== undefined && sameEnrollmentProfile(currentProfile, expectedProfileSnapshot);
        if (ownsProfileSnapshot) {
          // A legacy profile has no managed service contract to restore.  A
          // failed privileged attempt may nevertheless have run the
          // dedicated provisioner's ACL steps before throwing, widening the
          // inode to root:runmesh/0640.  Force the no-service rollback back to
          // the canonical private root:root/0600 shape; managed dedicated
          // services retain their root:runmesh access contract below.
          await store.save(profileBefore, { privateOwnerOnly: !existingManaged }).catch(() => undefined);
        }
        // Restoring a profile on Windows also replaces its inode. Re-run the
        // previous-mode provisioner so the rollback does not leave a
        // credential file with inherited/default ACLs.
        // Re-run only when a managed service proves that this profile was
        // previously provisioned for a known native service identity.  A
        // legacy profile with no managed manifest has no dedicated account
        // contract to restore; invoking the dedicated provisioner there would
        // widen an owner-only profile to root:runmesh/0640 (or grant Local
        // Service read access on Windows) after a failed privileged attempt.
        // The profile save above explicitly restores a safe private inode for
        // that no-service case.
        if (existingManaged && ownsProfileSnapshot) await provisioner.provision(previousManifest, store.filePath).catch(() => undefined);
      }
      if (manifestWriteAttempted || manifestChanged) await restoreManifestSnapshot(filesystem, manifest, existingManaged ? existingManifest : undefined, existingManaged);
      // Restore the native process as well as the bytes/profile.  Otherwise a
      // failed migration can leave an old process running with a new profile
      // contract (or a newly-created privileged process alive after its
      // manifest was removed).  All cleanup is best-effort so the original
      // failure remains the actionable error.
      if (provisioningAttempted && !profileUpdated && existingManaged) {
        // Same-mode reinstalls do not replace the profile JSON, but their ACL
        // or ownership changes can still be partial. Re-run the old-mode
        // provisioner even when no profile migration was requested.
        await provisioner.provision(previousManifest, store.filePath).catch(() => undefined);
      }
      if (lifecycleAttempted) {
        if (existingManaged && existingManifest !== undefined) {
          const hadNativeService = statusProbeReliable && previousStatus !== undefined
            && (previousStatus.registered === true || previousStatus.installed === true || previousStatus.active === true);
          const wasRegisteredButDisabled = statusProbeReliable && previousStatus !== undefined
            && previousStatus.registered === true && previousStatus.installed !== true && previousStatus.active !== true;
          if (wasRegisteredButDisabled) {
            // Do not call manager.install() while restoring a disabled,
            // masked, or linked native registration.  The production Linux
            // adapter implements install as `enable --now`, which would
            // silently turn the operator's disabled state into an enabled
            // service during rollback (and a masked unit would fail with an
            // unnecessary error).  The restored manifest is already on disk;
            // stop is a harmless best-effort guard against an adapter that
            // partially started the candidate before throwing.  A native
            // disable hook then removes only an enablement introduced by this
            // attempt while leaving masked/linked/static registrations alone.
            // The next explicit install/start will reload the restored
            // definition.
            await manager.stop(previousManifest).catch(() => undefined);
            if (manager.disable !== undefined) await manager.disable(previousManifest).catch(() => undefined);
          } else if (statusProbeReliable && previousStatus !== undefined && !hadNativeService) {
            // There was no service before this attempt; remove any newly
            // created registration rather than starting the old definition.
            await manager.uninstall(previousManifest).catch(() => undefined);
          } else if (hadNativeService) {
            // Re-load the restored bytes before changing lifecycle state. A
            // restart alone can keep a cached/new unit or task definition.
            await manager.install(previousManifest).catch(() => undefined);
            if (previousStatus?.active === true) await manager.restart(previousManifest).catch(() => undefined);
            else if (previousStatus?.installed === true) await manager.stop(previousManifest).catch(() => undefined);
            else {
              // The preflight probe was unavailable.  Leave the restored
              // service stopped rather than risk a privileged process from
              // the failed attempt continuing under an unknown definition.
              await manager.stop(previousManifest).catch(() => undefined);
            }
          }
        } else if (statusProbeReliable && previousStatus !== undefined
          && previousStatus.registered !== true && !previousStatus.installed && !previousStatus.active) {
          // The preflight explicitly proved that no native service existed;
          // only in that case is it safe to remove a registration created by
          // this failed attempt.  Unknown status is intentionally left alone
          // so a custom/native service cannot be deleted as collateral.
          await manager.uninstall(manifest).catch(() => undefined);
        }
      }
      throw cause;
    }
  }
  const managed = await assertManagedServiceManifest(manifest, dependencies.serviceFilesystem);
  if (!managed) throw new Error("managed service manifest is not installed; refusing to stop or restart an unknown service");
  // Stopping/restarting a machine service is itself a privileged operation.
  // POSIX service managers normally reject an unprivileged caller, but
  // Windows Task Scheduler permissions can vary with the task ACL; enforce
  // the same administrator/root boundary here instead of relying on the
  // native command to fail (or, worse, allowing a local DoS of a SYSTEM
  // Runner).
  assertSystemInstallationPrivilege(manifest, dependencies);
  const lifecycleStatus = await probeServiceStatus(manager, manifest, parsed.command);
  if (lifecycleStatus !== undefined && lifecycleStatus.registered !== true && !lifecycleStatus.installed && !lifecycleStatus.active) {
    throw new Error(`cannot ${parsed.command} Runner service because it is not installed`);
  }
  if (parsed.command === "stop") await manager.stop(manifest);
  else {
    await manager.restart(manifest);
    // `systemctl restart` (and its platform equivalents) can return success
    // after scheduling a service that immediately crashes. Verify the
    // post-restart state so installers and operators do not receive a false
    // success while the Runner is already offline.
    if (manager.status !== undefined) {
      const restarted = await probeServiceStatus(manager, manifest, "restart");
      if (restarted === undefined) throw new Error("service status probe is unavailable after restart");
      if (restarted.active !== true) {
        throw new Error(`Runner service restart completed but the service is not active${restarted.detail === undefined ? "" : `: ${restarted.detail}`}`);
      }
    }
  }
  report(output, parsed.json, { action: parsed.command, manifest: manifest.path, mode: manifest.mode, commands: serviceCommandNames(parsed.command as "install" | "stop" | "restart", manifest) });
}

export async function uninstall(parsed: ParsedCommand, store: ProfileStore, output: (line: string) => void, dependencies: CliDependencies): Promise<void> {
  if (parsed.values.purge === true && parsed.values.yes !== true) throw new Error("--purge requires --yes");
  const mode = parsed.values.user === true ? "user" as const : "system" as const;
  const platform = dependencies.servicePlatform ?? currentServicePlatform();
  const layout = serviceLayout({ platform, mode });
  // Canonical complete cleanup cannot depend on a still-valid profile. A
  // previous uninstall or interrupted enrollment may already have removed it.
  if (parsed.values.purge === true && store.filePath === serviceProfilePath(layout)) {
    const probe = renderService({ platform, mode, executionMode: "dedicated_user" });
    assertSystemInstallationPrivilege(probe, dependencies);
    if (platform === "win32" && process.execPath.toLowerCase().startsWith(layout.installRoot.toLowerCase() + "\\")) {
      throw new Error("Run the hosted uninstall command so maintenance can remove the in-use runtime from a temporary location");
    }
    const result = await (dependencies.purgeInstallation ?? purgeInstallation)({ platform, mode, ...(parsed.json ? {} : { progress: output }) });
    if (parsed.json) output(JSON.stringify(result));
    else {
      for (const failure of result.failures) output(`  Remaining: ${failure.path} (${failure.reason})`);
      output(result.purged ? "Runmesh Runner removed. You can install it again now." : "Runmesh cleanup is incomplete; see the remaining items above.");
      output("Project workspaces and shared system accounts were not deleted.");
    }
    if (!result.purged) throw new Error("uninstall incomplete; cleanup left unresolved items");
    return;
  }
  const manifest = await serviceManifestFor(parsed, store, dependencies.servicePlatform, dependencies.serviceFilesystem);
  const manager = dependencies.serviceManager ?? createServiceManager({ platform: manifest.platform, mode: manifest.mode });
  if (manager.platform !== manifest.platform || manager.mode !== manifest.mode) throw new Error("service manager does not match the requested service mode");
  assertSystemInstallationPrivilege(manifest, dependencies);
  const managed = await assertManagedServiceManifest(manifest, dependencies.serviceFilesystem);
  const lifecycleStatus = managed ? await probeServiceStatus(manager, manifest, "uninstall") : undefined;
  // If the native probe proves that the registration is already absent, only
  // remove our managed manifest. Calling disable/delete in that state can
  // report a confusing error and, on some platforms, target a newly-created
  // same-name task between the probe and the command. An adapter without a
  // status hook retains the historical manifest-owned behavior.
  if (managed && (lifecycleStatus === undefined || lifecycleStatus.registered === true || lifecycleStatus.installed || lifecycleStatus.active)) await manager.uninstall(manifest);
  const removed = await removeServiceManifest(manifest, dependencies.serviceFilesystem);
  if (parsed.values.purge === true) await store.remove();
  // Noncanonical/custom profile paths never authorize removal of parent directories.
  // Complete installation cleanup is limited to the canonical branch above.
  report(output, parsed.json, { action: "uninstall", service_removed: removed, profile_removed: parsed.values.purge === true, mode: manifest.mode, commands: serviceCommandNames("uninstall", manifest) });
}
