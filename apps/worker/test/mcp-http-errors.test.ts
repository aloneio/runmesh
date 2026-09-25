import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { MAX_MCP_BODY_BYTES } from "../src/http/constants.js";
import { randomBase64Url, sha256Hex } from "../src/security.js";

const secret = "a".repeat(43);
const request = (path: string, extra: Record<string, string> = {}) => new Request("https://worker.test" + path, {
  method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...extra },
  body: JSON.stringify({ jsonrpc: "2.0", id: "connection-test", method: "initialize", params: {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" },
  } }),
});

it.each(["/mcp", "/short/mcp", "/" + secret + "/mcp"])("returns parseable, non-disclosing MCP rejection for %s", async path => {
  const response = await worker.fetch(request(path), env, {} as ExecutionContext);
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  const body = await response.json();
  expect(body).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32000 } });
  expect(JSON.stringify(body)).not.toContain(secret);
  expect(JSON.stringify(body)).not.toContain("secret_verifier");
});

it("keeps recursion rejection JSON and does not authenticate or dispatch it", async () => {
  const access = vi.fn(() => { throw new Error("Must reject before Registry access"); });
  const localEnv = { ...env, REGISTRY: { idFromName: access, get: access } } as unknown as typeof env;
  const response = await worker.fetch(request("/" + secret + "/mcp", { "x-runmesh-mcp-hop": "1" }), localEnv, {} as ExecutionContext);
  expect(response.status).toBe(508);
  expect(await response.json()).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32000 } });
  expect(access).not.toHaveBeenCalled();
});

it("returns a structured configuration failure before the MCP handler starts", async () => {
  const response = await worker.fetch(request("/" + secret + "/mcp"), { ...env, INTERNAL_CONTROL_SECRET: undefined }, {} as ExecutionContext);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32000 } });
});

it("does not alter ordinary non-MCP not-found responses", async () => {
  const response = await worker.fetch(request("/unknown-route"), env, {} as ExecutionContext);
  expect(response.status).toBe(404);
  expect(await response.text()).toBe("Not found");
});

it("bounds rejected body consumption without changing the concealed rejection", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(16_385)); }, cancel });
  const response = await worker.fetch(new Request("https://worker.test/short/mcp", { method: "POST", body }), env, {} as ExecutionContext);
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32000 } });
  expect(cancel).toHaveBeenCalled();
});

it("does not wait indefinitely for a stalled rejected upload", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  try {
    const body = new ReadableStream<Uint8Array>({ cancel });
    const pending = worker.fetch(new Request("https://worker.test/short/mcp", { method: "POST", body }), env, {} as ExecutionContext);
    await vi.advanceTimersByTimeAsync(1_001);
    const response = await pending;
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32000 } });
    expect(cancel).toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it("preserves client routing and permissions while refusing old and revoked credentials as the same JSON error", async () => {
  const id = env.REGISTRY.idFromName(crypto.randomUUID()), stub = env.REGISTRY.get(id);
  const original = randomBase64Url(), replacement = randomBase64Url();
  const verifier = await sha256Hex(original), nextVerifier = await sha256Hex(replacement);
  const scopes = ["coding:read", "coding:write", "coding:exec"] as const;
  await runInDurableObject(stub, (registry, state) => {
    const now = Date.now();
    registry.registerRunner("retained-runner", "b".repeat(64), now, undefined, "dedicated_user");
    registry.createMcpClient({ client_id: "http-client", label: "Synthetic HTTP client", secret_verifier: verifier, secret_prefix: "test", scopes: [...scopes] }, now);
    state.storage.sql.exec("UPDATE mcp_clients SET active_runner_id='retained-runner', active_runner_updated_at_ms=? WHERE client_id='http-client'", now);
  });
  const localEnv = { ...env, REGISTRY: { idFromName: () => id, get: () => stub } } as unknown as typeof env;
  const initialize = (value: string) => worker.fetch(request("/" + value + "/mcp"), localEnv, {} as ExecutionContext);
  const before = await initialize(original);
  expect(before.status).toBe(200);
  await before.text();
  await runInDurableObject(stub, registry => {
    expect(registry.rotateMcpClient("http-client", nextVerifier, "test", Date.now())).toMatchObject({ active_runner_id: "retained-runner", scopes: [...scopes] });
  });
  const rejected = await initialize(original);
  expect(rejected.status).toBe(404);
  const rejection = await rejected.json();
  const unknown = await initialize(secret);
  expect(await unknown.json()).toEqual(rejection);
  const after = await initialize(replacement);
  expect(after.status).toBe(200);
  const text = await after.text();
  const reply = JSON.parse(after.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").find(line => line.startsWith("data:"))!.slice(5).trim() : text);
  expect(reply).toMatchObject({ jsonrpc: "2.0", id: "connection-test", result: { protocolVersion: "2025-11-25" } });
  expect(reply.error).toBeUndefined();
  const large = await worker.fetch(new Request("https://worker.test/" + replacement + "/mcp", { method: "POST", body: "x".repeat(MAX_MCP_BODY_BYTES + 1) }), localEnv, {} as ExecutionContext);
  expect(large.status).toBe(413);
  expect(await large.json()).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "request body too large" } });
  await runInDurableObject(stub, registry => { registry.revokeMcpClient("http-client", Date.now()); });
  const revoked = await initialize(replacement);
  expect(revoked.status).toBe(404);
  expect(await revoked.json()).toEqual(rejection);
});
