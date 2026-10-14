import { env, runInDurableObject } from "cloudflare:test";
import { encodeWireFrame, PROTOCOL_CURRENT_VERSION as version } from "@aloneio/runmesh-protocol";
import { expect, it, vi } from "vitest";
import { RunnerDO } from "../src/runner-do.js";
import { BridgeReplies } from "../src/platform/bridge-replies.js";

const runner = "heartbeat-runner";
const now = Date.parse("2026-10-14T00:00:00Z");
function socket() {
  let attachment: Record<string, unknown> = { runnerId: runner, sessionId: "session", lifecycleId: "a".repeat(64),
    epoch: 1, credentialVersion: 1, protocolVersion: version, authenticated: true, helloDeadlineMs: now + 10000 };
  const close = vi.fn(), send = vi.fn();
  const serializeAttachment = vi.fn((value: unknown) => { attachment = structuredClone(value) as Record<string, unknown>; });
  const ws = { close, send, serializeAttachment, deserializeAttachment: () => structuredClone(attachment) } as unknown as WebSocket;
  return { ws, close, send, serializeAttachment, attachment: () => structuredClone(attachment) };
}
const heartbeat = () => encodeWireFrame({ type: "runner.heartbeat", protocol_version: version, runner_id: runner, sent_at_ms: Date.now(), active_job_ids: [] });

it.each([429, 500, 502, 503, 504, "throw"] as const)("isolates heartbeat persistence failure %s without rejecting unrelated RPCs", async status => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName("heartbeat-outage-" + crypto.randomUUID()));
  await runInDurableObject(stub, async (_existing, state) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now), random = vi.spyOn(Math, "random").mockReturnValue(0);
    const cancel = vi.fn();
    const request = vi.fn(async () => { if (status === "throw") throw new Error("SECRET_UPSTREAM_ERROR"); return new Response(new ReadableStream({ cancel }), { status }); });
    const replies = new BridgeReplies(), f = socket(), resolve = vi.fn(), timer = setTimeout(() => {}, 10000);
    const instance = new RunnerDO(state, env, { registryRequest: request, replies });
    replies.register("pending-job", { resolve, timer, socket: f.ws });
    try {
      await instance.webSocketMessage(f.ws, heartbeat());
      expect(f.close).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled();
      expect(f.attachment().heartbeatRetry).toEqual({ failures: 1, failedAtMs: now, retryAtMs: now + 30000 });
      if (status !== "throw") expect(cancel).toHaveBeenCalledOnce();
      expect(JSON.stringify(f.attachment())).not.toContain("SECRET");
    } finally { clearTimeout(timer); replies.forget("pending-job"); clock.mockRestore(); random.mockRestore(); }
  });
});

it("retains cooldown through adapter reconstruction and adds no SQL, KV or Alarm I/O", async () => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName("heartbeat-reconstruct-" + crypto.randomUUID()));
  await runInDurableObject(stub, async (_existing, state) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now), random = vi.spyOn(Math, "random").mockReturnValue(0);
    const sql = vi.spyOn(state.storage.sql, "exec"), put = vi.spyOn(state.storage, "put"), alarm = vi.spyOn(state.storage, "setAlarm");
    const request = vi.fn(async () => new Response(null, { status: 503, headers: { "retry-after": "120" } })), f = socket();
    try {
      await new RunnerDO(state, env, { registryRequest: request }).webSocketMessage(f.ws, heartbeat());
      clock.mockReturnValue(now + 60000);
      const recovered = new RunnerDO(state, env, { registryRequest: request });
      await recovered.webSocketMessage(f.ws, heartbeat());
      expect(request).toHaveBeenCalledOnce();
      clock.mockReturnValue(now + 120000);
      await recovered.webSocketMessage(f.ws, heartbeat());
      expect(request).toHaveBeenCalledTimes(2); expect(f.close).not.toHaveBeenCalled();
      expect(sql).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled(); expect(alarm).not.toHaveBeenCalled();
    } finally { sql.mockRestore(); put.mockRestore(); alarm.mockRestore(); clock.mockRestore(); random.mockRestore(); }
  });
});

it("recovers on the same socket and resumes normal persistence after a successful retry", async () => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName("heartbeat-recovery-" + crypto.randomUUID()));
  await runInDurableObject(stub, async (_existing, state) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now), random = vi.spyOn(Math, "random").mockReturnValue(0);
    let healthy = false;
    const request = vi.fn(async (_runnerId: string, _action: string, _init: RequestInit) => new Response(null, { status: healthy ? 204 : 503 })), f = socket();
    const instance = new RunnerDO(state, env, { registryRequest: request });
    try {
      await instance.webSocketMessage(f.ws, heartbeat());
      healthy = true; clock.mockReturnValue(now + 30000);
      await instance.webSocketMessage(f.ws, heartbeat());
      expect(f.attachment().heartbeatRetry).toBeUndefined();
      clock.mockReturnValue(now + 60000);
      await instance.webSocketMessage(f.ws, heartbeat());
      expect(request).toHaveBeenCalledTimes(2);
      clock.mockReturnValue(now + 150000);
      await instance.webSocketMessage(f.ws, heartbeat());
      expect(request).toHaveBeenCalledTimes(3); expect(f.close).not.toHaveBeenCalled();
      expect(request.mock.calls.every(call => call[1] === "/heartbeat")).toBe(true);
    } finally { clock.mockRestore(); random.mockRestore(); }
  });
});

