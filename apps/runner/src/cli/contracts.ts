import type { EnvironmentReader, ShellRuntime } from "../environment-contracts.js";
import type { ExecutionMode } from "../service.js";
import type { ProfileSaveOptions, ProfileStore, RunnerProfile } from "../profile.js";
import type { purgeInstallation } from "../purge.js";
import type { ServiceManagerAdapter } from "../service.js";
import type { ServiceManifestFilesystem } from "../service.js";
import type { ServicePlatform } from "../service.js";
import type { ServicePrivilegeState } from "../service.js";
import type { ServiceProvisioner } from "../service.js";
import type { validateRunnerConfig } from "../config.js";
import type { MaintenanceManagerInstaller } from "../updates/manager-install.js";
import type { MaintenanceAgentOptions } from "../updates/agent.js";

/** Profile capabilities used by service lifecycle transactions. The installed
 * manager does not need execution, diagnostic or concrete storage internals. */
export interface ServiceProfilePort {
  readonly filePath: string;
  load(): Promise<RunnerProfile | undefined>;
  save(profile: RunnerProfile, options?: ProfileSaveOptions): Promise<void>;
  remove(): Promise<void>;
  assertServiceOwnership(executionMode: ExecutionMode, serviceGroup?: string): Promise<void>;
}

/** Host lifecycle ports shared by the product CLI and independent manager. */
export interface ServiceCliDependencies {
  /** Injected cleanup executor; tests must never purge a host installation. */
  readonly purgeInstallation?: typeof purgeInstallation;
  /** Injectable host adapter; production uses the platform service manager. */
  readonly serviceManager?: ServiceManagerAdapter;
  /** Independent manager installation is injectable alongside native services. */
  readonly maintenanceManager?: MaintenanceManagerInstaller;
  /** Injectable service-account and Runmesh-owned directory/ACL setup. */
  readonly serviceProvisioner?: ServiceProvisioner;
  /** Injectable manifest I/O keeps service tests off the host filesystem. */
  readonly serviceFilesystem?: ServiceManifestFilesystem;
  readonly servicePlatform?: ServicePlatform;
  /** Test hook for elevated system installation checks. */
  readonly isAdministrator?: () => boolean;
  readonly confirmPrivilegedHost?: boolean;
}

/** Maintenance has no execution, enrollment or diagnostic ports. */
export interface MaintenanceCliDependencies extends ServiceCliDependencies {
  readonly store?: ServiceProfilePort;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  readonly fetch?: typeof globalThis.fetch;
  readonly startMaintenanceAgent?: (options: MaintenanceAgentOptions) => Promise<void>;
}

export interface CliDependencies extends MaintenanceCliDependencies {
  readonly store?: ProfileStore;
  readonly startRunner?: (config: Awaited<ReturnType<typeof validateRunnerConfig>>) => Promise<void>;
  /** Injectable local discovery keeps doctor diagnostics deterministic in tests. */
  readonly environment?: EnvironmentReader;
  readonly discoverShellRuntime?: () => Promise<ShellRuntime | undefined>;
  readonly executionMode?: ExecutionMode;
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

export interface ParsedCommand { readonly command: string; readonly json: boolean; readonly values: Record<string, string | boolean | string[]>; readonly passthrough: string[]; }

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
    readonly execution_mode: ExecutionMode | null;
    readonly configured_execution_mode: ExecutionMode | null;
    readonly actual_service_identity: string | null;
    readonly privilege_state: ServicePrivilegeState;
  };
}

export interface ShareableDoctorReport {
  readonly schema_version: 1;
  readonly generated_at_ms: number;
  readonly runner_version: string;
  readonly ok: boolean;
  readonly configured: boolean;
  readonly checks: readonly {
    readonly name: string;
    readonly required: boolean;
    readonly ok: boolean;
    readonly status: "ok" | "warning" | "failure";
  }[];
  readonly service: {
    readonly mode: "system" | "user";
    readonly execution_mode: ExecutionMode | null;
    readonly privilege_state: ServicePrivilegeState;
  };
}

export type ProbedServiceStatus = Awaited<ReturnType<NonNullable<ServiceManagerAdapter["status"]>>>;
