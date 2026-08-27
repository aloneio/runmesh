#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { access, lstat, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parseRunnerArgs, validateRunnerConfig, type RawRunnerOptions } from "./config.js";
import { RunnerConnection } from "./connection.js";
import { enrollRunner } from "./enrollment.js";
import { ProfileStore, defaultWorkspaceId, profileExecutionMode, redactedProfile, workspaceOptions, type RunnerProfile, type StoredWorkspace } from "./profile.js";
import { EnvironmentInfoService, discoverShellRuntime, type ShellRuntime } from "./runtime.js";
import { RUNNER_VERSION } from "./version.js";
import { assertManagedServiceManifest, createServiceManager, createServiceProvisioner, hostServiceManifestFilesystem, installServiceManifest, isManagedService, removeServiceManifest, renderService, serviceLayout, type ExecutionMode, type ServiceManagerAdapter, type ServiceManifest, type ServiceManifestFilesystem, type ServicePlatform, type ServiceProvisioner } from "./service.js";

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
  /** Optional local policy revision source; normal profiles do not persist central policy state. */
  readonly policyRevision?: () => Promise<{ readonly desired?: number; readonly applied?: number } | undefined>;
  /** Injectable exit-code seam for doctor failures; production sets process.exitCode. */
  readonly setExitCode?: (code: number) => void;
}
export interface EnrollCliDependencies {
  readonly store?: ProfileStore;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  readonly fetch?: typeof globalThis.fetch;
  readonly servicePlatform?: ServicePlatform;
  readonly executionMode?: ExecutionMode;
  readonly confirmPrivilegedHost?: boolean;
}
interface ParsedCommand { readonly command: string; readonly json: boolean; readonly values: Record<string, string | boolean | string[]>; readonly passthrough: string[]; }
const HELP = "usage: coding-runner <start|enroll|status|doctor|workspace|env|install|stop|restart|uninstall> [options]";

export async function runEnrollCli(argv: readonly string[], dependencies: EnrollCliDependencies = {}): Promise<void> {
  const output = dependencies.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const error = dependencies.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const parsed = parseProductArgs(["enroll", ...argv]);
  const store = dependencies.store ?? storeFor(parsed, dependencies.servicePlatform);
  try {
    const result = await enrollRunner({
      server: requiredString(parsed, "server"), code: requiredString(parsed, "code"), reEnroll: parsed.values.reEnroll === true, insecureLocal: parsed.values.insecureLocal === true,
      ...(typeof parsed.values.executionMode === "string" ? { executionMode: parsed.values.executionMode as ExecutionMode } : dependencies.executionMode === undefined ? {} : { executionMode: dependencies.executionMode }),
      ...(parsed.values.confirmPrivilegedHost === true || dependencies.confirmPrivilegedHost === true ? { confirmPrivilegedHost: true } : {}),
      ...(typeof parsed.values.cwd === "string" ? { cwd: parsed.values.cwd } : {}),
      ...(dependencies.store === undefined ? { store } : { store: dependencies.store }),
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    });
    report(output, parsed.json, { enrolled: true, runner_id: result.profile.runner_id, workspace_count: result.profile.workspaces.length });
  } catch (cause) { error(cause instanceof Error ? cause.message : String(cause)); throw cause; }
}

export async function runCli(argv: readonly string[], dependencies: CliDependencies = {}): Promise<void> {
  const output = dependencies.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const error = dependencies.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) { output(HELP); return; }
  if (argv.length === 1 && argv[0] === "--version") { output(RUNNER_VERSION); return; }
  const parsed = parseProductArgs(argv);
  const store = dependencies.store ?? storeFor(parsed, dependencies.servicePlatform);
  try {
    if (parsed.command === "start") return start(parsed, store, error, dependencies);
    if (parsed.command === "enroll") {
      const server = requiredString(parsed, "server"); const code = requiredString(parsed, "code");
      const result = await enrollRunner({ server, code, reEnroll: parsed.values.reEnroll === true, insecureLocal: parsed.values.insecureLocal === true, ...(typeof parsed.values.executionMode === "string" ? { executionMode: parsed.values.executionMode as ExecutionMode } : {}), ...(parsed.values.confirmPrivilegedHost === true ? { confirmPrivilegedHost: true } : {}), ...(typeof parsed.values.cwd === "string" ? { cwd: parsed.values.cwd } : {}), store, ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }) });
      report(output, parsed.json, { enrolled: true, runner_id: result.profile.runner_id, workspace_count: result.profile.workspaces.length });
      return;
    }
    if (parsed.command === "status") {
      const profile = await store.load();
      const executionMode = parsed.values.user === true ? "dedicated_user" : profileExecutionMode(profile) ?? "migration_required";
      report(output, parsed.json, { configured: profile !== undefined, profile: redactedProfile(profile), runner_id: profile?.runner_id ?? null, display_name: null, version: null, service: { mode: parsed.values.user === true ? "user" : "system", execution_mode: executionMode, status: "unknown" }, connection: "unknown", desired_policy_revision: null, applied_policy_revision: null, workspace_count: profile?.workspaces.length ?? 0 });
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
    if (parsed.command === "install" || parsed.command === "stop" || parsed.command === "restart") { await serviceCommand(parsed, store, output, dependencies); return; }
    if (parsed.command === "uninstall") { await uninstall(parsed, store, output, dependencies); return; }
    throw new Error(HELP);
  } catch (cause) { error(cause instanceof Error ? cause.message : String(cause)); throw cause; }
}

