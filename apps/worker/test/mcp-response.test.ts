import { afterEach, expect, it, vi } from "vitest";
import { primeMcpResponse } from "../src/http/mcp-response.js";

afterEach(() => vi.restoreAllMocks());
const headers = { "content-type": "text/event-stream", "access-control-allow-origin": "*", "cache-control": "no-store" };
const encode = (text: string) => new TextEncoder().encode(text);

it("waits for the first bytes and preserves delayed SSE frames in order", async () => {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { source = controller; } }), { headers });
  let ready = false;
  const pending = primeMcpResponse(response, { id: 7 }).then(value => { ready = true; return value; });
  await Promise.resolve();
  expect(ready).toBe(false);
  source.enqueue(new Uint8Array());
  await Promise.resolve();
  expect(ready).toBe(false);
  source.enqueue(encode('event: message\ndata: {"id":7,'));
  const result = await pending;
  expect(result.status).toBe(200);
  expect(result.headers.get("access-control-allow-origin")).toBe("*");
  source.enqueue(encode('"result":{}}\n\n'));
  source.close();
  expect(await result.text()).toBe('event: message\ndata: {"id":7,"result":{}}\n\n');
  expect(response.body!.locked).toBe(false);
});

it.each(["empty", "error", "absent"])("returns a correlated failure for an %s SSE source without retrying", async mode => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const response = new Response(mode === "absent" ? null : new ReadableStream<Uint8Array>({ start(controller) {
    if (mode === "error") controller.error(new Error("sensitive-source-message")); else controller.close();
  } }), { headers: { ...headers, "content-length": "0" } });
  const result = await primeMcpResponse(response, { id: "request-1", params: { secret: "never-log" } });
  expect(result.status).toBe(502);
  expect(result.headers.get("content-type")).toBe("application/json");
  expect(result.headers.get("content-length")).toBeNull();
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(result.headers.get("access-control-allow-origin")).toBe("*");
  expect(await result.json()).toMatchObject({ jsonrpc: "2.0", id: "request-1", error: { code: -32603, message: expect.stringContaining("outcome is unknown") } });
  expect(warn).toHaveBeenCalledExactlyOnceWith({ event: "mcp_response_unavailable", reason: mode === "error" ? "stream_error" : "empty_stream" });
  expect(response.body?.locked ?? false).toBe(false);
});

it("propagates cancellation to the original SDK stream", async () => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encode(": keepalive\n\n")); }, cancel }), { headers });
  const result = await primeMcpResponse(response, { id: 1 });
  await result.body!.cancel("client stopped");
  expect(cancel).toHaveBeenCalledExactlyOnceWith("client stopped");
  expect(response.body!.locked).toBe(false);
});

it("preserves stream failures after headers without inventing a success result", async () => {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(c) { source = c; c.enqueue(encode(": keepalive\n\n")); } }), { headers });
  const result = await primeMcpResponse(response, { id: 1 });
  const reader = result.body!.getReader();
  await reader.read();
  source.error(new Error("late failure"));
  await expect(reader.read()).rejects.toThrow("late failure");
  expect(response.body!.locked).toBe(false);
});

it.each([202, 400, 405, 503])("leaves HTTP %s protocol responses unchanged", async status => {
  const response = new Response(null, { status, headers });
  expect(await primeMcpResponse(response, undefined)).toBe(response);
});

it("leaves ordinary JSON responses unchanged", async () => {
  const response = Response.json({ jsonrpc: "2.0", id: 0, result: {} });
  expect(await primeMcpResponse(response, { id: 0 })).toBe(response);
});
