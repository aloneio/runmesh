#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { access, lstat, realpath, rm } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parseRunnerArgs, validateRunnerConfig, type RawRunnerOptions } from "./config.js";
import { RunnerConnection } from "./connection.js";
import { enrollRunner, isEnrollmentOutcomeUnknown } from "./enrollment.js";
import { ProfileStore, defaultWorkspaceId, profileExecutionMode, profileManagementMode, redactedProfile, workspaceOptions, type RunnerProfile, type StoredWorkspace } from "./profile.js";
import { EnvironmentInfoService, discoverShellRuntime, type ShellRuntime } from "./runtime.js";
import { RUNNER_VERSION } from "./version.js";
import { assertManagedServiceManifest, createServiceManager, createServiceProvisioner, currentServicePlatform, expectedServiceIdentity, hostServiceManifestFilesystem, installServiceManifest, isManagedService, managedServiceManifestFromContent, removeServiceManifest, renderService, rewriteManagedServiceExecutionMode, serviceLayout, servicePrivilegeState, serviceProfilePath, type ExecutionMode, type ServiceManagerAdapter, type ServiceManifest, type ServiceManifestFilesystem, type ServicePlatform, type ServicePrivilegeState, type ServiceProvisioner } from "./service.js";
import { resolveTrustedWindowsTool, trustedWindowsEnvironment, trustedWindowsRoot } from "./windows-tools.js";

export interface CliDependencies {
  readonly store?: ProfileStore;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  readonly fetch?: typeof globalThis.fetch;
  readonly startRunner?: (config: Awaited<ReturnType<typeof validateRunnerConfig>>) => Promise<void>;
  /** Injectable host adapter; production uses the platform service manager. */
  readonly serviceManager?: ServiceManagerAdapter;
  /** Injectable service-account and Runmesh-owned directory/ACL setup. */
  readonly serviceProvisioner?: ServiceProvisioner;
  /** Injectable manifest I/O keeps service tests off the host filesystem. */
  readonly serviceFilesystem?: ServiceManifestFilesystem;
  readonly servicePlatform?: ServicePlatform;
  /** Test hook for elevated system installation checks. */
  readonly isAdministrator?: () => boolean;
  /** Injectable local discovery keeps doctor diagnostics deterministic in tests. */
  readonly environment?: EnvironmentInfoService;
  readonly discoverShellRuntime?: () => Promise<ShellRuntime | undefined>;
  readonly executionMode?: ExecutionMode;
  readonly confirmPrivilegedHost?: boolean;
  /** Optional local policy revision source; normal profiles do not persist central policy state. */
  readonly policyRevision?: () => Promise<{ readonly desired?: number; readonly applied?: number } | undefined>;
  /** Injectable exit-code seam for doctor failures; production sets process.exitCode. */
  readonly setExitCode?: (code: number) => void;
  /** Injectable stdin source for the secret-safe `enroll --code-stdin` flow. */
  readonly readStdin?: () => Promise<string>;
  /** Optional post-enrollment activation hook (also used by integration tests). */
  readonly afterEnroll?: () => Promise<void>;
}
export interface EnrollCliDependencies {
  readonly store?: ProfileStore;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  readonly fetch?: typeof globalThis.fetch;
  readonly servicePlatform?: ServicePlatform;
  readonly executionMode?: ExecutionMode;
  readonly confirmPrivilegedHost?: boolean;
  /** Injectable stdin source for the secret-safe `enroll --code-stdin` flow. */
  readonly readStdin?: () => Promise<string>;
  /** Optional post-enrollment activation hook. */
  readonly afterEnroll?: () => Promise<void>;
}
interface ParsedCommand { readonly command: string; readonly json: boolean; readonly values: Record<string, string | boolean | string[]>; readonly passthrough: string[]; }
const HELP = "usage: runmesh-runner <start|enroll|status|doctor|workspace|env|install|migrate|stop|restart|uninstall> [options]\nenroll: --server <https-url> (--code <one-time-code> | --code-stdin)\nservice migration: migrate --execution-mode <dedicated_user|privileged_host> [--confirm-privileged-host]\nworkspace: list | add --path <directory> [--allow-edit] [--allow-host-shell --i-understand-host-shell-is-not-sandboxed] | remove --id <workspace-id> | migrate --management-mode <central|legacy_manual>";

/**
 * Read a one-time enrollment code without placing it in argv, a URL, or the
 * shell command history. The first line is sufficient; EOF is also accepted
 * for pipe-based installers. A caller can inject the source for tests and for
 * hosts that provide a secret-input prompt of their own.
 */
