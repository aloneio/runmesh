export interface ShellRuntime {
  readonly kind: "bash" | "powershell";
  readonly executable: string;
  readonly version?: string | undefined;
  readonly buildInvocation: (command: string) => { readonly file: string; readonly args: readonly string[] };
}

/** Workspace projection needed by local environment discovery. */
export interface EnvironmentWorkspace {
  readonly workspaceId: string;
  readonly readonly: boolean;
  readonly shell: boolean;
}

/** Consumers request environment evidence without depending on native probes. */
export interface EnvironmentReader {
  get(workspaces: readonly EnvironmentWorkspace[]): Promise<Record<string, unknown>>;
}