async function start(parsed: ParsedCommand, store: ProfileStore, error: (line: string) => void, dependencies: CliDependencies): Promise<void> {
  const raw = parseRunnerArgs(parsed.passthrough);
  const profile = await store.load();
  const hasLegacyExplicit = raw.server !== undefined || raw.runnerId !== undefined || raw.token !== undefined || (raw.workspaces?.length ?? 0) > 0;
  const productWorkspaces = profile === undefined ? [] : workspaceOptions(profile);
  const server = raw.server ?? profile?.server_url;
  const token = raw.token ?? process.env.CODING_RUNNER_TOKEN ?? profile?.token;
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
  const runner = new RunnerConnection({ config, onStateChange: (state) => error(`runner ${config.runnerId}: ${state}`) });
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
  if (action === "list") { report(output, parsed.json, { workspaces: profile.workspaces.map((workspace) => ({ ...workspace })) }); return; }
  if (action === "add") {
    const path = await canonicalDirectory(requiredString(parsed, "path"));
    const id = typeof parsed.values.id === "string" ? validateWorkspaceId(parsed.values.id) : defaultWorkspaceId(path, profile.workspaces);
    if (profile.workspaces.some((workspace) => workspace.id === id || workspace.path === path)) throw new Error("workspace already exists");
    const workspace: StoredWorkspace = { id, path, writable: parsed.values.readonly !== true, shell: parsed.values.noShell !== true };
    await store.save({ ...profile, workspaces: [...profile.workspaces, workspace] }); report(output, parsed.json, { added: id }); return;
  }
  if (action === "remove") {
    const id = requiredString(parsed, "id"); const workspaces = profile.workspaces.filter((workspace) => workspace.id !== id);
    if (workspaces.length === profile.workspaces.length) throw new Error("workspace not found");
    await store.save({ ...profile, workspaces }); report(output, parsed.json, { removed: id }); return;
  }
  throw new Error("usage: coding-runner workspace <list|add|remove>");
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
  readonly service: { readonly manifest: string; readonly mode: "system" | "user"; readonly execution_mode: ExecutionMode | "migration_required" };
}

