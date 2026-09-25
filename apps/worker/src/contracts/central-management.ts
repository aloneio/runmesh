import type { CapabilityGrant, GrantWriteResult } from "./capabilities.js";
import type { ConnectionProfile } from "./connectors.js";
export type CentralAdminFailure = { readonly state: "invalid" | "missing" | "denied" | "unavailable" };
export interface CentralManagement {
  getClientGrant(sessionHash: string, clientId: string): Promise<{ readonly state: "found"; readonly grant: CapabilityGrant } | CentralAdminFailure>;
  setClientGrant(sessionHash: string, input: unknown): Promise<GrantWriteResult | CentralAdminFailure>;
  listProfiles(sessionHash: string, after?: string): Promise<{ readonly state: "listed"; readonly profiles: readonly ConnectionProfile[]; readonly next_after: string | null } | CentralAdminFailure>;
}
