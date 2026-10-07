import type { AdminDecision } from "./admin-session.js";
import type { RemoteConnector, RemoteCode } from "./remote.js";
import type { RemoteServerInfo } from "./remote-server.js";
export type ConnectorInspection = { readonly state: "inspected"; readonly endpoint: string; readonly server: RemoteServerInfo;
  readonly tools_count: number | null; readonly observed_at_ms: number }
  | { readonly state: "authorization_required" | "invalid" | "denied" | "unavailable"; readonly code?: RemoteCode };
export interface ConnectorInspectionPorts {
  readonly connector: RemoteConnector;
  readonly authorize: (signal: AbortSignal) => Promise<AdminDecision>;
  readonly now: () => number;
}
export interface CentralConnectorInspection {
  inspectConnection(hash: string, input: unknown, origin: string): Promise<ConnectorInspection>;
}
