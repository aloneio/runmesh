import assert from "node:assert/strict";
import { test } from "node:test";
import { probeUiNavigationServer, uiNavigationDiagnosticMarker, uiNavigationFailureDiagnostic } from "../scripts/ui-browser-diagnostics.mjs";

test("navigation failure probes distinguish a responsive Worker from an unavailable admin read", async () => {
  const calls = [], cancelled = [];
  const result = await probeUiNavigationServer("http://127.0.0.1:4321", "private-cookie", { fetchImpl: async (url, init) => {
    calls.push({ path: url.pathname, init });
    return new Response(new ReadableStream({ cancel() { cancelled.push(url.pathname); } }), { status: url.pathname === "/health" ? 200 : 503 });
  } });
  assert.deepEqual(result, { health: { state: "response", status: 200 }, clients: { state: "response", status: 503 } });
  assert.deepEqual(calls.map(call => call.path), ["/health", "/admin/clients"]);
  assert.deepEqual(calls[0].init.headers, {});
  assert.deepEqual(calls[1].init.headers, { cookie: "private-cookie" });
  assert.ok(calls.every(call => call.init.redirect === "manual"));
  assert.deepEqual(cancelled, ["/health", "/admin/clients"]);
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("navigation failure probes remain bounded when fetch ignores abort and body cleanup stalls", async () => {
  const signals = [];
  const result = await probeUiNavigationServer("http://127.0.0.1:4321", "private-cookie", { timeoutMs: 20, fetchImpl: async (url, init) => {
    signals.push(init.signal);
    if (url.pathname === "/health") return new Promise(() => {});
    return new Response(new ReadableStream({ cancel: () => new Promise(() => {}) }));
  } });
  assert.deepEqual(result, { health: { state: "timeout", status: null }, clients: { state: "response", status: 200 } });
  assert.ok(signals.every(signal => signal.aborted));
});

test("navigation failure probes retain fixed network classes and validate their local destination", async () => {
  const result = await probeUiNavigationServer("http://127.0.0.1:4321", "private-cookie", { fetchImpl: async () => { throw new Error("private diagnostic"); } });
  assert.deepEqual(result, { health: { state: "network_error", status: null }, clients: { state: "network_error", status: null } });
  await assert.rejects(probeUiNavigationServer("https://example.com", "private-cookie"), /local fixture/u);
});

test("navigation evidence validates probe fields and omits response and credential payloads", () => {
  const diagnostic = { locale: "en", phase: "headers_pending", status: null, elapsed_ms: 5000, exception_count: 0,
    server_probes: { health: { state: "response", status: 200 }, clients: { state: "timeout", status: null } } };
  assert.deepEqual(uiNavigationFailureDiagnostic(uiNavigationDiagnosticMarker({ ...diagnostic, server_probes: {
    health: { ...diagnostic.server_probes.health, cookie: "private" }, clients: { ...diagnostic.server_probes.clients, body: "private" },
  } })), diagnostic);
  for (const invalid of [{ state: "response", status: null }, { state: "response", status: 999 }, { state: "timeout", status: 200 }, { state: "private", status: null }]) {
    assert.equal(uiNavigationFailureDiagnostic(uiNavigationDiagnosticMarker({ ...diagnostic, server_probes: { ...diagnostic.server_probes, clients: invalid } })), undefined);
  }
});
