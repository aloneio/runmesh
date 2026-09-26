import type { ConnectionProfile } from "../../contracts/connectors.js";
import type { RemoteEgressRule } from "../../contracts/remote.js";
import { publicMcpEndpoint } from "../../contracts/remote-values.js";

/** The control-panel connection is the administrator's exact destination approval. */
export function connectionPolicy(profile: ConnectionProfile): readonly RemoteEgressRule[] | undefined {
  if (profile.authentication !== "none" && profile.authentication !== "oauth") return undefined;
  if (publicMcpEndpoint(profile.endpoint) === undefined) return undefined;
  return [{ endpoint: profile.endpoint, protocol: "2025-11-25", session: "optional", negotiate: true }];
}