async function enrollmentCode(parsed: ParsedCommand, readStdin?: () => Promise<string>): Promise<string> {
  const fromArgument = typeof parsed.values.code === "string" ? parsed.values.code : undefined;
  if (parsed.values.codeStdin === true && fromArgument !== undefined) throw new Error("--code and --code-stdin cannot be used together");
  if (parsed.values.codeStdin !== true) return requiredString(parsed, "code");
  const source = readStdin ?? readEnrollmentStdin;
  const code = (await source()).trim();
  if (code.length === 0) throw new Error("--code-stdin requires a one-time enrollment code");
  return code;
}

function readEnrollmentStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("error", onError);
      process.stdin.removeListener("end", onEnd);
      if (error === undefined) resolve(value); else reject(error);
    };
    // Enrollment is entered one line at a time in the manual flow. Resolving
    // on the first newline keeps `--code-stdin` usable from a TTY (Enter is a
    // natural completion signal) while still accepting a normal pipe, whose
    // EOF path remains supported for hosted installers.
    const onData = (chunk: string | Buffer): void => {
      value += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (value.length > 512) { finish(new Error("--code-stdin input is too long")); return; }
      const lineEnd = value.search(/[\r\n]/u);
      if (lineEnd >= 0) { value = value.slice(0, lineEnd); finish(); }
    };
    const onError = (): void => finish(new Error("--code-stdin input could not be read"));
    const onEnd = (): void => finish();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.once("error", onError);
    process.stdin.once("end", onEnd);
    process.stdin.resume();
  });
}

/**
 * Remove a profile only when it is still the profile observed by this
 * enrollment attempt.  A second CLI process may have completed a newer
 * enrollment while the first process was handling an uncertain response;
 * unconditional rm() would otherwise delete that valid credential.
 *
 * This is deliberately a best-effort compare-before-remove.  ProfileStore has
 * no portable atomic compare-and-delete primitive, so callers should still
 * serialize enrollment operations when strict cross-process exclusion is
 * required.  The identity check closes the common late-cleanup race without
 * changing ProfileStore's on-disk format.
 */
async function removeEnrollmentProfileIfCurrent(store: ProfileStore, expected: RunnerProfile | undefined): Promise<boolean> {
  // An absent pre-enrollment snapshot is not an ownership proof.  There is no
  // portable compare-and-delete primitive here, so loading `undefined` and
  // then removing can race a concurrent enrollment that creates a profile
  // between those two operations.  Leave the profile untouched unless this
  // invocation can name the exact validated snapshot it wrote.
  if (expected === undefined) return false;
  try {
    const current = await store.load();
    if (!sameEnrollmentProfile(current, expected)) return false;
    await store.remove();
    return true;
  } catch {
    return false;
  }
}

function sameEnrollmentProfile(left: RunnerProfile | undefined, right: RunnerProfile): boolean {
  // Compare the complete validated snapshot, not merely credential identity:
  // a concurrent workspace-policy update must not be discarded by cleanup.
  // ProfileStore normalizes object-key order while `enrollRunner` constructs
  // its result in a different order, so a raw JSON.stringify comparison would
  // incorrectly skip cleanup after a post-enrollment failure.
  return left !== undefined
    && left.version === right.version
    && left.server_url === right.server_url
    && left.runner_id === right.runner_id
    && left.token === right.token
    && left.insecure_local === right.insecure_local
    && left.management_mode === right.management_mode
    && left.execution_mode === right.execution_mode
    && left.max_concurrent_jobs === right.max_concurrent_jobs
    && left.workspaces.length === right.workspaces.length
    && left.workspaces.every((workspace, index) => {
      const other = right.workspaces[index];
      return other !== undefined
        && workspace.id === other.id
        && workspace.path === other.path
        && workspace.writable === other.writable
        && workspace.shell === other.shell;
    });
}

function enrollmentFailureMessage(detail: string, credentialsConsumed: boolean, outcomeUnknown: boolean, profileRemoved: boolean): string {
  if (!credentialsConsumed && !outcomeUnknown) return detail;
  const cleanup = profileRemoved
    ? "the local profile was removed"
    : "the local profile could not be removed; do not use the existing profile until its credential is verified";
  if (credentialsConsumed) return `${detail}; enrollment credentials were consumed and ${cleanup}; generate a new enrollment code and retry`;
  return `${detail}; ${cleanup} because the enrollment outcome is unknown; generate a new enrollment code and retry`;
}

