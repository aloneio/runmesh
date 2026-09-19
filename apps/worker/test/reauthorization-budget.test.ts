import { expect, it, vi } from "vitest";
import { reauthorizePrincipal } from "../src/mcp/reauthorization.js";
import { failureMetadata } from "@aloneio/runmesh-protocol";

const identity = { client_id: "client", secret_version: 1 };
const allowed = () => Response.json({ ...identity, scopes: ["coding:read"], token: "private-token" });

it("AR02 projects only valid current scopes and makes one request", async () => {
  let calls = 0;
  expect(await reauthorizePrincipal(async () => { calls++; return allowed(); }, identity))
    .toEqual({ state: "allowed", scopes: ["coding:read"] });
  expect(calls).toBe(1);
});
it("AR02 network timeout aborts without a retry or cached allow", async () => {
  let signal: AbortSignal | undefined, calls = 0;
  const result = await reauthorizePrincipal(input => { signal = input; calls++; return new Promise(() => {}); }, identity, 10);
  expect(result).toEqual({ state: "unavailable" }); expect(signal?.aborted).toBe(true); expect(calls).toBe(1);
});
it("AR02 timeout also bounds a stalled response body and cancels it", async () => {
  let cancelled = false;
  const result = await reauthorizePrincipal(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })), identity, 10);
  expect(result).toEqual({ state: "unavailable" }); expect(cancelled).toBe(true);
});
it("AR02 empty fragments cannot bypass byte limits indefinitely", async () => {
  let pulls = 0, cancelled = false;
  const result = await reauthorizePrincipal(async () => new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(0)); }, cancel() { cancelled = true; },
  })), identity);
  expect(result).toEqual({ state: "malformed" }); expect(pulls).toBeLessThanOrEqual(258); expect(cancelled).toBe(true);
});
it("AR02 a failed status with an apparently valid body cannot grant access", async () => {
  expect(await reauthorizePrincipal(async () => new Response(JSON.stringify({ ...identity, scopes: ["coding:exec"] }), { status: 503 }), identity)).toEqual({ state: "unavailable" });
});
it("AR02 malformed UTF-8 and failed streams do not grant or claim revocation", async () => {
  expect(await reauthorizePrincipal(async () => new Response(new Uint8Array([255])), identity)).toEqual({ state: "malformed" });
  expect(await reauthorizePrincipal(async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("private-value")); } })), identity)).toEqual({ state: "unavailable" });
});
it("AR02 unknown mutation outcomes never advertise a direct retry", () => {
  expect(failureMetadata("internal_error")).toMatchObject({ operation_state: "unknown", next_action: "contact_operator" });
  expect(failureMetadata("registry_unavailable", "not_started")).toMatchObject({ operation_state: "not_started", next_action: "wait_and_retry" });
  expect(failureMetadata("authorization_response_invalid")).toMatchObject({ operation_state: "not_started", next_action: "contact_operator" });
});

it.each([200, 401, 403, 404])("AR02 rejects a late fetch receipt (%s) even before the timeout callback runs", async status => {
  let clock = 0, signal: AbortSignal | undefined, calls = 0;
  const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
  try {
    const result = await reauthorizePrincipal(async input => {
      signal = input; calls++; clock = 10;
      return status === 200 ? allowed() : new Response("synthetic late denial", { status });
    }, identity, 10);
    expect(result).toEqual({ state: "unavailable" }); expect(signal?.aborted).toBe(true); expect(calls).toBe(1);
  } finally { now.mockRestore(); }
});

it.each(["data", "empty", "eof"])("AR02 rechecks its deadline after reading %s, including the final read", async phase => {
  let clock = 0, reads = 0;
  const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
  const bytes = new TextEncoder().encode(JSON.stringify({ ...identity, scopes: ["coding:read"] }));
  const stream = new ReadableStream<Uint8Array>({ pull(controller) {
    reads++;
    if (phase === "empty" && reads === 1) { clock = 10; controller.enqueue(new Uint8Array()); return; }
    if (reads === (phase === "empty" ? 2 : 1)) {
      if (phase === "data") clock = 10;
      controller.enqueue(bytes); return;
    }
    clock = 10; controller.close();
  } }, { highWaterMark: 0 });
  try {
    expect(await reauthorizePrincipal(async () => new Response(stream), identity, 10)).toEqual({ state: "unavailable" });
  } finally { now.mockRestore(); }
});
