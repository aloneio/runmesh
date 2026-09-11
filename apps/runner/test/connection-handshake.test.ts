import { WebSocketServer } from "ws";
import { describe, expect, it, vi } from "vitest";
import { PROTOCOL_CURRENT_VERSION, decodeWireFrame, encodeWireFrame, type WireMessage } from "@aloneio/runmesh-protocol";
import { RunnerConnection } from "../src/connection.js";
import type { RunnerRuntime } from "../src/runtime.js";
import type { PolicyStore } from "../src/policy-store.js";

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function welcomeFrame(requestId: string): WireMessage {
  return {
    type: "runner.welcome",
    protocol_version: PROTOCOL_CURRENT_VERSION,
    request_id: requestId,
    session_id: "handshake-session",
    negotiated_protocol_version: PROTOCOL_CURRENT_VERSION,
    worker: {
      worker_id: "runmesh",
      worker_version: "test",
      capabilities: {
        filesystem: false, process_execution: false, workspace_sync: true, pty: false, network_access: false,
        max_concurrent_jobs: 1, supported_rpc_methods: ["echo", "runner.info"], labels: { runtime: "cloudflare" },
      },
    },
  };
}

describe("runner welcome handshake fencing", () => {
  it("withholds job lifecycle frames until the welcome handshake completes", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing test port");

    const received: string[] = [];
    let welcome: (() => void) | undefined;
    let greeted: (() => void) | undefined;
    const hello = new Promise<void>((resolve) => { greeted = resolve; });
    server.on("connection", (socket) => {
      welcome = () => socket.send(encodeWireFrame(welcomeFrame("hello-handshake")));
      socket.on("message", (data) => {
        const frame = decodeWireFrame(String(data));
        received.push(frame.type);
        if (frame.type === "runner.hello") greeted?.();
      });
    });

    const states: string[] = [];
    const connection = new RunnerConnection({
      config: { runnerId: "handshake-runner", server: `ws://127.0.0.1:${address.port}`, token: "synthetic-token", workspaces: [] },
      runtime: { initialize: async () => {} } as unknown as RunnerRuntime,
      policyStore: { load: async () => undefined } as unknown as PolicyStore,
      random: () => 0,
      sleep: async () => {},
      onStateChange: (state) => states.push(state),
    });
    const forward = (jobId: string): void => {
      (connection as unknown as { forwardJobEvent(event: unknown): void }).forwardJobEvent({
        type: "started",
        job: { job_id: jobId, workspace_id: "workspace", status: "running", created_at_ms: 1, updated_at_ms: 2, created_by_client_id: null },
      });
    };

    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const running = connection.start().catch(() => undefined);
    try {
      await hello;
      // The transport is open but still unauthorized. A lifecycle frame emitted
      // here makes the Worker close with `4001 "credentials revoked"`, which the
      // reconnect loop reads as a permanent credential decision and stops.
      forward("before-welcome");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received).toEqual(["runner.hello"]);
      expect(states).not.toContain("online");

      welcome?.();
      await waitFor(() => states.includes("online"));
      forward("after-welcome");
      await waitFor(() => received.includes("job.started"));
    } finally {
      connection.stop();
      await running;
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      log.mockRestore();
    }
  });
});
