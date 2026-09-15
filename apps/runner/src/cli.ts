import { assertSupportedNodeVersion } from "./version.js";
import type { CliDependencies } from "./cli/contracts.js";
import { createServiceManager } from "./service.js";
import { doctor } from "./cli/doctor.js";
import { enrollmentCode } from "./cli/enrollment.js";
import { enrollmentFailureMessage } from "./cli/enrollment.js";
import { enrollRunner } from "./enrollment.js";
import { EnvironmentInfoService } from "./runtime.js";
import type { ExecutionMode } from "./service.js";
import { HELP } from "./cli/help.js";
import { hostServiceManifestFilesystem } from "./service.js";
import { isEnrollmentOutcomeUnknown } from "./enrollment.js";
import { isManagedService } from "./service.js";
import { managedServiceManifestFromContent } from "./service.js";
import type { ParsedCommand } from "./cli/contracts.js";
import { parseProductArgs } from "./cli/input.js";
import { profileExecutionMode } from "./profile.js";
import { profileManagementMode } from "./profile.js";
import { ProfileStore } from "./profile.js";
import { redactedProfile } from "./profile.js";
import { removeEnrollmentProfileIfCurrent } from "./cli/enrollment.js";
import { renderService } from "./service.js";
import { report } from "./cli/reporting.js";
import { requiredString } from "./cli/input.js";
import { requireProfile } from "./cli/input.js";
import { RUNNER_VERSION } from "./version.js";
import type { RunnerProfile } from "./profile.js";
import { serviceCommand } from "./cli/lifecycle.js";
import type { ServiceManagerAdapter } from "./service.js";
import type { ServiceManifest } from "./service.js";
import { servicePrivilegeState } from "./service.js";
import type { ServicePrivilegeState } from "./service.js";
import { shareableDoctorReport } from "./cli/doctor.js";
import { start } from "./cli/supervisor.js";
import { storeFor } from "./cli/input.js";
import { uninstall } from "./cli/lifecycle.js";
import { workspaceOptions } from "./profile.js";

