import { env } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { handleMcpSecret } from "../src/http/mcp.js";
import { primeMcpResponse } from "../src/http/mcp-response.js";
import { createMcpDiagnostics, mcpDiagnostics, observeMcpResponse } from "../src/platform/mcp-diagnostics.js";
import type { WorkerEnv } from "../src/platform/env.js";

afterEach(() => vi.restoreAllMocks());
const encode = (value: string) => new TextEncoder().encode(value);

it("keeps concurrent request phases and timings independent without retaining caller values", () => {
  let now = 0;
  const diagnostics = createMcpDiagnostics(() => now);
  const first = diagnostics.begin("1")!; first.classify("read"); first.mark("identity");
  now = 5;
  const second = diagnostics.begin("1")!; second.classify("job", "get"); second.mark("setup");
  now = 10; first.mark("body"); first.toolStage("reauth"); first.dependency("reauth", "sign");
  now = 20; second.mark("priming"); first.dependency("reauth", "fetch");
  now = 30; first.dependency("none", "none"); first.toolStage("action");
  expect(diagnostics.snapshot("1")!.active).toMatchObject([
    { sequence: 1, tool: "read", stage: "body", tool_stage: "action", elapsed_ms: 30 },
    { sequence: 2, tool: "job_get", stage: "priming", tool_stage: "none", elapsed_ms: 25 },
  ]);
  now = 40; first.finish("eof"); second.finish("error");
  const snapshot = diagnostics.snapshot("1")!;
  expect(snapshot.active).toEqual([]);
  expect(snapshot.recent[0]).toMatchObject({ timing: { identity: 10, reauth: 20, action: 10, registry_sign: 10, registry_fetch: 10, total: 40 } });
  expect(snapshot.recent[1]).toMatchObject({ stage: "priming", timing: { setup: 15, priming: 20, total: 35 } });
  first.classify("private-path?secret=value"); first.finish("error");
  now = 1000;
  expect(first.serverTiming()).toContain("rm_total;dur=40");
  expect(diagnostics.snapshot("1")!.finished).toBe(2);
  expect(JSON.stringify(diagnostics.snapshot("1"))).not.toContain("private");
});

it("bounds active/recent storage, duration values and each exported record", () => {
  let now = 0;
  const diagnostics = createMcpDiagnostics(() => now);
  const traces = Array.from({ length: 40 }, () => diagnostics.begin("1"));
  expect(diagnostics.snapshot("1")).toMatchObject({ entered: 40, dropped: 8 });
  expect(diagnostics.snapshot("1")!.active).toHaveLength(32);
  now = 1e20;
  for (const trace of traces) { trace?.classify({ secret: "private" }, "private"); trace?.finish("eof"); }
  const snapshot = diagnostics.snapshot("1")!;
  expect(snapshot.active).toHaveLength(0); expect(snapshot.recent).toHaveLength(16);
  expect(snapshot.recent.every(entry => entry.elapsed_ms === 900000 && entry.tool === "other" && JSON.stringify(entry).length <= 768)).toBe(true);
  expect(JSON.stringify(snapshot)).not.toContain("private");
});

it.each([undefined, "0", "true", "private-mode"])("adds no observation or response wrapping outside exact test mode %s", mode => {
  const diagnostics = createMcpDiagnostics();
  const response = new Response("body");
  expect(observeMcpResponse(response, diagnostics.begin(mode))).toBe(response);
  expect(response.body!.locked).toBe(false);
  expect(response.headers.has("server-timing")).toBe(false);
  expect(diagnostics.snapshot(mode)).toBeUndefined();
  expect(diagnostics.snapshot("1")).toMatchObject({ entered: 0, finished: 0, active: [], recent: [] });
});

it("passes every chunk exactly once with backpressure and frees activity at EOF", async () => {
  const diagnostics = createMcpDiagnostics();
  const trace = diagnostics.begin("1")!;
  trace.mark("priming");
  let pulls = 0;
  const source = new ReadableStream<Uint8Array>({ pull(controller) {
    pulls++;
    if (pulls < 3) controller.enqueue(encode(String(pulls))); else controller.close();
  } }, { highWaterMark: 0 });
  const response = observeMcpResponse(new Response(source, { status: 201, headers: { "x-preserved": "yes" } }), trace);
  expect(response.status).toBe(201); expect(response.headers.get("x-preserved")).toBe("yes");
  expect(response.headers.get("server-timing")).toMatch(/^rm_identity;dur=\d+/);
  await Promise.resolve(); expect(pulls).toBe(0);
  const reader = response.body!.getReader();
  expect(await reader.read()).toEqual({ done: false, value: encode("1") });
  await Promise.resolve(); expect(pulls).toBe(1);
  expect(await reader.read()).toEqual({ done: false, value: encode("2") });
  expect(await reader.read()).toEqual({ done: true, value: undefined });
  expect(source.locked).toBe(false);
  expect(diagnostics.snapshot("1")).toMatchObject({ finished: 1, active: [], recent: [{ outcome: "eof", stage: "stream" }] });
});

