import type { CliDependencies } from "./contracts.js";
import { createServiceManager } from "../service.js";
import { discoverShellRuntime } from "../runtime.js";
import type { DoctorCheck } from "./contracts.js";
import type { DoctorReport } from "./contracts.js";
import { EnvironmentInfoService } from "../runtime.js";
import { errorMessage } from "./reporting.js";
import type { ExecutionMode } from "../service.js";
import { expectedServiceIdentity } from "../service.js";
import { formatMode } from "./reporting.js";
import { hostServiceManifestFilesystem } from "../service.js";
import { isManagedService } from "../service.js";
import { managedServiceManifestFromContent } from "../service.js";
import { profileExecutionMode } from "../profile.js";
import { ProfileStore } from "../profile.js";
import { redactedProfile } from "../profile.js";
import { renderService } from "../service.js";
import { RUNNER_VERSION } from "../version.js";
import type { RunnerProfile } from "../profile.js";
import type { ServicePlatform } from "../service.js";
import { servicePrivilegeState } from "../service.js";
import type { ServicePrivilegeState } from "../service.js";
import type { ShareableDoctorReport } from "./contracts.js";
import { workspaceOptions } from "../profile.js";

/** Strict allow-list projection intended for issue/support sharing. */
export function shareableDoctorReport(report: DoctorReport, nowMs = Date.now()): ShareableDoctorReport {
  return {
    schema_version: 1,
    generated_at_ms: nowMs,
    runner_version: RUNNER_VERSION,
    ok: report.ok,
    configured: report.profile !== undefined,
    checks: report.checks.map((check) => ({
      name: check.name.startsWith("workspace:") ? "workspace" : check.name,
      required: check.required,
      ok: check.ok,
      status: check.status,
    })),
    service: {
      mode: report.service.mode,
      execution_mode: report.service.execution_mode,
      privilege_state: report.service.privilege_state,
    },
  };
}