export async function runEnrollCli(argv: readonly string[], dependencies: EnrollCliDependencies = {}): Promise<void> {
  const output = dependencies.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const error = dependencies.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const parsed = parseProductArgs(["enroll", ...argv]);
  const store = dependencies.store ?? storeFor(parsed, dependencies.servicePlatform);
  let previousProfile: RunnerProfile | undefined;
  let enrolled = false;
  let enrolledProfile: RunnerProfile | undefined;
  try {
    const server = requiredString(parsed, "server");
    const code = await enrollmentCode(parsed, dependencies.readStdin);
    previousProfile = await store.load();
    const result = await enrollRunner({
      server, code, reEnroll: parsed.values.reEnroll === true, insecureLocal: parsed.values.insecureLocal === true,
      ...(typeof parsed.values.executionMode === "string" ? { executionMode: parsed.values.executionMode as ExecutionMode } : dependencies.executionMode === undefined ? {} : { executionMode: dependencies.executionMode }),
      ...(parsed.values.confirmPrivilegedHost === true || dependencies.confirmPrivilegedHost === true ? { confirmPrivilegedHost: true } : {}),
      ...(typeof parsed.values.cwd === "string" ? { cwd: parsed.values.cwd } : {}),
      ...(dependencies.store === undefined ? { store } : { store: dependencies.store }),
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    });
    enrolled = true;
    enrolledProfile = result.profile;
    if (dependencies.afterEnroll !== undefined) await dependencies.afterEnroll();
    report(output, parsed.json, { enrolled: true, runner_id: result.profile.runner_id, workspace_count: result.profile.workspaces.length });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const outcomeUnknown = isEnrollmentOutcomeUnknown(cause);
    const profileRemoved = enrolled || outcomeUnknown
      ? await removeEnrollmentProfileIfCurrent(store, enrolledProfile ?? previousProfile)
      : false;
    error(enrollmentFailureMessage(detail, enrolled, outcomeUnknown, profileRemoved));
    throw cause;
  }
}

