/** Fixed classifications only: peer close reasons can contain secrets or log injection. */
const reasons: Readonly<Record<string, string>> = Object.freeze({
  "control plane temporarily unavailable": "control_plane_unavailable",
  "stale runner session": "session_replaced",
  "replaced by newer session": "session_replaced",
  "stale connection": "session_replaced",
  "runner credentials rejected": "credentials_rejected",
  "credentials revoked": "credentials_rejected",
  "controlled transport disconnect": "controlled_disconnect",
  "hello timeout": "hello_timeout",
  "invalid protocol frame": "invalid_frame",
  "protocol version mismatch": "protocol_mismatch",
  "transport keepalive timeout": "keepalive_timeout",
});

export function reportTransportClose(input: {
  readonly code: number;
  readonly reason: string;
  readonly welcomed: boolean;
  readonly current: boolean;
  readonly connectedMs: number;
}): void {
  try {
    const code = Number.isInteger(input.code) && input.code >= 1000 && input.code <= 4999 ? String(input.code) : "unknown";
    const reason = Object.prototype.hasOwnProperty.call(reasons, input.reason) ? reasons[input.reason] : input.reason === "" ? "empty" : "unclassified";
    const duration = Number.isFinite(input.connectedMs) && input.connectedMs >= 0
      ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(input.connectedMs)) : 0;
    console.warn(`RUNMESH_TRANSPORT_CLOSE code=${code} reason=${reason} welcomed=${input.welcomed === true} current=${input.current === true} connected_ms=${duration}`);
  } catch { /* Logging must never interrupt the close handler or reconnect loop. */ }
}
