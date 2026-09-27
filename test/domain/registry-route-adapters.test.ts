import { expect, it } from "vitest";
import { createAdminRoutes, type AdminRoutePorts } from "../../apps/worker/src/registry/routes/admin.js";
import { createClientsRoutes, type ClientsRoutePorts } from "../../apps/worker/src/registry/routes/clients.js";
import { createRunnerPolicyRoutes, type RunnerPolicyRoutePorts } from "../../apps/worker/src/registry/routes/runner-policy.js";
import { createIdentityRoutes, type IdentityRoutePorts } from "../../apps/worker/src/registry/routes/identity.js";
import type { RegistryRouteRequest } from "../../apps/worker/src/registry/routes/request.js";

// A missing collaborator fails immediately: adapters may touch only this case's ports.
function ports<T extends object>(values: Partial<T> = {}): T {
  return new Proxy(values, { get(target, key) {
    if (!Object.hasOwn(target, key)) throw new Error("unexpected route dependency: " + String(key));
    return Reflect.get(target, key);
  } }) as T;
}
function request(path: string, input: Record<string, unknown> = {}, method = "POST"): RegistryRouteRequest {
  const url = new URL("https://registry.internal/auth/" + path);
  return { method, segments: url.pathname.split("/").slice(2), input, nowMs: 1234, url };
}

it("route construction and unknown paths require no state owner or storage", () => {
  for (const route of [createAdminRoutes(ports<AdminRoutePorts>()), createClientsRoutes(ports<ClientsRoutePorts>()),
    createRunnerPolicyRoutes(ports<RunnerPolicyRoutePorts>()), createIdentityRoutes(ports<IdentityRoutePorts>())]) {
    expect(route(request("missing"))).toBeUndefined();
  }
});

it("admin session creation carries the admitted generation and returns its conflict synchronously", () => {
  let calls = 0;
  const route = createAdminRoutes(ports<AdminRoutePorts>({ createAdminSession(...args) {
    calls++;
    expect(args).toEqual(["a".repeat(64), "b".repeat(64), 5000, 1234, 2]);
    return false;
  } }));
  const result = route(request("sessions", { session_hash: "a".repeat(64), csrf_hash: "b".repeat(64), expires_at_ms: 5000, expected_session_version: 2 }));
  expect(calls).toBe(1);
  expect(result).toBeInstanceOf(Response);
  expect(result?.status).toBe(409);
});

it.each(["revoked", "wrong-client", "missing-read"])("selection rejects %s before touching a mutation port", async failure => {
  const route = createClientsRoutes(ports<ClientsRoutePorts>({ revalidateMcpClient() {
    return failure === "revoked" ? undefined : { client_id: failure === "wrong-client" ? "other" : "c", label: "test", scopes: failure === "missing-read" ? [] : ["coding:read"], secret_version: 3 };
  } }));
  const response = route(request("clients/c/active-runner", { runner_id: "r", mcp_authorization: { client_id: "c", secret_version: 3 } }));
  expect(response?.status).toBe(403);
  expect(await response?.json()).toMatchObject({ ok: false, code: failure === "missing-read" ? "insufficient_scope" : "permission_denied" });
});

it("selection validates the original principal and commits before yielding the event turn", async () => {
  const order: string[] = [];
  const route = createClientsRoutes(ports<ClientsRoutePorts>({
    revalidateMcpClient(clientId, version) {
      expect([clientId, version]).toEqual(["c", 3]);
      order.push("revalidate");
      queueMicrotask(() => order.push("next-turn"));
      return { client_id: "c", label: "test", scopes: ["coding:read"], secret_version: 3 };
    },
    selectMcpClientRunner(...args) {
      expect(args).toEqual(["c", "r", true, 1234]);
      order.push("commit");
      return { ok: false, code: "runner_unavailable" };
    },
  }));
  const response = route(request("clients/c/active-runner", { runner_id: "r", confirm_switch: true, mcp_authorization: { client_id: "c", secret_version: 3 } }));
  expect(order).toEqual(["revalidate", "commit"]);
  expect(response?.status).toBe(409);
  await Promise.resolve();
  expect(order).toEqual(["revalidate", "commit", "next-turn"]);
});

it("signed browser selection uses the owner-admitted session and the same mutation receipt", () => {
  const route = createClientsRoutes(ports<ClientsRoutePorts>({ selectMcpClientRunner() { return { ok: false, code: "runner_unavailable" }; } }));
  expect(route(request("clients/c/active-runner?admin_session=owner-verified", { runner_id: "r" }))?.status).toBe(409);
});

it("workspace listing checks runner existence without leaking storage records", () => {
  const route = createRunnerPolicyRoutes(ports<RunnerPolicyRoutePorts>({ hasRunner: () => false }));
  expect(route(request("runners/r/managed-workspaces", {}, "GET"))?.status).toBe(404);
});

it("invalid workspace and lifecycle mutations touch no owner", async () => {
  const route = createRunnerPolicyRoutes(ports<RunnerPolicyRoutePorts>());
  expect(route(request("runners/r/managed-workspaces", {}))?.status).toBe(400);
  const response = route(request("runners/r/validity", { valid_from_ms: null, valid_until_ms: null }));
  expect(response?.status).toBe(400);
  expect(await response?.text()).toBe("invalid validity window");
});

it.each(["verify", "revalidate"])("unsupported identity version fails before %s reaches state", action => {
  expect(createIdentityRoutes(ports<IdentityRoutePorts>())(request("mcp/" + action, { identity_version: 99 }))?.status).toBe(400);
});

it.each([["stale_policy", 409], ["permission_denied", 403]] as const)("RPC authority projects %s without granting execution", async (code, status) => {
  const response = createIdentityRoutes(ports<IdentityRoutePorts>({ authorizeMcpRpc: () => ({ ok: false, code }) }))(request("mcp/authorize-rpc"));
  expect(response?.status).toBe(status);
  expect(await response?.json()).toEqual({ ok: false, code });
});

it("storage failures propagate to the Registry admission owner's existing error response", () => {
  const route = createAdminRoutes(ports<AdminRoutePorts>({ adminStatus() { throw new Error("quota"); } }));
  expect(() => route(request("status", {}, "GET"))).toThrow("quota");
});
