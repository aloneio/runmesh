

export type ServicePlatform = "linux" | "darwin" | "win32";

export type ServiceMode = "user" | "system";

/** The OS identity used by a machine service. */
export type ExecutionMode = "dedicated_user" | "privileged_host";

export interface ServiceManifest {
  readonly platform: ServicePlatform;
  readonly mode: ServiceMode;
  readonly executionMode: ExecutionMode;
  readonly path: string;
  readonly content: string;
  readonly hash: string;
  /** Operator-selected dedicated identity, when present in a managed unit. */
  readonly serviceUser?: string;
  readonly serviceGroup?: string;
}

export interface ServiceLayout {
  readonly installRoot: string;
  readonly configRoot: string;
  readonly stateRoot: string;
  readonly logRoot: string;
  readonly manifestPath: string;
  readonly executablePath: string;
}

export interface ServiceAdapterOptions {
  readonly platform?: ServicePlatform;
  readonly mode?: ServiceMode;
  /** Machine services default to a dedicated, non-privileged Runmesh account. */
  readonly executionMode?: ExecutionMode;
  /** Linux/macOS dedicated service account. Defaults to runmesh. */
  readonly serviceUser?: string;
  /** Linux dedicated service group. Defaults to the service user. */
  readonly serviceGroup?: string;
  /** @deprecated Prefer mode: "system" or mode: "user". */
  readonly system?: boolean;
  readonly home?: string;
  /** Absolute Runner executable. Defaults to the selected installation layout. */
  readonly executablePath?: string;
  /** @deprecated An absolute command is retained for callers from the prior adapter. */
  readonly command?: string;
  readonly profilePath?: string;
  readonly stateDir?: string;
  readonly installRoot?: string;
  readonly configRoot?: string;
  readonly dataRoot?: string;
  readonly logRoot?: string;
  /** Test/operator override for the directory containing the manifest. */
  readonly manifestDir?: string;
}

export interface ServiceManifestFilesystem {
  readonly read: (path: string) => Promise<string | undefined>;
  readonly write: (path: string, content: string) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
}

export interface ServiceCommandResult { readonly exitCode: number; readonly stdout?: string; readonly stderr?: string; }

export interface ServiceCommandExecutor {
  readonly execute: (file: string, args: readonly string[]) => Promise<ServiceCommandResult>;
}

export interface ServiceRuntimeStatus {
  readonly installed: boolean;
  readonly active: boolean;
  /**
   * Whether a native registration/unit exists, independent from its enabled
   * or active state. `undefined` means the adapter could not prove either
   * answer (or is a legacy injected adapter); callers must fail closed when
   * replacing an unmanaged registration.
   */
  readonly registered?: boolean;
  /** Identity reported by the host service manager, when its native query exposes it. */
  readonly identity?: string;
  readonly detail?: string;
  /**
   * False means the native probe could not distinguish an absent service from
   * a query/tool/permission failure.  Omitted is retained for injected legacy
   * adapters and is treated as reliable by callers for compatibility.
   */
  readonly reliable?: boolean;
}

export interface ServiceProvisioningStatus {
  readonly identity: string;
  readonly profileSecured: boolean;
  readonly detail?: string;
}

export interface ServiceProvisioner {
  readonly platform: ServicePlatform;
  /** Creates only Runmesh-owned account/directories/ACLs; it never changes Workspace ownership or modes. */
  readonly provision: (manifest: ServiceManifest, profilePath: string) => Promise<ServiceProvisioningStatus>;
}

export interface InstallServiceManifestOptions {
  /** Explicit acknowledgement required before writing a privileged machine service. */
  readonly confirmPrivilegedHost?: boolean;
}

export interface ServiceManagerAdapter {
  readonly platform: ServicePlatform;
  readonly mode: ServiceMode;
  readonly install: (manifest: ServiceManifest) => Promise<void>;
  readonly stop: (manifest: ServiceManifest) => Promise<void>;
  /**
   * Disable a native registration without deleting its managed definition.
   * This is optional for injected/legacy adapters; rollback uses it when a
   * pre-existing unit was registered but deliberately disabled.
   */
  readonly disable?: (manifest: ServiceManifest) => Promise<void>;
  readonly restart: (manifest: ServiceManifest) => Promise<void>;
  readonly uninstall: (manifest: ServiceManifest) => Promise<void>;
  /** Optional injectable status probe; custom managers may omit it. */
  readonly status?: (manifest: ServiceManifest) => Promise<ServiceRuntimeStatus>;
}

export interface ServiceManagerOptions {
  readonly platform?: ServicePlatform;
  readonly mode?: ServiceMode;
  readonly executor?: ServiceCommandExecutor;
}

export interface ServiceProvisionerOptions {
  readonly platform?: ServicePlatform;
  readonly executor?: ServiceCommandExecutor;
}

export type ServicePrivilegeState = "privileged" | "restricted" | "mismatch" | "unknown";

/**
 * Native service commands use non-zero exit codes for ordinary states such as
 * disabled, inactive, or not-found.  Classify those known states explicitly,
 * while marking silent/unknown query failures unreliable so a caller cannot
 * mistake an unavailable service probe for an absent one.
 */
export type NativeProbeKind = "enabled" | "active" | "query";

export type SystemdEnablementState = "enabled" | "enabled-runtime" | "disabled" | "static" | "indirect" | "generated" | "transient" | "masked" | "masked-runtime" | "alias" | "linked" | "linked-runtime" | "bad" | "not-found";