it.each([401, 403, 409, 400, 404])("still closes on explicit rejection/nonretryable receipt %s", async status => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName("heartbeat-rejection-" + crypto.randomUUID()));
  await runInDurableObject(stub, async (_existing, state) => {
    const f = socket();
    await new RunnerDO(state, env, { registryRequest: async () => new Response(null, { status }) }).webSocketMessage(f.ws, heartbeat());
    expect(f.close.mock.calls[0]?.[0]).toBe(status === 401 || status === 403 ? 4001 : status === 409 ? 4000 : 1013);
    expect(f.attachment().heartbeatRetry).toBeUndefined();
  });
});

it("supports the explicit legacy reconnect rollback without changing credentials", async () => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName("heartbeat-rollback-" + crypto.randomUUID()));
  await runInDurableObject(stub, async (_existing, state) => {
    const f = socket();
    await new RunnerDO(state, { ...env, RUNMESH_HEARTBEAT_FAILURE_MODE: "reconnect" }, { registryRequest: async () => new Response(null, { status: 503 }) }).webSocketMessage(f.ws, heartbeat());
    expect(f.close).toHaveBeenCalledExactlyOnceWith(1013, "control plane temporarily unavailable");
    expect(f.attachment().heartbeatRetry).toBeUndefined();
  });
});

it.each([401, 403, 409, 503])("a cooldown never grants or caches session authority (%s)", async status => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName("heartbeat-authority-" + crypto.randomUUID()));
  await runInDurableObject(stub, async (_existing, state) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now), f = socket(), replies = new BridgeReplies();
    const request = vi.fn(async (_id: string, action: string) => new Response(null, { status: action === "/heartbeat" ? 503 : status }));
    const instance = new RunnerDO(state, env, { registryRequest: request, replies });
    const resolve = vi.fn(), timer = setTimeout(() => {}, 10000);
    try {
      await instance.webSocketMessage(f.ws, heartbeat());
      expect(f.close).not.toHaveBeenCalled();
      replies.register("protected-reply", { resolve, timer, socket: f.ws });
      await instance.webSocketMessage(f.ws, encodeWireFrame({ type: "rpc.response", protocol_version: version,
        request_id: "protected-reply", result: { private: "UNVERIFIED_RESULT" } }));
      expect(request.mock.calls.map(call => call[1])).toEqual(["/heartbeat", "/session"]);
      expect(resolve).toHaveBeenCalledOnce(); expect(resolve.mock.calls[0]?.[0].type).toBe("rpc.error");
      expect(JSON.stringify(resolve.mock.calls)).not.toContain("UNVERIFIED_RESULT");
      if (status === 503) expect(f.close).not.toHaveBeenCalled();
      else expect(f.close.mock.calls[0]?.[0]).toBe(status === 409 ? 4000 : 4001);
    } finally { clearTimeout(timer); replies.forget("protected-reply"); clock.mockRestore(); }
  });
});

it("still rejects a mismatched Runner identity during cooldown", async () => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName("heartbeat-identity-" + crypto.randomUUID()));
  await runInDurableObject(stub, async (_existing, state) => {
    const f = socket(), request = vi.fn(async () => new Response(null, { status: 503 }));
    const instance = new RunnerDO(state, env, { registryRequest: request });
    await instance.webSocketMessage(f.ws, heartbeat());
    await instance.webSocketMessage(f.ws, encodeWireFrame({ type: "runner.heartbeat", protocol_version: version,
      runner_id: "another-runner", sent_at_ms: Date.now(), active_job_ids: [] }));
    expect(request).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledExactlyOnceWith(1008, "runner identity mismatch");
  });
});

it("coalesces concurrent heartbeats and preserves attachment changes across await", async () => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName("heartbeat-coalesce-" + crypto.randomUUID()));
  await runInDurableObject(stub, async (_existing, state) => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    const f = socket(), request = vi.fn(async () => pending);
    const instance = new RunnerDO(state, env, { registryRequest: request });
    const first = instance.webSocketMessage(f.ws, heartbeat());
    try {
      await instance.webSocketMessage(f.ws, heartbeat());
      expect(request).toHaveBeenCalledOnce();
      f.ws.serializeAttachment({ ...f.attachment(), pendingUpdateRpcIds: ["keep-this-identity-bound-request"] });
    } finally { finish(new Response(null, { status: 503 })); await first; }
    expect(f.attachment().pendingUpdateRpcIds).toEqual(["keep-this-identity-bound-request"]);
    expect(f.close).not.toHaveBeenCalled();
  });
});

