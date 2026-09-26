import type { ConnectionProfile } from "../../contracts/connectors.js";
import type { RemoteEgressRule } from "../../contracts/remote.js";
import { publicMcpEndpoint, parseRemoteEgress } from "../../contracts/remote-values.js";

/** A managed profile is the administrator's exact destination approval. Legacy
 * profiles still require the deployment's original pinned egress policy. */
export function connectionPolicy(profile: ConnectionProfile, legacy: unknown): readonly RemoteEgressRule[] | undefined {
  if (profile.authentication === undefined) return parseRemoteEgress(legacy);
  if (publicMcpEndpoint(profile.endpoint) === undefined) return undefined;
  return [{ endpoint: profile.endpoint, protocol: "2025-11-25", session: "optional", negotiate: true }];
}
