import type { ConnectorInspection, ConnectorInspectionPorts } from "../../contracts/connector-inspection.js";
import type { ConnectionProfile } from "../../contracts/connectors.js";
import { RemoteFault, type RemoteSession } from "../../contracts/remote.js";

/** Read-only observation: no catalog repository, publication or business call. */
export function createConnectorInspection(ports: ConnectorInspectionPorts) {
  return async (profile: ConnectionProfile, signal: AbortSignal): Promise<ConnectorInspection> => {
    let session: RemoteSession | undefined;
    try {
      const authorize = async () => {
        const decision = await ports.authorize(signal);
        if (signal.aborted) throw new RemoteFault("operation_timed_out");
        if (decision !== "allowed") throw new RemoteFault(decision === "denied" ? "permission_denied" : "dependency_unavailable");
      };
      await authorize();
      session = await ports.connector.open(profile, signal, () => { throw new RemoteFault("unsupported_interaction"); }, authorize);
      const server = session.describe?.();
      if (!server || (server.capabilities.tools && !session.countTools)) throw new RemoteFault("upstream_protocol_error");
      const toolsCount = server.capabilities.tools ? await session.countTools!() : null;
      const observed = session; session = undefined;
      await observed.close().catch(() => undefined);
      await authorize();
      if (!observed.current()) throw new RemoteFault("result_withheld");
      return { state: "inspected", endpoint: profile.endpoint, server, tools_count: toolsCount, observed_at_ms: ports.now() };
    } catch (error) {
      const code = error instanceof RemoteFault ? error.code : "dependency_unavailable";
      return { state: code === "authorization_required" ? "authorization_required" : code === "permission_denied" ? "denied" : "unavailable", code };
    } finally { await session?.close().catch(() => undefined); }
  };
}