it("attachment metadata failure does not close or create a same-isolate retry storm", async () => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName("heartbeat-metadata-" + crypto.randomUUID()));
  await runInDurableObject(stub, async (_existing, state) => {
    const f = socket(), request = vi.fn(async () => new Response(null, { status: 503 }));
    f.serializeAttachment.mockImplementation(() => { throw new Error("attachment unavailable"); });
    const instance = new RunnerDO(state, env, { registryRequest: request });
    await instance.webSocketMessage(f.ws, heartbeat());
    await instance.webSocketMessage(f.ws, heartbeat());
    expect(request).toHaveBeenCalledOnce(); expect(f.close).not.toHaveBeenCalled();
  });
});

it("bounds six legacy Runners' persistence attempts over a simulated 24-hour outage", async () => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName("heartbeat-six-runners-" + crypto.randomUUID()));
  await runInDurableObject(stub, async (_existing, state) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now), random = vi.spyOn(Math, "random").mockReturnValue(0);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const request = vi.fn(async () => new Response(null, { status: 503 }));
    const runners = Array.from({ length: 6 }, () => ({ socket: socket(), instance: new RunnerDO(state, env, { registryRequest: request }) }));
    try {
      for (let elapsed = 0; elapsed < 86400000; elapsed += 30000) {
        clock.mockReturnValue(now + elapsed);
        for (const runner of runners) await runner.instance.webSocketMessage(runner.socket.ws, heartbeat());
      }
      expect(request.mock.calls.length).toBeLessThanOrEqual(6 * 370);
      expect(request.mock.calls.length).toBeGreaterThan(6 * 350);
      for (const runner of runners) expect(runner.socket.close).not.toHaveBeenCalled();
      console.log(JSON.stringify({ scenario: "six_runner_heartbeat_outage", input_frames: 17280, persistence_attempts: request.mock.calls.length,
        note: "synthetic request attempts, not Cloudflare account billing" }));
    } finally { clock.mockRestore(); random.mockRestore(); warn.mockRestore(); }
  });
}, 30000);


it("coalesces healthy persistence across hibernation without advancing on skipped frames", async () => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName("heartbeat-healthy-" + crypto.randomUUID()));
  await runInDurableObject(stub, async (_existing, state) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now), f = socket();
    const request = vi.fn(async () => new Response(null, { status: 204 }));
    const sql = vi.spyOn(state.storage.sql, "exec"), put = vi.spyOn(state.storage, "put"), alarm = vi.spyOn(state.storage, "setAlarm");
    try {
      const instance = new RunnerDO(state, env, { registryRequest: request });
      await instance.webSocketMessage(f.ws, heartbeat());
      for (const elapsed of [30000, 60000, 90000]) {
        clock.mockReturnValue(now + elapsed);
        await instance.webSocketMessage(f.ws, heartbeat());
      }
      expect(request).toHaveBeenCalledOnce();
      expect(f.attachment().heartbeatPersistedAtMs).toBe(now);
      const recovered = new RunnerDO(state, env, { registryRequest: request });
      clock.mockReturnValue(now + 119999);
      await recovered.webSocketMessage(f.ws, heartbeat());
      expect(request).toHaveBeenCalledOnce();
      clock.mockReturnValue(now + 120000);
      await recovered.webSocketMessage(f.ws, heartbeat());
      expect(request).toHaveBeenCalledTimes(2);
      expect(f.attachment().heartbeatPersistedAtMs).toBe(now + 120000);
      expect(f.close).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
      expect(sql).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled(); expect(alarm).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); sql.mockRestore(); put.mockRestore(); alarm.mockRestore(); }
  });
});

it.each([200, 202, 206])("does not count a noncommitted heartbeat receipt %s as persisted", async status => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName("heartbeat-uncommitted-" + crypto.randomUUID()));
  await runInDurableObject(stub, async (_existing, state) => {
    const f = socket();
    await new RunnerDO(state, env, { registryRequest: async () => new Response(null, { status }) }).webSocketMessage(f.ws, heartbeat());
    expect(f.attachment().heartbeatPersistedAtMs).toBeUndefined();
    expect(f.attachment().heartbeatRetry).toBeDefined();
    expect(f.send).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
  });
});

it("keeps healthy coalescing local when attachment writes fail and bounds clock rollback", async () => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName("heartbeat-clock-" + crypto.randomUUID()));
  await runInDurableObject(stub, async (_existing, state) => {
    const f = socket(), clock = vi.spyOn(Date, "now").mockReturnValue(now);
    f.serializeAttachment.mockImplementation(() => { throw new Error("synthetic metadata fault"); });
    const request = vi.fn(async () => new Response(null, { status: 204 }));
    const instance = new RunnerDO(state, env, { registryRequest: request });
    try {
      await instance.webSocketMessage(f.ws, heartbeat());
      clock.mockReturnValue(now + 30000);
      await instance.webSocketMessage(f.ws, heartbeat());
      expect(request).toHaveBeenCalledOnce();
      clock.mockReturnValue(now - 1);
      await instance.webSocketMessage(f.ws, heartbeat());
      expect(request).toHaveBeenCalledTimes(2); expect(f.close).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });
});
