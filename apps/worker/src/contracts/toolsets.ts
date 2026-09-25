import type { CapabilityTarget, GrantWriteResult } from "./capabilities.js";
export interface ToolsetProfile { readonly schema_version: 1; readonly toolset_id: string; readonly revision: number; readonly enabled: boolean; readonly rules: readonly CapabilityTarget[] }
export type ToolsetResult = { readonly state: "found" | "written"; readonly toolset: ToolsetProfile }
  | { readonly state: "conflict"; readonly current_revision: number } | { readonly state: "invalid" | "missing" | "capacity" | "denied" | "unavailable" };
export interface ToolsetAdministration {
  getToolset(hash: string, id: string): Promise<ToolsetResult>;
  mutateToolset(hash: string, input: unknown): Promise<ToolsetResult | GrantWriteResult>;
}
