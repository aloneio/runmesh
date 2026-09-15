import { EnvironmentInfoService } from "../runtime.js";
import type { ExecutionMode } from "../service.js";
import { ProfileStore } from "../profile.js";
import { purgeInstallation } from "../purge.js";
import type { ServiceManagerAdapter } from "../service.js";
import type { ServiceManifestFilesystem } from "../service.js";
import type { ServicePlatform } from "../service.js";
import type { ServicePrivilegeState } from "../service.js";
import type { ServiceProvisioner } from "../service.js";
import type { ShellRuntime } from "../runtime.js";
import { validateRunnerConfig } from "../config.js";

export interface CliDependencies {
  /** Injected cleanup executor; tests must never purge a host installation. */
  readonly purgeInstallation?: typeof purgeInstallation;
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
