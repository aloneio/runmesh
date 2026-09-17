import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { decodeWireFrame, encodeWireFrame, PROTOCOL_CURRENT_VERSION as version, PROTOCOL_MIN_VERSION, type WireMessage } from "@aloneio/runmesh-protocol";

/** Public transport only. A valid sync is acknowledged before an older one
 * is sent. Use an explicitly authorized, isolated test Runner identity:
 * opening this socket replaces any existing connection for that identity. */
export async function probeSessionConflict(input: { server: string; runnerId: string; token: string }) {
  const sockets: WebSocket[] = [];
  const url = new URL(input.server);
  url.searchParams.set("runner_id", input.runnerId);
  const connect = async () => {
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${input.token}` }, handshakeTimeout: 10000 });
    sockets.push(socket);
    const messages: WireMessage[] = [];
    let closed: { code: number; reason: string } | undefined;
    let failed = false;
    socket.on("error", () => { failed = true; });
    socket.on("unexpected-response", (_request, response) => { response.resume(); failed = true; socket.terminate(); });
    socket.on("close", (code, reason) => { closed = { code, reason: reason.toString() }; });
    socket.on("message", (bytes) => { try { messages.push(decodeWireFrame(bytes.toString())); } catch { failed = true; socket.terminate(); } });
    const until = async <T>(read: () => T | undefined): Promise<T> => {
      const deadline = Date.now() + 10000;
      for (;;) {
        const value = read();
        if (value !== undefined) return value;
        assert.ok(!failed && Date.now() < deadline, "test Runner transport failed or exceeded its deadline");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    await until(() => socket.readyState === WebSocket.OPEN ? true : undefined);
    const send = (frame: WireMessage) => socket.send(encodeWireFrame(frame));
    send({ type: "runner.hello", protocol_version: version, request_id: "probe-hello", min_protocol_version: PROTOCOL_MIN_VERSION, max_protocol_version: version,
      runner: { runner_id: input.runnerId, runner_version: "session-e2e", platform: "test", architecture: "test", capabilities: {
        filesystem: false, process_execution: false, workspace_sync: true, pty: false, network_access: false,
        max_concurrent_jobs: 1, supported_rpc_methods: [], labels: {},
      } } });
    const welcome = await until(() => messages.find(frame => frame.type === "runner.welcome"));
    assert.equal(welcome.type, "runner.welcome");
    return { socket, send, messages, until, welcome, closed: () => closed };
  };
  try {
    const first = await connect();
    const sync = (sequence: number): WireMessage => ({ type: "runner.sync", protocol_version: version,
      runner_id: input.runnerId, sync_sequence: sequence, sent_at_ms: Date.now(), jobs: [], workspaces: [], extensions: { runmesh_history_ack: true } });
    first.send(sync(2));
    await first.until(() => first.messages.find(frame => frame.type === "rpc.response" && frame.request_id === "history-2"));
    first.send(sync(1));
    const rejection = await first.until(first.closed);
    assert.deepEqual(rejection, { code: 4000, reason: "stale runner session" });
    assert.ok(!first.messages.some(frame => frame.type === "rpc.response" && frame.request_id === "history-1"), "stale sync must not be acknowledged");
    const recovered = await connect();
    assert.ok(first.welcome.type === "runner.welcome" && recovered.welcome.type === "runner.welcome");
    assert.notEqual(first.welcome.session_id, recovered.welcome.session_id);
    recovered.send({ type: "rpc.request", protocol_version: version, request_id: "probe-recovery", method: "echo", params: { recovered: true } });
    const echo = await recovered.until(() => recovered.messages.find(frame => frame.type === "rpc.response" && frame.request_id === "probe-recovery"));
    assert.ok(echo.type === "rpc.response");
    assert.deepEqual(JSON.parse(JSON.stringify(echo.result)), { recovered: true });
    return { valid_sync_acknowledged: true, stale_sync_acknowledged: false, close_code: rejection.code,
      close_reason: rejection.reason, same_credential_reconnected: true, new_session: true, recovery_echo: true };
  } finally {
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.CLOSED) continue;
      const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
      socket.close(1000, "test complete");
      const timer = setTimeout(() => socket.terminate(), 1000);
      await closed;
      clearTimeout(timer);
    }
  }
}
