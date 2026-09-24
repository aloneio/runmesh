import type { CapturedIdentity, ClientIdentity, IdentityReader } from "./identity.js";

/** Initial safety ceilings, not measured production capacity promises. */
export const CAPABILITY_LIMITS = Object.freeze({ rules_per_client: 128, grant_bytes: 65_536, grant_clients: 1_000, access_timeout_ms: 5_000 });

export type CapabilityTarget =
  | { readonly kind: "remote_tool"; readonly resource_id: string; readonly version: string; readonly connection_profile_id: string }
  | { readonly kind: "skill"; readonly resource_id: string; readonly version: string };

export interface CapabilityGrant {
  readonly schema_version: 1;
  readonly client_id: string;
  readonly revision: number;
  readonly enabled: boolean;
  readonly rules: readonly CapabilityTarget[];
}

export interface GrantReplacement {
  readonly client_id: string;
  /** Zero is create-only; existing records require their observed revision. */
  readonly expected_revision: number;
  readonly enabled: boolean;
  readonly rules: readonly CapabilityTarget[];
}

export type GrantWriteResult =
  | { readonly state: "written"; readonly grant: CapabilityGrant }
  | { readonly state: "conflict"; readonly current_revision: number }
  | { readonly state: "invalid" | "capacity" };

export interface CapabilityGrantReader { readGrant(clientId: string, signal: AbortSignal): Promise<CapabilityGrant | undefined> }
export interface CapabilityGrantStore extends CapabilityGrantReader { replaceGrant(input: GrantReplacement): Promise<GrantWriteResult> }
export interface CapabilityAccessPorts { readonly identity: IdentityReader; readonly grants: CapabilityGrantReader }
export type CapabilityAccessDecision =
  | { readonly state: "allowed"; readonly identity: ClientIdentity; readonly grant_revision: number }
  | { readonly state: "disabled" | "denied" | "unavailable" | "malformed" };
export interface CapabilityAccess {
  check(principal: CapturedIdentity, target: CapabilityTarget, signal: AbortSignal): Promise<CapabilityAccessDecision>;
}

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

export function parseCapabilityGrant(value: unknown): CapabilityGrant | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (item.schema_version !== 1 || !isCapabilityIdentifier(item.client_id) || typeof item.enabled !== "boolean"
    || !Number.isSafeInteger(item.revision) || (item.revision as number) < 1
    || !Array.isArray(item.rules) || item.rules.length > CAPABILITY_LIMITS.rules_per_client) return undefined;
  const rules: CapabilityTarget[] = [], seen = new Set<string>();
  for (const value of item.rules) {
    const rule = parseCapabilityTarget(value);
    if (rule === undefined) return undefined;
    const key = JSON.stringify(rule);
    if (seen.has(key)) return undefined;
    seen.add(key); rules.push(rule);
  }
  const result = { schema_version: 1 as const, client_id: item.client_id, revision: item.revision as number, enabled: item.enabled, rules };
  return new TextEncoder().encode(JSON.stringify(result)).byteLength > CAPABILITY_LIMITS.grant_bytes ? undefined : result;
}