export async function runCli(argv: readonly string[], dependencies: CliDependencies = {}): Promise<void> {
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
    if (parsed.command === "start") return start(parsed, store, error, dependencies);
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
      const configuredMode = profile === undefined ? "migration_required" as const : serviceMode === "user" ? "dedicated_user" as const : profileExecutionMode(profile) ?? "migration_required" as const;
      let manifest: ServiceManifest | undefined;
      let statusManifest: ServiceManifest | undefined;
      let runtimeStatus: Awaited<ReturnType<NonNullable<ServiceManagerAdapter["status"]>>> | undefined;
      if (profile !== undefined && configuredMode !== "migration_required") {
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
        management_mode: profileManagementMode(profile) ?? "migration_required",
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
      report(output, parsed.json, result);
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

async function start(parsed: ParsedCommand, store: ProfileStore, error: (line: string) => void, dependencies: CliDependencies): Promise<void> {
  const raw = parseRunnerArgs(parsed.passthrough);
  const profilePath = typeof parsed.values.profilePath === "string" ? parsed.values.profilePath : undefined;
  const profileStore = profilePath === undefined
    ? store
    : new ProfileStore({ filePath: profilePath, ...(dependencies.servicePlatform === undefined ? {} : { platform: dependencies.servicePlatform }) });
  const profile = await profileStore.load();
  // A system Runner must not consume a canonical profile owned by an
  // untrusted account/group.  This is checked after parsing execution_mode so
  // dedicated_user and privileged_host receive their distinct root:group
  // contracts; user-level foreground starts intentionally skip it.
  if (parsed.values.user !== true && profile !== undefined
    && (profile.execution_mode === "dedicated_user" || profile.execution_mode === "privileged_host")) {
    // A managed system manifest may use a custom dedicated group.  Carry the
    // identity from that manifest into the profile ownership check instead of
    // assuming the built-in `runmesh` group.
    const serviceGroup = await serviceGroupForManagedProfile(profileStore, dependencies.servicePlatform, dependencies.serviceFilesystem);
    await profileStore.assertServiceOwnership(profile.execution_mode, serviceGroup);
  }
  const hasLegacyExplicit = raw.server !== undefined || raw.runnerId !== undefined || raw.token !== undefined || (raw.workspaces?.length ?? 0) > 0;
  const productWorkspaces = profile === undefined || profileManagementMode(profile) === "central" ? [] : workspaceOptions(profile);
  const server = raw.server ?? profile?.server_url;
  const token = raw.token ?? process.env.RUNMESH_RUNNER_TOKEN ?? process.env.CODING_RUNNER_TOKEN ?? profile?.token;
  const runnerId = raw.runnerId ?? profile?.runner_id;
  const maxConcurrentJobs = raw.maxConcurrentJobs ?? profile?.max_concurrent_jobs;
  const options: RawRunnerOptions = {
    ...(server === undefined ? {} : { server }),
    ...(token === undefined ? {} : { token }),
    ...(runnerId === undefined ? {} : { runnerId }),
    ...(raw.insecureLocal === true || profile?.insecure_local === true ? { insecureLocal: true } : {}),
    ...(maxConcurrentJobs === undefined ? {} : { maxConcurrentJobs }),
    ...(raw.stateDir === undefined ? {} : { stateDir: raw.stateDir }),
    // Test controls are retained only in the foreground compatible start path, never stored.
    ...(raw.disconnectAfterMs === undefined ? {} : { disconnectAfterMs: raw.disconnectAfterMs }),
    ...(raw.disconnectControlFile === undefined ? {} : { disconnectControlFile: raw.disconnectControlFile }),
    workspaces: raw.workspaces?.length ? raw.workspaces : (hasLegacyExplicit ? [] : productWorkspaces),
  };
  const config = await validateRunnerConfig(options);
  if (dependencies.startRunner !== undefined) return dependencies.startRunner(config);
  // A user-level foreground service is never allowed to inherit a
  // privileged_host claim from a copied or manually edited system profile.
  // The process is running under the interactive account, so report the
  // effective user-service contract as dedicated_user and let OS validation
  // fail closed for any host-wide workspace it cannot actually access.
  const executionMode = parsed.values.user === true ? "dedicated_user" as const : profileExecutionMode(profile);
  const runner = new RunnerConnection({
    config,
    onStateChange: (state) => error(`runner ${config.runnerId}: ${state}`),
    ...(executionMode === "dedicated_user" || executionMode === "privileged_host" ? { executionMode } : {}),
  });
  if (config.disconnectControlFile !== undefined) installDisconnectControl(runner, config.disconnectControlFile);
  const stop = (): void => runner.stop();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  // Local E2E transport control; it has no persisted profile representation.
  process.on("SIGUSR1", () => runner.disconnectForTest());
  await runner.start();
}
async function workspaceCommand(parsed: ParsedCommand, store: ProfileStore, output: (line: string) => void): Promise<void> {
  const action = typeof parsed.values.action === "string" ? parsed.values.action : "list";
  const profile = await requireProfile(store);
  const managementMode = profileManagementMode(profile);
  if (action === "list") { report(output, parsed.json, { management_mode: managementMode, workspaces: profile.workspaces.map((workspace) => ({ ...workspace })) }); return; }
  if (action === "migrate") {
    const mode = parsed.values.managementMode;
    if (managementMode !== "migration_required") throw new Error("workspace management mode is already configured");
    if (mode !== "central" && mode !== "legacy_manual") throw new Error("--management-mode must be central or legacy_manual");
    await store.save({ ...profile, management_mode: mode });
    report(output, parsed.json, { management_mode: mode, migrated: true });
    return;
  }
  if (managementMode === "central") throw new Error("Configure managed Workspaces through the Runmesh Admin Panel.");
  if (managementMode !== "legacy_manual") throw new Error("Runner profile management_mode is migration_required; run runmesh-runner workspace migrate --management-mode central or legacy_manual first.");
  if (action === "add") {
    const path = await canonicalDirectory(requiredString(parsed, "path"));
    const id = typeof parsed.values.id === "string" ? validateWorkspaceId(parsed.values.id) : defaultWorkspaceId(path, profile.workspaces);
    if (profile.workspaces.some((workspace) => workspace.id === id || workspace.path === path)) throw new Error("workspace already exists");
    const allowEdit = parsed.values.allowEdit === true;
    const allowHostShell = parsed.values.allowHostShell === true;
    const understoodHostShell = parsed.values.understoodHostShell === true;
    if (allowHostShell !== understoodHostShell) throw new Error("--allow-host-shell requires --i-understand-host-shell-is-not-sandboxed");
    if (allowHostShell && !allowEdit) throw new Error("--allow-host-shell also requires --allow-edit");
    if (allowEdit && parsed.values.readonly === true) throw new Error("--allow-edit conflicts with --readonly");
    if (allowHostShell && parsed.values.noShell === true) throw new Error("--allow-host-shell conflicts with --no-shell");
    const workspace: StoredWorkspace = { id, path, writable: allowEdit, shell: allowHostShell };
    await store.save({ ...profile, workspaces: [...profile.workspaces, workspace] }); report(output, parsed.json, { added: id, writable: workspace.writable, shell: workspace.shell }); return;
  }
  if (action === "remove") {
    const id = requiredString(parsed, "id"); const workspaces = profile.workspaces.filter((workspace) => workspace.id !== id);
    if (workspaces.length === profile.workspaces.length) throw new Error("workspace not found");
    await store.save({ ...profile, workspaces }); report(output, parsed.json, { removed: id }); return;
  }
  throw new Error("usage: runmesh-runner workspace <list|add|remove|migrate>");
}
export interface DoctorCheck {
  readonly name: string;
  readonly required: boolean;
  readonly ok: boolean;
  readonly status: "ok" | "warning" | "failure";
  readonly detail?: string;
}
export interface DoctorReport {
  readonly ok: boolean;
  readonly checks: readonly DoctorCheck[];
  readonly profile: Record<string, unknown> | undefined;
  readonly service: {
    readonly manifest: string;
    readonly mode: "system" | "user";
    readonly execution_mode: ExecutionMode | "migration_required";
    readonly configured_execution_mode: ExecutionMode | "migration_required";
    readonly actual_service_identity: string | null;
    readonly privilege_state: ServicePrivilegeState;
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
  const executionMode: ExecutionMode | "migration_required" = mode === "user" ? "dedicated_user" : storedMode ?? "migration_required";
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

  const manifest = renderService({ ...(platform === undefined ? {} : { platform }), mode, profilePath: store.filePath, ...(executionMode === "migration_required" ? {} : { executionMode }) });
  add("execution_mode", enrolled, executionMode !== "migration_required", !enrolled ? "not enrolled" : executionMode === "migration_required" ? "legacy profile has no execution_mode; choose --execution-mode dedicated_user or privileged_host before installation" : executionMode);
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
  add("profile_ownership", ownershipRequired, !ownershipRequired || ownershipCheck?.ok === true, !enrolled ? "not enrolled" : ownershipError ?? ownershipCheck?.detail ?? (ownershipRequired ? "canonical ownership could not be verified" : "non-system profile"));
  const manager = dependencies.serviceManager ?? createServiceManager({ platform: manifest.platform, mode: manifest.mode });
  let actualServiceIdentity: string | null = null;
  let privilegeState: ServicePrivilegeState = "unknown";
  const expectedIdentity = executionMode === "migration_required" ? undefined : expectedServiceIdentity(serviceProbeManifest);
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
      execution_mode: executionMode,
      configured_execution_mode: executionMode,
      actual_service_identity: actualServiceIdentity,
      privilege_state: privilegeState,
    },
  };
}
async function serviceCommand(parsed: ParsedCommand, store: ProfileStore, output: (line: string) => void, dependencies: CliDependencies): Promise<void> {
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
  else await manager.restart(manifest);
  report(output, parsed.json, { action: parsed.command, manifest: manifest.path, mode: manifest.mode, commands: serviceCommandNames(parsed.command as "install" | "stop" | "restart", manifest) });
}
async function uninstall(parsed: ParsedCommand, store: ProfileStore, output: (line: string) => void, dependencies: CliDependencies): Promise<void> {
  if (parsed.values.purge === true && parsed.values.yes !== true) throw new Error("--purge requires --yes");
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
  // Job state and workspace roots deliberately remain untouched, including with --purge.
  report(output, parsed.json, { action: "uninstall", service_removed: removed, profile_removed: parsed.values.purge === true, mode: manifest.mode, commands: serviceCommandNames("uninstall", manifest) });
}

type ProbedServiceStatus = Awaited<ReturnType<NonNullable<ServiceManagerAdapter["status"]>>>;
/**
 * Destructive/lifecycle commands must not act on an unknown native service.
 * Production managers mark ambiguous native-query failures as unreliable;
 * injected legacy managers that omit the optional flag remain compatible.
 */
async function probeServiceStatus(manager: ServiceManagerAdapter, manifest: ServiceManifest, action: string): Promise<ProbedServiceStatus | undefined> {
  if (manager.status === undefined) return undefined;
  let status: ProbedServiceStatus;
  try {
    status = await manager.status(manifest);
  } catch {
    throw new Error(`service status probe is unavailable; refusing to ${action} the Runner service`);
  }
  if (status.reliable === false) throw new Error(`service status probe is unavailable or unreliable; refusing to ${action} the Runner service`);
  if (status.active && servicePrivilegeState(manifest, status.identity, status.active) === "mismatch") {
    throw new Error(`active Runner service identity does not match the managed execution mode; refusing to ${action} the service`);
  }
  return status;
}

/** Restore only the exact manifest snapshot this transaction wrote. */
async function restoreManifestSnapshot(filesystem: ServiceManifestFilesystem, manifest: ServiceManifest, previousContent: string | undefined, hadManagedManifest: boolean): Promise<void> {
  let current: string | undefined;
  try { current = await filesystem.read(manifest.path); } catch { return; }
  // A concurrent operator or package update owns the path once its bytes no
  // longer equal our candidate. Never overwrite or remove that newer state.
  if (current !== manifest.content) return;
  if (hadManagedManifest && previousContent !== undefined) await filesystem.write(manifest.path, previousContent).catch(() => undefined);
  else await filesystem.remove(manifest.path).catch(() => undefined);
}

export function parseProductArgs(argv: readonly string[]): ParsedCommand {
  const command = argv[0] ?? ""; const values: Record<string, string | boolean | string[]> = {}; const passthrough: string[] = [];
  if (command === "start") {
    const rest = argv.slice(1);
    for (let index = 0; index < rest.length; index += 1) {
      const arg = rest[index];
      if (arg === undefined) continue;
      if (arg === "--json") { values.json = true; continue; }
      if (arg === "--profile") {
        const value = rest[index + 1];
        if (value === undefined || value.startsWith("--")) throw new Error("unknown or incomplete option: --profile");
        values.profilePath = value as string; index += 1; continue;
      }
      passthrough.push(arg);
    }
    return { command, json: values.json === true, values, passthrough };
  }
  const rest = [...argv.slice(1)];
  if (command === "workspace" && ["list", "add", "remove", "migrate"].includes(rest[0] ?? "")) values.action = rest.shift() as string;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") { values.json = true; continue; }
    if (arg === "--readonly") { values.readonly = true; continue; }
    if (arg === "--no-shell") { values.noShell = true; continue; }
    if (arg === "--allow-edit") { values.allowEdit = true; continue; }
    if (arg === "--allow-host-shell") { values.allowHostShell = true; continue; }
    if (arg === "--i-understand-host-shell-is-not-sandboxed") { values.understoodHostShell = true; continue; }
    if (arg === "--purge") { values.purge = true; continue; }
    if (arg === "--yes") { values.yes = true; continue; }
    if (arg === "--insecure-local") { values.insecureLocal = true; continue; }
    if (arg === "--re-enroll") { values.reEnroll = true; continue; }
    if (arg === "--user") { values.user = true; continue; }
    if (arg === "--confirm-privileged-host") { values.confirmPrivilegedHost = true; continue; }
    if (arg === "--code-stdin") { values.codeStdin = true; continue; }
    const key = arg === "--execution-mode" ? "executionMode" : arg === "--management-mode" ? "managementMode" : arg === "--server" ? "server" : arg === "--code" ? "code" : arg === "--cwd" ? "cwd" : arg === "--id" ? "id" : arg === "--path" ? "path" : arg === "--executable-path" ? "executablePath" : arg === "--profile" ? "profilePath" : undefined;
    const value = rest[index + 1]; if (key === undefined || value === undefined || value.startsWith("--")) throw new Error(`unknown or incomplete option: ${arg}`);
    values[key] = value; index += 1;
  }
  return { command, json: values.json === true, values, passthrough };
}
function storeFor(parsed: ParsedCommand, platform?: ServicePlatform): ProfileStore {
  if (typeof parsed.values.profilePath === "string") return new ProfileStore({ filePath: parsed.values.profilePath, ...(platform === undefined ? {} : { platform }) });
  if (parsed.values.user === true || process.env.RUNMESH_RUNNER_PROFILE !== undefined || process.env.CODING_RUNNER_PROFILE !== undefined) return new ProfileStore(platform === undefined ? {} : { platform });
  const layout = serviceLayout({ ...(platform === undefined ? {} : { platform }), mode: "system" });
  return new ProfileStore({ filePath: serviceProfilePath(layout), ...(platform === undefined ? {} : { platform }) });
}
async function serviceManifestFor(parsed: ParsedCommand, store: ProfileStore, platform?: ServicePlatform, filesystem: ServiceManifestFilesystem | undefined = undefined): Promise<ServiceManifest> {
  const profile = await store.load();
  const requestedMode = parsed.values.executionMode;
  if (requestedMode !== undefined && requestedMode !== "dedicated_user" && requestedMode !== "privileged_host") throw new Error("--execution-mode must be dedicated_user or privileged_host");
  if (parsed.values.user === true && requestedMode === "privileged_host") throw new Error("user Runner services cannot use privileged_host; choose --execution-mode dedicated_user");
  const profileMode = profileExecutionMode(profile);
  const profileExecutionModeValue: ExecutionMode | undefined = profileMode === "migration_required" ? undefined : profileMode;
  // Installing or migrating a legacy profile requires an explicit choice, so
  // an upgrade can never silently turn an existing service into root/SYSTEM.
  // Lifecycle commands that merely stop/restart/uninstall may safely use the
  // restricted manifest as a compatibility bridge for an already-installed
  // legacy service; this does not grant any new privilege.
  const needsExplicitMode = parsed.command === "install" || parsed.command === "migrate";
  if (parsed.values.user !== true && needsExplicitMode && profileMode === "migration_required" && requestedMode === undefined) throw new Error("legacy Runner profile requires --execution-mode dedicated_user or --execution-mode privileged_host before system installation");
  let executionMode: ExecutionMode = parsed.values.user === true ? "dedicated_user" : requestedMode ?? profileExecutionModeValue ?? "dedicated_user";
  if (parsed.values.user !== true && requestedMode === undefined && profileMode === "migration_required" && !needsExplicitMode) {
    // A legacy profile may have an already-installed managed privileged unit.
    // Infer the existing mode only to target stop/restart/uninstall; this path
    // never provisions, persists, or authorizes a new privileged service.
    const layout = serviceLayout({ ...(platform === undefined ? {} : { platform }), mode: "system" });
    const existing = await (filesystem ?? hostServiceManifestFilesystem).read(layout.manifestPath);
    if (existing !== undefined && isManagedService(existing)) executionMode = inferExecutionModeFromManifest(platform ?? currentServicePlatform(), existing);
  }
  const requestedServiceMode = parsed.values.user === true ? "user" : "system";
  const renderOptions = {
    ...(platform === undefined ? {} : { platform }),
    mode: requestedServiceMode as "system" | "user",
    profilePath: store.filePath,
    executionMode,
    ...(typeof parsed.values.executablePath === "string" ? { executablePath: parsed.values.executablePath } : {}),
  };
  let manifest = renderService(renderOptions);
  const serviceFilesystem = filesystem ?? hostServiceManifestFilesystem;
  // Read the existing managed definition before rendering a replacement.  A
  // migration must retain operator-selected executable paths, arguments, and
  // service-manager settings; only the OS identity is allowed to change when
  // no explicit executable override was requested.
  const existing = await serviceFilesystem.read(manifest.path);
  if (existing === undefined || !isManagedService(existing)) return manifest;

  const existingMode = requestedServiceMode === "system"
    ? inferExecutionModeFromManifest(manifest.platform, existing)
    : "dedicated_user";
  if (requestedServiceMode === "system" && !needsExplicitMode && requestedMode === undefined
    && (parsed.command === "stop" || parsed.command === "restart" || parsed.command === "uninstall")) {
    // Lifecycle commands without an explicit mode should always address the
    // identity represented by the installed definition, even if a legacy
    // profile is stale or omits execution_mode.
    executionMode = existingMode;
    manifest = renderService({ ...renderOptions, executionMode });
  }

  if (parsed.values.executablePath === undefined) {
    const desired = renderService({ ...renderOptions, executionMode });
    if (desired.mode === "system" && desired.executionMode !== existingMode) {
      // Rewrite only User/Group, UserName, or the Windows principal.  The
      // existing command and all other service settings remain untouched.
      return rewriteManagedServiceExecutionMode(desired, existing, desired.executionMode);
    }
    return managedServiceManifestFromContent(desired, existing, desired.executionMode);
  }

  // An explicit executable path is an intentional service-definition update,
  // but a custom dedicated account remains an operator-owned setting.  Carry
  // that account through the re-render so changing the binary cannot silently
  // switch the service identity back to the default `runmesh` account.
  if (desiredServiceNeedsDedicatedIdentity(manifest)) {
    const identity = existingDedicatedIdentityOptions(manifest.platform, existing);
    manifest = renderService({ ...renderOptions, executionMode, ...identity });
  }
  return manifest;
}
function assertSystemInstallationPrivilege(manifest: ServiceManifest, dependencies: CliDependencies): void {
  if (manifest.mode !== "system") return;
  const elevated = dependencies.isAdministrator ?? (() => {
    if (manifest.platform !== "win32") return process.getuid?.() === 0;
    // `net session` returns success only from an elevated Windows token.
    // Use the absolute inbox utility path.  Windows CreateProcess searches
    // the current directory before PATH even when PATH has been scrubbed;
    // resolving a bare `net.exe` here would let a same-directory binary run
    // in the administrator's context during install/uninstall.
    const systemRoot = trustedWindowsRoot();
    const executable = process.platform === "win32" ? resolveTrustedWindowsTool("net.exe", systemRoot) : "net";
    return spawnSync(executable, ["session"], {
      stdio: "ignore",
      windowsHide: true,
      ...(process.platform === "win32" ? { cwd: `${systemRoot}\\System32`, env: trustedWindowsEnvironment(systemRoot) } : {}),
    }).status === 0;
  });
  if (!elevated()) throw new Error("system Runner installation requires administrator/root privileges; rerun from an elevated administrator/root shell");
}
function serviceCommandNames(action: "install" | "stop" | "restart" | "uninstall", manifest: ServiceManifest): readonly string[] {
  if (manifest.platform === "linux") {
    const prefix = manifest.mode === "user" ? "systemctl --user" : "systemctl";
    if (action === "install") return [`${prefix} daemon-reload`, `${prefix} enable --now runmesh-runner.service`, `${prefix} is-active --quiet runmesh-runner.service`];
    return [`${prefix} ${action === "uninstall" ? "disable --now" : action} runmesh-runner.service`];
  }
  return [];
}
function report(output: (line: string) => void, json: boolean, value: unknown): void { output(json ? JSON.stringify(value) : human(value)); }
function human(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value, null, 2); }
function requiredString(parsed: ParsedCommand, name: string): string { const value = parsed.values[name]; if (typeof value !== "string" || value.length === 0) throw new Error(`--${name} is required`); return value; }
function validateWorkspaceId(value: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error("--id must be a safe identifier"); return value; }
async function canonicalDirectory(path: string): Promise<string> { const absolute = isAbsolute(path) ? path : resolve(path); const actual = await realpath(absolute).catch(() => { throw new Error(`workspace path does not exist: ${path}`); }); if (!(await lstat(actual)).isDirectory()) throw new Error(`workspace path is not a directory: ${path}`); return actual; }
async function requireProfile(store: ProfileStore): Promise<RunnerProfile> { const profile = await store.load(); if (profile === undefined) throw new Error("runner is not enrolled"); return profile; }
async function isDirectory(path: string): Promise<boolean> { return lstat(path).then((value) => value.isDirectory()).catch(() => false); }
function urlCheck(value: string, insecureLocal = false): { ok: boolean; detail?: string } {
  try {
    const url = new URL(value);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    const safe = url.username === "" && url.password === "" && url.search === "" && url.hash === "";
    return safe && (url.protocol === "wss:" || (url.protocol === "ws:" && loopback && insecureLocal)) ? { ok: true } : { ok: false, detail: "wss:// is required and URL credentials/query/fragment are not allowed" };
  } catch { return { ok: false, detail: "invalid URL" }; }
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512); }
function formatMode(mode: number | undefined): string { return mode === undefined ? "missing" : `0${mode.toString(8)}`; }
/** Infer only the previously-installed mode when a legacy profile omitted it.
 * The manifest is accepted only after `isManagedService`, so this heuristic
 * is used solely to reload the exact managed definition during rollback; it
 * is never used to authorize a new installation or silently elevate one.
 */