export async function runCli(argv: readonly string[], dependencies: CliDependencies = {}): Promise<void> {
  assertSupportedNodeVersion();
  const output = dependencies.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const error = dependencies.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) { output(HELP); return; }
  if (argv.length === 1 && argv[0] === "--version") { output(RUNNER_VERSION); return; }
  const parsed = parseProductArgs(argv);
  const store = dependencies.store ?? storeFor(parsed, dependencies.servicePlatform);
  let previousProfile: RunnerProfile | undefined;
  let enrolledDuringThisInvocation = false;
  let enrolledProfile: RunnerProfile | undefined;
  try {
    // Await startup inside the command boundary so initialization failures
    // flow through the same stderr handler as every other CLI command. A
    // bare `return start(...)` escapes this try/catch and makes embedded
    // callers (including service wrappers) lose the actionable error detail.
    if (parsed.command === "start") { await start(parsed, store, error, dependencies); return; }
    if (parsed.command === "enroll") {
      const server = requiredString(parsed, "server"); const code = await enrollmentCode(parsed, dependencies.readStdin);
      previousProfile = await store.load();
      const result = await enrollRunner({
        server,
        code,
        reEnroll: parsed.values.reEnroll === true,
        insecureLocal: parsed.values.insecureLocal === true,
        ...(typeof parsed.values.executionMode === "string" ? { executionMode: parsed.values.executionMode as ExecutionMode } : dependencies.executionMode === undefined ? {} : { executionMode: dependencies.executionMode }),
        ...(parsed.values.confirmPrivilegedHost === true || dependencies.confirmPrivilegedHost === true ? { confirmPrivilegedHost: true } : {}),
        ...(typeof parsed.values.cwd === "string" ? { cwd: parsed.values.cwd } : {}),
        store,
        ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      });
      enrolledDuringThisInvocation = true;
      enrolledProfile = result.profile;
      if (dependencies.afterEnroll !== undefined) await dependencies.afterEnroll();
      report(output, parsed.json, { enrolled: true, runner_id: result.profile.runner_id, workspace_count: result.profile.workspaces.length });
      return;
    }
    if (parsed.command === "status") {
      const profile = await store.load();
      const serviceMode = parsed.values.user === true ? "user" as const : "system" as const;
      const configuredMode = profile === undefined ? undefined : serviceMode === "user" ? "dedicated_user" as const : profileExecutionMode(profile);
      let manifest: ServiceManifest | undefined;
      let statusManifest: ServiceManifest | undefined;
      let runtimeStatus: Awaited<ReturnType<NonNullable<ServiceManagerAdapter["status"]>>> | undefined;
      if (profile !== undefined && configuredMode !== undefined) {
        manifest = renderService({ ...(dependencies.servicePlatform === undefined ? {} : { platform: dependencies.servicePlatform }), mode: serviceMode, profilePath: store.filePath, ...(configuredMode === "dedicated_user" || configuredMode === "privileged_host" ? { executionMode: configuredMode } : {}) });
        statusManifest = manifest;
        if (manifest.mode === "system" && manifest.executionMode === "dedicated_user") {
          try {
            const existing = await (dependencies.serviceFilesystem ?? hostServiceManifestFilesystem).read(manifest.path);
            if (existing !== undefined && isManagedService(existing)) statusManifest = managedServiceManifestFromContent(manifest, existing, "dedicated_user");
          } catch { /* status still uses the profile's safe default identity */ }
        }
        const manager = dependencies.serviceManager ?? createServiceManager({ platform: manifest.platform, mode: manifest.mode });
        if (manager.platform === manifest.platform && manager.mode === manifest.mode && manager.status !== undefined) {
          try { runtimeStatus = await manager.status(statusManifest); } catch { runtimeStatus = undefined; }
        }
      }
      const actualIdentity = runtimeStatus?.identity ?? null;
      const privilegeState: ServicePrivilegeState | "unknown" = statusManifest === undefined
        ? "unknown"
        : servicePrivilegeState(statusManifest, runtimeStatus?.identity, runtimeStatus?.active ?? false);
      const service = {
        mode: serviceMode,
        execution_mode: configuredMode,
        configured_execution_mode: configuredMode,
        manifest: manifest?.path ?? null,
        registered: runtimeStatus?.registered ?? null,
        installed: runtimeStatus?.installed ?? null,
        active: runtimeStatus?.active ?? null,
        status: runtimeStatus === undefined ? "unknown" : runtimeStatus.active ? "active" : runtimeStatus.installed ? "inactive" : "not_installed",
        actual_service_identity: actualIdentity,
        privilege_state: privilegeState,
      };
      report(output, parsed.json, {
        configured: profile !== undefined,
        profile: redactedProfile(profile),
        runner_id: profile?.runner_id ?? null,
        display_name: null,
        version: null,
        service,
        configured_execution_mode: configuredMode,
        actual_service_identity: actualIdentity,
        privilege_state: privilegeState,
        management_mode: profileManagementMode(profile) ?? null,
        // A native service-manager state only says whether the process is
        // scheduled/running.  It does not prove that the Runner has an
        // authenticated control-plane socket, so never label an active task
        // as "online" from this local probe alone.
        connection: "unknown",
        desired_policy_revision: null,
        applied_policy_revision: null,
        workspace_count: profile?.workspaces.length ?? 0,
      });
      return;
    }
    if (parsed.command === "workspace") { await workspaceCommand(parsed, store, output); return; }
    if (parsed.command === "env") { const profile = await requireProfile(store); const info = await new EnvironmentInfoService().get(workspaceOptions(profile)); report(output, parsed.json, info); return; }
    if (parsed.command === "doctor") {
      const result = await doctor(store, parsed.values.user === true ? "user" : "system", dependencies.servicePlatform, dependencies);
      report(output, parsed.json, parsed.values.shareable === true ? shareableDoctorReport(result) : result);
      if (!result.ok) (dependencies.setExitCode ?? ((code) => { process.exitCode = code; }))(1);
      return;
    }
    if (parsed.command === "install" || parsed.command === "migrate" || parsed.command === "stop" || parsed.command === "restart") { await serviceCommand(parsed, store, output, dependencies); return; }
    if (parsed.command === "uninstall") { await uninstall(parsed, store, output, dependencies); return; }
    throw new Error(HELP);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const outcomeUnknown = parsed.command === "enroll" && isEnrollmentOutcomeUnknown(cause);
    const profileRemoved = parsed.command === "enroll" && (enrolledDuringThisInvocation || outcomeUnknown)
      ? await removeEnrollmentProfileIfCurrent(store, enrolledProfile ?? previousProfile)
      : false;
    const message = parsed.command === "enroll"
      ? enrollmentFailureMessage(detail, enrolledDuringThisInvocation, outcomeUnknown, profileRemoved)
      : detail;
    error(message); throw cause;
  }
}

async function workspaceCommand(parsed: ParsedCommand, store: ProfileStore, output: (line: string) => void): Promise<void> {
  const action = typeof parsed.values.action === "string" ? parsed.values.action : "list";
  const profile = await requireProfile(store);
  if (action === "list") { report(output, parsed.json, { management_mode: profileManagementMode(profile), workspaces: profile.workspaces.map((workspace) => ({ ...workspace })) }); return; }
  throw new Error("Workspace configuration is centrally managed through the Runmesh Admin Panel; only `workspace list` is available locally.");
}

export type { CliDependencies } from "./cli/contracts.js";
export type { EnrollCliDependencies } from "./cli/contracts.js";
export { runEnrollCli } from "./cli/enrollment.js";
export type { DoctorCheck } from "./cli/contracts.js";
export type { DoctorReport } from "./cli/contracts.js";
export type { ShareableDoctorReport } from "./cli/contracts.js";
export { shareableDoctorReport } from "./cli/doctor.js";
export { doctor } from "./cli/doctor.js";
export { parseProductArgs } from "./cli/input.js";
