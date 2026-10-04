import type { ConnectionProfile } from "./connectors.js";
export type CentralAdminFailure = { readonly state: "invalid" | "missing" | "denied" | "unavailable" };
export interface CentralManagement {
  listProfiles(sessionHash: string, after?: string): Promise<{ readonly state: "listed"; readonly profiles: readonly ConnectionProfile[]; readonly next_after: string | null } | CentralAdminFailure>;
}