function inferExecutionModeFromManifest(platform: ServicePlatform, content: string): ExecutionMode {
  if (platform === "linux") {
    // A managed unit may have been rendered with an operator-supplied service
    // account.  Match the presence of a non-empty User= directive rather than
    // one literal account name; an otherwise valid dedicated unit must never
    // be mistaken for root during stop/restart/uninstall or migration
    // rollback.
    return /^\s*User\s*=\s*\S.*$/mu.test(content) ? "dedicated_user" : "privileged_host";
  }
  if (platform === "darwin") return content.includes("<key>UserName</key>") ? "dedicated_user" : "privileged_host";
  return /<UserId>\s*(?:SYSTEM|NT AUTHORITY\\SYSTEM)\s*<\/UserId>/iu.test(content) ? "privileged_host" : "dedicated_user";
}
function desiredServiceNeedsDedicatedIdentity(manifest: Pick<ServiceManifest, "mode" | "executionMode">): boolean {
  return manifest.mode === "system" && manifest.executionMode === "dedicated_user";
}
function existingDedicatedIdentityOptions(platform: ServicePlatform, content: string): { readonly serviceUser?: string; readonly serviceGroup?: string } {
  const safe = (value: string | undefined): value is string => value !== undefined && /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u.test(value);
  if (platform === "linux") {
    const user = /^\s*User\s*=\s*(\S+)\s*$/mu.exec(content)?.[1];
    const group = /^\s*Group\s*=\s*(\S+)\s*$/mu.exec(content)?.[1];
    return {
      ...(safe(user) ? { serviceUser: user } : {}),
      ...(safe(group) ? { serviceGroup: group } : {}),
    };
  }
  if (platform === "darwin") {
    const user = /<key>UserName<\/key><string>([^<]*)<\/string>/u.exec(content)?.[1];
    return safe(user) ? { serviceUser: user } : {};
  }
  return {};
}
/** Read the managed system definition used by a service-launched `start` and
 * return its dedicated group, if one was explicitly configured.  The profile
 * format intentionally does not duplicate service-account metadata; the
 * signed/hashed native manifest is the source of truth for this local check.
 */
async function serviceGroupForManagedProfile(store: ProfileStore, platform: ServicePlatform | undefined, filesystem: ServiceManifestFilesystem | undefined): Promise<string | undefined> {
  const targetPlatform = platform ?? currentServicePlatform();
  const layout = serviceLayout({ platform: targetPlatform, mode: "system" });
  let content: string | undefined;
  try { content = await (filesystem ?? hostServiceManifestFilesystem).read(layout.manifestPath); }
  catch { return undefined; }
  if (content === undefined || !isManagedService(content)) return undefined;
  try {
    const base = renderService({ platform: targetPlatform, mode: "system", executionMode: "dedicated_user", profilePath: store.filePath });
    return managedServiceManifestFromContent(base, content, "dedicated_user").serviceGroup;
  } catch { return undefined; }
}
function installDisconnectControl(runner: RunnerConnection, file: string): void { let busy = false; const interval = setInterval(async () => { if (busy) return; busy = true; try { await access(file); await rm(file, { force: true }); runner.disconnectForTest(); } catch { /* absent */ } finally { busy = false; } }, 50); interval.unref(); }