export async function doctor(store: ProfileStore, mode: "system" | "user" = "system", platform: ServicePlatform | undefined = undefined, dependencies: Pick<CliDependencies, "serviceFilesystem" | "serviceManager" | "environment" | "discoverShellRuntime" | "policyRevision"> = {}): Promise<DoctorReport> {
  let profile: RunnerProfile | undefined;
  let profileLoadError: string | undefined;
  try { profile = await store.load(); }
  catch (error) { profileLoadError = errorMessage(error); }
  const permissions = await store.permissions();
  const checks: DoctorCheck[] = [];
  const add = (name: string, required: boolean, ok: boolean, detail?: string): void => {
    checks.push({ name, required, ok, status: ok ? "ok" : required ? "failure" : "warning", ...(detail === undefined ? {} : { detail }) });
  };
  const enrolled = profile !== undefined;
  add("profile", true, enrolled, enrolled ? undefined : profileLoadError ?? "not enrolled");
  const storedMode = profileExecutionMode(profile);
  const executionMode: ExecutionMode | undefined = mode === "user" ? "dedicated_user" : storedMode;
  // ProfileStore permissions describe the host on which this CLI is running,
  // whereas `platform` can be injected to inspect a rendered service for a
  // different target platform.  Do not apply POSIX mode-bit rules to a
  // Windows profile merely because the requested service target is Linux.
  const posix = process.platform !== "win32";
  // A system service deliberately grants its dedicated `runmesh` group
  // traversal/read access to the profile (0750/0640).  User profiles remain
  // owner-only (0700/0600); both shapes are exact, bounded permission sets.
  // Do not accept arbitrary group/other bits here: `permissions()` reports
  // the final component without following symlinks, so this is the same
  // credential boundary enforced by ProfileStore.
  const ownerOnlyProfile = mode === "user" || executionMode === "privileged_host";
  const safeProfileDirectory = ownerOnlyProfile ? permissions.directory_mode === 0o700 : permissions.directory_mode === 0o700 || permissions.directory_mode === 0o750;
  const safeProfileFile = ownerOnlyProfile ? permissions.file_mode === 0o600 : permissions.file_mode === 0o600 || permissions.file_mode === 0o640;
  const expectedDirectoryModes = ownerOnlyProfile ? "0700" : "0700 or 0750";
  const expectedFileModes = ownerOnlyProfile ? "0600" : "0600 or 0640";
  add("profile_directory_permissions", true, enrolled && (!posix || safeProfileDirectory), !enrolled ? "not enrolled" : posix ? `mode ${formatMode(permissions.directory_mode)} (expected ${expectedDirectoryModes})` : "ACL permissions not inspected");
  add("profile_file_permissions", true, enrolled && (!posix || safeProfileFile), !enrolled ? "not enrolled" : posix ? `mode ${formatMode(permissions.file_mode)} (expected ${expectedFileModes})` : "ACL permissions not inspected");
  // Mode bits alone do not establish who controls a privileged profile: a
  // hostile account can create an apparently private 0600 file and a root
  // process would otherwise accept it.  Check the canonical POSIX owner/group
  // contract independently and expose a bounded administrator diagnostic.
  let ownershipCheck: Awaited<ReturnType<ProfileStore["checkServiceOwnership"]>> | undefined;
  let ownershipError: string | undefined;
  const ownershipRequired = enrolled && mode === "system" && posix && (executionMode === "dedicated_user" || executionMode === "privileged_host");
  if (profile !== undefined) {
    const url = urlCheck(profile.server_url, profile.insecure_local === true);
    add("server_url", true, url.ok, url.detail);
    for (const workspace of profile.workspaces) {
      const exists = await isDirectory(workspace.path);
      add(`workspace:${workspace.id}`, true, exists, exists ? undefined : "missing or not a directory");
    }
  } else add("server_url", false, false, "not enrolled");

  const manifest = renderService({ ...(platform === undefined ? {} : { platform }), mode, profilePath: store.filePath, ...(executionMode === undefined ? {} : { executionMode }) });
  add("execution_mode", enrolled, executionMode !== undefined, !enrolled ? "not enrolled" : executionMode === undefined ? "profile is incomplete; enroll again with the current Runner" : executionMode);
  let serviceContent: string | undefined;
  try { serviceContent = await (dependencies.serviceFilesystem ?? hostServiceManifestFilesystem).read(manifest.path); } catch (error) { add("service_manifest", true, false, errorMessage(error)); }
  if (!checks.some((check) => check.name === "service_manifest")) {
    const managed = serviceContent !== undefined && isManagedService(serviceContent);
    add("service_manifest", true, managed, serviceContent === undefined ? "not installed" : managed ? undefined : "unmanaged manifest");
  }
  let serviceProbeManifest = manifest;
  if (executionMode === "dedicated_user" && serviceContent !== undefined && isManagedService(serviceContent)) {
    try { serviceProbeManifest = managedServiceManifestFromContent(manifest, serviceContent, "dedicated_user"); }
    catch { serviceProbeManifest = manifest; }
  }
  if (profile !== undefined && mode === "system" && (executionMode === "dedicated_user" || executionMode === "privileged_host")) {
    // Resolve an operator-selected dedicated group from the managed unit
    // before checking the profile inode.  A custom group is part of the local
    // service contract; falling back to `runmesh` here would reject a healthy
    // migration even though the native service can read the credential.
    let serviceGroup: string | undefined;
    if (executionMode === "dedicated_user" && serviceContent !== undefined && isManagedService(serviceContent)) {
      try {
        serviceGroup = serviceProbeManifest.serviceGroup;
      } catch { serviceGroup = undefined; }
    }
    try { ownershipCheck = await store.checkServiceOwnership(executionMode, serviceGroup); }
    catch (error) { ownershipError = errorMessage(error); }
  }
  add("profile_ownership", ownershipRequired, !ownershipRequired || ownershipCheck?.ok === true, !enrolled ? "not enrolled" : ownershipError ?? ownershipCheck?.detail ?? (ownershipCheck?.ok === true ? "canonical ownership verified" : ownershipRequired ? "canonical ownership could not be verified" : "non-system profile"));
  const manager = dependencies.serviceManager ?? createServiceManager({ platform: manifest.platform, mode: manifest.mode });
  let actualServiceIdentity: string | null = null;
  let privilegeState: ServicePrivilegeState = "unknown";
  const expectedIdentity = executionMode === undefined ? undefined : expectedServiceIdentity(serviceProbeManifest);
  const serviceIdentityRequired = expectedIdentity !== undefined;
  if (manager.platform !== manifest.platform || manager.mode !== manifest.mode || manager.status === undefined) {
    const detail = "service status probe unavailable";
    add("service_installed", serviceIdentityRequired, false, detail);
    add("service_active", serviceIdentityRequired, false, detail);
    add("service_identity", serviceIdentityRequired, false, detail);
    add("service_privilege_state", serviceIdentityRequired, false, detail);
  } else {
    try {
      const status = await manager.status(serviceProbeManifest);
      actualServiceIdentity = status.identity ?? null;
      privilegeState = servicePrivilegeState(serviceProbeManifest, status.identity, status.active);
      if (status.reliable === false) {
        const detail = status.detail ?? "native service status probe was unreliable";
        add("service_installed", true, false, detail);
        add("service_active", true, false, detail);
        add("service_identity", serviceIdentityRequired, false, detail);
        add("service_privilege_state", serviceIdentityRequired, false, detail);
      } else {
        add("service_installed", true, status.installed, status.detail);
        add("service_active", true, status.active, status.detail);
        const identityMatches = expectedIdentity === undefined ? true : privilegeState === "privileged" || privilegeState === "restricted";
        add("service_identity", serviceIdentityRequired, identityMatches, status.identity ?? "service identity unavailable");
        // A user-level service has no fixed account name, but a reported
        // host-wide identity is still a mismatch and must be visible to
        // doctor rather than being silently accepted as an optional probe.
        const privilegeProbeRequired = serviceIdentityRequired || privilegeState === "mismatch";
        add("service_privilege_state", privilegeProbeRequired, privilegeProbeRequired ? privilegeState !== "mismatch" && privilegeState !== "unknown" : true, privilegeState);
      }
    } catch (error) {
      const detail = errorMessage(error);
      add("service_installed", true, false, detail);
      add("service_active", true, false, detail);
      add("service_identity", serviceIdentityRequired, false, detail);
      add("service_privilege_state", serviceIdentityRequired, false, detail);
    }
  }
  const shell = await (dependencies.discoverShellRuntime ?? (() => discoverShellRuntime()))();
  const shellRequired = profile?.workspaces.some((workspace) => workspace.shell) === true;
  add("shell_runtime", shellRequired, shell !== undefined, shell === undefined ? "Host shell runtime unavailable" : `${shell.kind}: ${shell.executable}`);
  const environment = await (dependencies.environment ?? new EnvironmentInfoService()).get(profile === undefined ? [] : workspaceOptions(profile));
  const tools = (environment.tools ?? {}) as Record<string, { available?: unknown }>;
  add("tool:node", true, tools.node?.available === true);
  add("tool:git", false, tools.git?.available === true, tools.git?.available === true ? undefined : "optional");
  add("tool:python", false, tools.python?.available === true, tools.python?.available === true ? undefined : "optional");
  add("tool:docker", false, tools.docker?.available === true, tools.docker?.available === true ? undefined : "optional");
  try {
    const revision = await dependencies.policyRevision?.();
    if (revision === undefined) add("policy_revision", false, false, "not available locally");
    else {
      const desired = revision.desired; const applied = revision.applied;
      const valid = (desired === undefined || Number.isSafeInteger(desired) && desired >= 0) && (applied === undefined || Number.isSafeInteger(applied) && applied >= 0);
      add("policy_revision", false, valid, valid ? `desired=${desired ?? "unknown"}, applied=${applied ?? "unknown"}` : "invalid revision");
    }
  } catch (error) { add("policy_revision", false, false, errorMessage(error)); }
  return {
    ok: checks.filter((check) => check.required).every((check) => check.ok),
    checks,
    profile: redactedProfile(profile),
    service: {
      manifest: manifest.path,
      mode,
      execution_mode: executionMode ?? null,
      configured_execution_mode: executionMode ?? null,
      actual_service_identity: actualServiceIdentity,
      privilege_state: privilegeState,
    },
  };
}

async function isDirectory(path: string): Promise<boolean> { return (await import("node:fs/promises")).lstat(path).then((value) => value.isDirectory()).catch(() => false); }

function urlCheck(value: string, insecureLocal = false): { ok: boolean; detail?: string } {
  try {
    const url = new URL(value);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    const safe = url.username === "" && url.password === "" && url.search === "" && url.hash === "";
    return safe && (url.protocol === "wss:" || (url.protocol === "ws:" && loopback && insecureLocal)) ? { ok: true } : { ok: false, detail: "wss:// is required and URL credentials/query/fragment are not allowed" };
  } catch { return { ok: false, detail: "invalid URL" }; }
}
