import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { randomBase64Url, sha256Hex } from "../src/security.js";

it("projects expired and missing heartbeats consistently without waiting for maintenance", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, (registry, state) => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const cases = [
      { id: "expired", stored: "online", heartbeat: now - 45_001, expected: "stale" },
      { id: "missing", stored: "online", heartbeat: null, expected: "stale" },
      { id: "boundary", stored: "online", heartbeat: now - 45_000, expected: "online" },
      { id: "fresh", stored: "online", heartbeat: now, expected: "online" },
      { id: "disconnected", stored: "offline", heartbeat: now, expected: "offline" },
    ];
    try {
      registry.createMcpClient({ client_id: "presence-client", label: "Presence regression", secret_verifier: "b".repeat(64), secret_prefix: "test", scopes: ["coding:read"] }, now);
      for (const item of cases) {
        registry.registerRunner(item.id, "a".repeat(64), now, undefined, "dedicated_user");
        state.storage.sql.exec("UPDATE runners SET state=?, last_heartbeat_ms=? WHERE runner_id=?", item.stored, item.heartbeat, item.id);
      }
      // No alarm or detail lookup may rescue the list before this assertion.
      const listed = registry.listRunners();
      const dashboard = registry.dashboardSnapshot();
      for (const item of cases) {
        expect(listed.find(runner => runner.runner_id === item.id)?.state, item.id).toBe(item.expected);
        expect(dashboard.runners.find(runner => runner.runner_id === item.id)?.state, item.id).toBe(item.expected);
        state.storage.sql.exec("UPDATE mcp_clients SET active_runner_id=?, active_runner_updated_at_ms=? WHERE client_id='presence-client'", item.id, now);
        expect(registry.getMcpClientActiveRunner("presence-client")?.runner, item.id).toMatchObject({ state: item.expected, available: item.expected === "online" });
        expect(registry.getRunnerExecutionState(item.id)?.runner.state, item.id).toBe(item.expected);
        expect(registry.getRunner(item.id)?.state, item.id).toBe(item.expected);
      }
      // A real current heartbeat can make a stale projection fresh again.
      state.storage.sql.exec("UPDATE runners SET state='online', last_heartbeat_ms=? WHERE runner_id='expired'", now);
      expect(registry.listRunners().find(runner => runner.runner_id === "expired")?.state).toBe("online");
    } finally {
      clock.mockRestore();
    }
  });
});

it.each(["offline", "stale"] as const)("keeps runner_current and runner_list valid MCP replies when the Runner is %s", async expected => {
  const id = env.REGISTRY.idFromName(crypto.randomUUID());
  const stub = env.REGISTRY.get(id);
  const secret = randomBase64Url();
  const verifier = await sha256Hex(secret);
  await runInDurableObject(stub, (registry, state) => {
    const now = Date.now();
    registry.registerRunner("presence-runner", "a".repeat(64), now, undefined, "dedicated_user");
    const permissions = { read: true, edit: false, shell: false, job_control: false };
    registry.setRunnerPermissions("presence-runner", permissions, now);
    registry.createManagedWorkspace("presence-runner", { workspace_id: "work", display_name: "Synthetic workspace", root_path: "/synthetic", enabled: true, permissions }, now);
    const desired = registry.getDesiredPolicySnapshot("presence-runner")!;
    const before = registry.getRunnerExecutionState("presence-runner")!;
    const epoch = registry.beginConnection("presence-runner", { runner_version: "0.1.3", platform: "linux", architecture: "x64", hostname: "synthetic" } as any,
      { min_protocol_version: 2, max_protocol_version: 2 }, "presence-session", before.runner.credential_version, now)!;
    registry.acknowledgePolicy("presence-runner", epoch, before.runner.credential_version, {
      desired_revision: desired.revision, desired_checksum: desired.checksum, applied_revision: desired.revision, applied_checksum: desired.checksum,
      runner_reported_policy_revision: desired.revision, runner_reported_policy_checksum: desired.checksum,
      status: "applied", workspace_status: [{ workspace_id: "work", status: "valid" }],
    }, now, before.lifecycle_id, "presence-session");
    registry.createMcpClient({ client_id: "presence-client", label: "HTTP presence regression", secret_verifier: verifier, secret_prefix: "test", scopes: ["coding:read"] }, now);
    expect(registry.selectMcpClientRunner("presence-client", "presence-runner", false, now).ok).toBe(true);
    state.storage.sql.exec("UPDATE runners SET state=?, last_heartbeat_ms=? WHERE runner_id='presence-runner'", expected === "stale" ? "online" : "offline", now - 60_000);
  });
  const dispatch = vi.fn(() => { throw new Error("Presence tools must not dispatch Runner RPC"); });
  const localEnv = { ...env, REGISTRY: { idFromName: () => id, get: () => stub },
    RUNNER: { idFromName: () => id, get: () => ({ fetch: dispatch }) } } as unknown as typeof env;
  const request = (name: string) => new Request("https://presence.test/" + secret + "/mcp", { method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: {} } }) });
  for (const name of ["runner_list", "runner_current"]) {
    const response = await worker.fetch(request(name), localEnv, {} as ExecutionContext);
    expect(response.status).toBe(200);
    const body = await response.text();
    const json = response.headers.get("content-type")?.includes("text/event-stream")
      ? body.split("\n").find(line => line.startsWith("data:"))?.slice(5).trim() : body;
    const reply = JSON.parse(json!);
    expect(reply).toMatchObject({ jsonrpc: "2.0", id: name });
    expect(reply.error).toBeUndefined();
    expect(reply.result.isError).not.toBe(true);
    const value = reply.result.structuredContent;
    if (name === "runner_list") expect(value.runners).toEqual([expect.objectContaining({ runner_id: "presence-runner", state: expected, available: false })]);
    else expect(value.active_runner).toMatchObject({ runner_id: "presence-runner", state: expected, available: false });
  }
  expect(dispatch).not.toHaveBeenCalled();
  await runInDurableObject(stub, registry => { registry.revokeMcpClient("presence-client", Date.now()); });
  const denied = await worker.fetch(request("runner_current"), localEnv, {} as ExecutionContext);
  // Concealed credential rejection is an HTTP error, before MCP dispatch.
  // It must not be confused with a successfully authenticated offline Runner.
  expect(denied.status).toBe(404);
  expect(denied.headers.get("content-type")).not.toContain("application/json");
  expect(await denied.text()).toBe("Not found");
  expect(dispatch).not.toHaveBeenCalled();
});