it("forwards cancellation once and releases its active observation", async () => {
  const diagnostics = createMcpDiagnostics(), cancel = vi.fn();
  const source = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
  const response = observeMcpResponse(new Response(source), diagnostics.begin("1"));
  await response.body!.cancel("private-cancel-reason");
  expect(cancel).toHaveBeenCalledExactlyOnceWith("private-cancel-reason");
  expect(source.locked).toBe(false);
  expect(diagnostics.snapshot("1")).toMatchObject({ active: [], recent: [{ outcome: "cancelled" }] });
  expect(JSON.stringify(diagnostics.snapshot("1"))).not.toContain("private");
});

it("propagates the original stream error and releases active state", async () => {
  const diagnostics = createMcpDiagnostics(), failure = new Error("private-stream-failure");
  const source = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(failure); } }, { highWaterMark: 0 });
  const response = observeMcpResponse(new Response(source), diagnostics.begin("1"));
  await expect(response.body!.getReader().read()).rejects.toBe(failure);
  expect(source.locked).toBe(false);
  expect(diagnostics.snapshot("1")).toMatchObject({ active: [], recent: [{ outcome: "error", stage: "stream" }] });
  expect(JSON.stringify(diagnostics.snapshot("1"))).not.toContain("private");
});

it("records cancellation instead of EOF when a body read is pending", async () => {
  const diagnostics = createMcpDiagnostics(), cancel = vi.fn();
  const source = new ReadableStream<Uint8Array>({ pull() {}, cancel }, { highWaterMark: 0 });
  const response = observeMcpResponse(new Response(source), diagnostics.begin("1"));
  const reader = response.body!.getReader();
  const pending = reader.read();
  await Promise.resolve();
  await reader.cancel("private-reason");
  expect(await pending).toEqual({ done: true, value: undefined });
  expect(cancel).toHaveBeenCalledExactlyOnceWith("private-reason");
  expect(diagnostics.snapshot("1")).toMatchObject({ active: [], recent: [{ outcome: "cancelled" }] });
});

it("retains a cancellation rejection without leaving an active record", async () => {
  const diagnostics = createMcpDiagnostics(), failure = new Error("private-cancel-failure");
  const source = new ReadableStream<Uint8Array>({ cancel() { throw failure; } }, { highWaterMark: 0 });
  const response = observeMcpResponse(new Response(source), diagnostics.begin("1"));
  await expect(response.body!.cancel()).rejects.toBe(failure);
  expect(source.locked).toBe(false);
  expect(diagnostics.snapshot("1")).toMatchObject({ active: [], recent: [{ outcome: "error" }] });
});

it("completes bodyless responses immediately", () => {
  const diagnostics = createMcpDiagnostics();
  const response = observeMcpResponse(new Response(null, { status: 202 }), diagnostics.begin("1"));
  expect(response.status).toBe(202); expect(response.body).toBeNull();
  expect(diagnostics.snapshot("1")).toMatchObject({ active: [], recent: [{ outcome: "bodyless" }] });
});

it("records an identity exception at its original boundary", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const diagnostics = createMcpDiagnostics();
  const diagnostic = diagnostics.begin("1")!;
  const request = new Request(`https://worker.test/${"a".repeat(43)}/mcp`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: "private-id", method: "tools/call", params: { name: "read" } }) });
  const failedEnv = { ...env, mcpDiagnostic: diagnostic, REGISTRY: { idFromName: () => "test", get: () => ({ fetch: async () => { throw new Error("private-native-error"); } }) } } as unknown as WorkerEnv;
  await expect(handleMcpSecret(request, failedEnv, new URL(request.url))).rejects.toThrow("control plane temporarily unavailable");
  expect(diagnostics.snapshot("1")).toMatchObject({ active: [], recent: [{ outcome: "error", stage: "identity" }] });
  expect(JSON.stringify(diagnostics.snapshot("1"))).not.toContain("private");
});

it("records priming failure while retaining the existing structured HTTP result", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const diagnostics = createMcpDiagnostics(), diagnostic = diagnostics.begin("1")!;
  diagnostic.mark("priming");
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("private-error")); } }), { headers: { "content-type": "text/event-stream" } });
  const result = await primeMcpResponse(response, { id: "private-id" }, diagnostic);
  expect(result.status).toBe(502);
  expect(diagnostics.snapshot("1")).toMatchObject({ active: [], recent: [{ outcome: "error", stage: "priming" }] });
  expect(JSON.stringify(diagnostics.snapshot("1"))).not.toContain("private");
});

it("keeps production health and MCP responses free of test diagnostics", async () => {
  const before = mcpDiagnostics.snapshot("1")!.entered;
  const production = { ...env, RUNMESH_TEST_MODE: "0" };
  const response = await worker.fetch(new Request("https://worker.test/short/mcp", { method: "POST", body: "{}" }), production, {} as ExecutionContext);
  expect(response.headers.has("server-timing")).toBe(false); await response.text();
  const health = await worker.fetch(new Request("https://worker.test/health"), production, {} as ExecutionContext);
  expect(await health.json()).not.toHaveProperty("mcp_diagnostics");
  expect(mcpDiagnostics.snapshot("1")!.entered).toBe(before);
  const testHealth = await worker.fetch(new Request("https://worker.test/health"), env, {} as ExecutionContext);
  expect(await testHealth.json()).toHaveProperty("mcp_diagnostics.schema_version", 1);
});
