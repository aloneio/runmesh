import type { CapabilityGrant, CapabilityTarget } from "../../contracts/capabilities.js";

/** Exact grants only. Names, hints, Skill text and coding scopes cannot grant access. */
export function grantAllows(grant: CapabilityGrant, clientId: string, target: CapabilityTarget): boolean {
  return grant.enabled && grant.client_id === clientId && grant.rules.some(rule => {
    if (rule.kind !== target.kind || rule.resource_id !== target.resource_id || rule.version !== target.version) return false;
    return target.kind === "skill" || (rule.kind === "remote_tool" && rule.connection_profile_id === target.connection_profile_id);
  });
}
