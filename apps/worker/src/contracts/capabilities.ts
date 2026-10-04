import type { CapturedIdentity } from "./identity.js";

export type CapabilityTarget =
  | { readonly kind: "remote_tool"; readonly resource_id: string; readonly version: string; readonly connection_profile_id: string }
  | { readonly kind: "skill"; readonly resource_id: string; readonly version: string };

/** Discovery metadata only; invocation revalidates identity and shared publication state. */
export type CentralToolVisibility = { readonly state: "visible"; readonly skill: boolean; readonly remote: boolean }
  | { readonly state: "denied" | "unavailable" };
export interface CentralToolVisibilityReader { toolVisibility(principal: CapturedIdentity): Promise<CentralToolVisibility> }
export function isCapabilityIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

export function parseCapabilityTarget(value: unknown): CapabilityTarget | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (!isCapabilityIdentifier(item.resource_id) || typeof item.version !== "string" || !/^[a-f0-9]{64}$/u.test(item.version)) return undefined;
  if (item.kind === "skill") return { kind: "skill", resource_id: item.resource_id, version: item.version };
  if (item.kind !== "remote_tool" || !isCapabilityIdentifier(item.connection_profile_id)) return undefined;
  return { kind: "remote_tool", resource_id: item.resource_id, version: item.version, connection_profile_id: item.connection_profile_id };
}
