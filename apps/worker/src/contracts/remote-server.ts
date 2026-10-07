export interface RemoteServerInfo {
  readonly protocol_version: string;
  readonly capabilities: { readonly tools: boolean; readonly resources: boolean; readonly prompts: boolean; readonly tasks: boolean; readonly apps: boolean };
}