export async function doctor(store: ProfileStore, mode: "system" | "user" = "system", platform: ServicePlatform | undefined = undefined, dependencies: Pick<CliDependencies, "serviceFilesystem" | "serviceManager" | "environment" | "discoverShellRuntime" | "policyRevision"> = {}): Promise<DoctorReport> {
  const profile = await store.load();
  const permissions = await store.permissions();
  const checks: DoctorCheck[] = [];
  const add = (name: string, required: boolean, ok: boolean, detail?: string): void => {
    checks.push({ name, required, ok, status: ok ? "ok" : required ? "failure" : "warning", ...(detail === undefined ? {} : { detail }) });
  };
  const enrolled = profile !== undefined;
  add("profile", true, enrolled, enrolled ? undefined : "not enrolled");
  const targetPlatform = platform ?? (process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : "win32");
  const posix = targetPlatform !== "win32";
  add("profile_directory_permissions", true, enrolled && (!posix || permissions.directory_mode === 0o700), !enrolled ? "not enrolled" : posix ? `mode ${formatMode(permissions.directory_mode)}` : "ACL permissions not inspected");
  add("profile_file_permissions", true, enrolled && (!posix || permissions.file_mode === 0o600), !enrolled ? "not enrolled" : posix ? `mode ${formatMode(permissions.file_mode)}` : "ACL permissions not inspected");
  if (profile !== undefined) {
    const url = urlCheck(profile.server_url, profile.insecure_local === true);
    add("server_url", true, url.ok, url.detail);
    for (const workspace of profile.workspaces) {
      const exists = await isDirectory(workspace.path);
      add(`workspace:${workspace.id}`, true, exists, exists ? undefined : "missing or not a directory");
    }
  } else add("server_url", false, false, "not enrolled");

  const storedMode = profileExecutionMode(profile);
  const executionMode: ExecutionMode | "migration_required" = mode === "user" ? "dedicated_user" : storedMode ?? "migration_required";
  const manifest = renderService({ ...(platform === undefined ? {} : { platform }), mode, profilePath: store.filePath, ...(executionMode === "migration_required" ? {} : { executionMode }) });
  add("execution_mode", enrolled, executionMode !== "migration_required", !enrolled ? "not enrolled" : executionMode === "migration_required" ? "legacy profile has no execution_mode; choose --execution-mode dedicated_user or privileged_host before installation" : executionMode);
  let serviceContent: string | undefined;
  try { serviceContent = await (dependencies.serviceFilesystem ?? hostServiceManifestFilesystem).read(manifest.path); } catch (error) { add("service_manifest", true, false, errorMessage(error)); }
  if (!checks.some((check) => check.name === "service_manifest")) {
    const managed = serviceContent !== undefined && isManagedService(serviceContent);
    add("service_manifest", true, managed, serviceContent === undefined ? "not installed" : managed ? undefined : "unmanaged manifest");
  }
  const manager = dependencies.serviceManager ?? createServiceManager({ platform: manifest.platform, mode: manifest.mode });
  if (manager.platform !== manifest.platform || manager.mode !== manifest.mode || manager.status === undefined) {
    add("service_installed", false, false, "service status probe unavailable");
    add("service_active", false, false, "service status probe unavailable");
  } else {
    try {
      const status = await manager.status(manifest);
      add("service_installed", true, status.installed, status.detail);
      add("service_active", true, status.active, status.detail);
      const expectedIdentity = manifest.mode === "system" && manifest.executionMode === "dedicated_user" ? "runmesh" : undefined;
      const identityMatches = expectedIdentity === undefined || status.identity === expectedIdentity || (manifest.platform === "win32" && status.identity === "NT AUTHORITY\\LOCAL SERVICE");
      add("service_identity", expectedIdentity !== undefined, identityMatches, status.identity ?? "service identity unavailable");
    } catch (error) {
      const detail = errorMessage(error);
      add("service_installed", true, false, detail);
      add("service_active", true, false, detail);
      add("service_identity", manifest.mode === "system" && manifest.executionMode === "dedicated_user", false, detail);
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
  return { ok: checks.filter((check) => check.required).every((check) => check.ok), checks, profile: redactedProfile(profile), service: { manifest: manifest.path, mode, execution_mode: executionMode } };
}
async function serviceCommand(parsed: ParsedCommand, store: ProfileStore, output: (line: string) => void, dependencies: CliDependencies): Promise<void> {
  const manifest = await serviceManifestFor(parsed, store, dependencies.servicePlatform);
  const manager = dependencies.serviceManager ?? createServiceManager({ platform: manifest.platform, mode: manifest.mode });
  if (manager.platform !== manifest.platform || manager.mode !== manifest.mode) throw new Error("service manager does not match the requested service mode");
  if (parsed.command === "install") {
    assertSystemInstallationPrivilege(manifest, dependencies);
    const provisioner = dependencies.serviceProvisioner ?? createServiceProvisioner({ platform: manifest.platform });
    const provisioned = await provisioner.provision(manifest, store.filePath);
    await installServiceManifest(manifest, dependencies.serviceFilesystem, { confirmPrivilegedHost: parsed.values.confirmPrivilegedHost === true });
    await manager.install(manifest);
    report(output, parsed.json, { action: "install", manifest: manifest.path, mode: manifest.mode, identity: provisioned.identity, profile_secured: provisioned.profileSecured, commands: serviceCommandNames("install", manifest) });
    return;
  }
  await assertManagedServiceManifest(manifest, dependencies.serviceFilesystem);
  if (parsed.command === "stop") await manager.stop(manifest);
  else await manager.restart(manifest);
  report(output, parsed.json, { action: parsed.command, manifest: manifest.path, mode: manifest.mode, commands: serviceCommandNames(parsed.command as "install" | "stop" | "restart", manifest) });
}
async function uninstall(parsed: ParsedCommand, store: ProfileStore, output: (line: string) => void, dependencies: CliDependencies): Promise<void> {
  if (parsed.values.purge === true && parsed.values.yes !== true) throw new Error("--purge requires --yes");
  const manifest = await serviceManifestFor(parsed, store, dependencies.servicePlatform);
  const manager = dependencies.serviceManager ?? createServiceManager({ platform: manifest.platform, mode: manifest.mode });
  if (manager.platform !== manifest.platform || manager.mode !== manifest.mode) throw new Error("service manager does not match the requested service mode");
  assertSystemInstallationPrivilege(manifest, dependencies);
  const managed = await assertManagedServiceManifest(manifest, dependencies.serviceFilesystem);
  if (managed) await manager.uninstall(manifest);
  const removed = await removeServiceManifest(manifest, dependencies.serviceFilesystem);
  if (parsed.values.purge === true) await store.remove();
  // Job state and workspace roots deliberately remain untouched, including with --purge.
  report(output, parsed.json, { action: "uninstall", service_removed: removed, profile_removed: parsed.values.purge === true, mode: manifest.mode, commands: serviceCommandNames("uninstall", manifest) });
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
  if (command === "workspace" && ["list", "add", "remove"].includes(rest[0] ?? "")) values.action = rest.shift() as string;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") { values.json = true; continue; }
    if (arg === "--readonly") { values.readonly = true; continue; }
    if (arg === "--no-shell") { values.noShell = true; continue; }
    if (arg === "--purge") { values.purge = true; continue; }
    if (arg === "--yes") { values.yes = true; continue; }
    if (arg === "--insecure-local") { values.insecureLocal = true; continue; }
    if (arg === "--re-enroll") { values.reEnroll = true; continue; }
    if (arg === "--user") { values.user = true; continue; }
    if (arg === "--confirm-privileged-host") { values.confirmPrivilegedHost = true; continue; }
    const key = arg === "--execution-mode" ? "executionMode" : arg === "--server" ? "server" : arg === "--code" ? "code" : arg === "--cwd" ? "cwd" : arg === "--id" ? "id" : arg === "--path" ? "path" : arg === "--executable-path" ? "executablePath" : arg === "--profile" ? "profilePath" : undefined;
    const value = rest[index + 1]; if (key === undefined || value === undefined || value.startsWith("--")) throw new Error(`unknown or incomplete option: ${arg}`);
    values[key] = value; index += 1;
  }
  return { command, json: values.json === true, values, passthrough };
}
function storeFor(parsed: ParsedCommand, platform?: ServicePlatform): ProfileStore {
  if (typeof parsed.values.profilePath === "string") return new ProfileStore({ filePath: parsed.values.profilePath });
  if (parsed.values.user === true || process.env.CODING_RUNNER_PROFILE !== undefined) return new ProfileStore();
  const layout = serviceLayout({ ...(platform === undefined ? {} : { platform }), mode: "system" });
  return new ProfileStore({ filePath: join(layout.configRoot, "profile.json") });
}
async function serviceManifestFor(parsed: ParsedCommand, store: ProfileStore, platform?: ServicePlatform): Promise<ServiceManifest> {
  const profile = await store.load();
  const requestedMode = parsed.values.executionMode;
  if (requestedMode !== undefined && requestedMode !== "dedicated_user" && requestedMode !== "privileged_host") throw new Error("--execution-mode must be dedicated_user or privileged_host");
  const profileMode = profileExecutionMode(profile);
  const profileExecutionModeValue: ExecutionMode | undefined = profileMode === "migration_required" ? undefined : profileMode;
  if (parsed.values.user !== true && profileMode === "migration_required" && requestedMode === undefined) throw new Error("legacy Runner profile requires --execution-mode dedicated_user or --execution-mode privileged_host before system installation");
  const executionMode: ExecutionMode = parsed.values.user === true ? "dedicated_user" : requestedMode ?? profileExecutionModeValue ?? "dedicated_user";
  const requestedServiceMode = parsed.values.user === true ? "user" : "system";
  return renderService({ ...(platform === undefined ? {} : { platform }), mode: requestedServiceMode, profilePath: store.filePath, executionMode, ...(typeof parsed.values.executablePath === "string" ? { executablePath: parsed.values.executablePath } : {}) });
}
function assertSystemInstallationPrivilege(manifest: ServiceManifest, dependencies: CliDependencies): void {
  if (manifest.mode !== "system") return;
  const elevated = dependencies.isAdministrator ?? (() => {
    if (manifest.platform !== "win32") return process.getuid?.() === 0;
    // `net session` returns success only from an elevated Windows token.
    return spawnSync("net", ["session"], { stdio: "ignore", windowsHide: true }).status === 0;
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
    return url.protocol === "wss:" || (url.protocol === "ws:" && loopback && insecureLocal) ? { ok: true } : { ok: false, detail: "wss:// is required except explicit loopback development" };
  } catch { return { ok: false, detail: "invalid URL" }; }
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512); }
function formatMode(mode: number | undefined): string { return mode === undefined ? "missing" : `0${mode.toString(8)}`; }
function installDisconnectControl(runner: RunnerConnection, file: string): void { let busy = false; const interval = setInterval(async () => { if (busy) return; busy = true; try { await access(file); await rm(file, { force: true }); runner.disconnectForTest(); } catch { /* absent */ } finally { busy = false; } }, 50); interval.unref(); }

if (process.argv[1] !== undefined && (import.meta.url === new URL(`file://${process.argv[1]}`).href || process.env.RUNMESH_RUNNER_BUNDLE === "1")) runCli(process.argv.slice(2)).catch(() => { process.exitCode = 1; });
