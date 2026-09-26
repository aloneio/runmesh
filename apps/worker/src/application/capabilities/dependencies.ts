import type { CapabilityTarget } from "../../contracts/capabilities.js";
import type { CatalogAdminPorts } from "../../contracts/catalog.js";
import type { SkillDependencyState } from "../../contracts/skills.js";
import { parseProfile } from "../../contracts/connector-values.js";
import { compatibleApprovedTools, verifiedCatalogSnapshot } from "../../domain/capabilities/catalog.js";

/** Advisory stored configuration only: no network, token refresh or execution.
 * Caller revalidates client identity; this reader reports shared publication status only. */
export function createDependencyReader(ports: Pick<CatalogAdminPorts, "repository" | "profile" | "digest">) {
  return async (target: Extract<CapabilityTarget, { kind: "remote_tool" }>, signal: AbortSignal): Promise<SkillDependencyState> => {
    try {
      if (signal.aborted) return "unavailable";
      const raw = ports.profile(target.connection_profile_id);
      if (!raw) return "not_configured";
      const profile = parseProfile(raw);
      if (!profile || profile.profile_id !== target.connection_profile_id) return "unavailable";
      if (!profile.enabled) return "disabled";
      const head = ports.repository.readHead(profile.profile_id);
      if (!head?.approved_digest) return "incompatible";
      const observed = ports.repository.readSnapshot(profile.profile_id, head.observed_digest);
      const approved = head.approved_digest === head.observed_digest ? observed : ports.repository.readSnapshot(profile.profile_id, head.approved_digest);
      if (!observed || !approved || !await verifiedCatalogSnapshot(observed, profile, head.observed_digest, ports.digest)
        || (approved !== observed && !await verifiedCatalogSnapshot(approved, profile, head.approved_digest, ports.digest))) return "unavailable";
      if (signal.aborted || ports.profile(profile.profile_id)?.revision !== profile.revision
        || ports.repository.readHead(profile.profile_id)?.revision !== head.revision) return "unavailable";
      return compatibleApprovedTools(observed, approved, head.approved_names).some(t => t.tool_id === target.resource_id && t.version === target.version)
        ? "configured" : "incompatible";
    } catch { return "unavailable"; }
  };
}
