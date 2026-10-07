export const MCP_REGISTRY_LIMITS = Object.freeze({ bytes: 262_144, remotes: 16, packages: 16, fields: 32 });
export interface RegistryCandidate {
  readonly endpoint: string;
  readonly transport: string;
  readonly mode: "connect" | "configure";
  readonly headers: readonly string[];
}
export interface RegistryPreview {
  readonly state: "previewed";
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly schema: string | null;
  readonly remotes: readonly RegistryCandidate[];
  readonly packages: readonly { readonly registry: string; readonly identifier: string; readonly version: string }[];
}
