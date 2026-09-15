import { expect, it } from "vitest";
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
