import { expect, it, vi } from "vitest";
import { readCappedBytes, readCappedFormData } from "../src/body.js";
import { discardBody } from "../src/http/request.js";

function request(body: ReadableStream<Uint8Array>, options: RequestInit = {}): Request {
  return new Request("https://body.test/", { method: "POST", body, duplex: "half", ...options } as RequestInit);
}

it("bounds an upload that never produces a chunk and does not await a stalled cancellation", async () => {
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  expect(await readCappedBytes(request(new ReadableStream({ cancel })), 1024, 10)).toBeUndefined();
  expect(cancel).toHaveBeenCalledOnce();
});

it("cancels an aborted request immediately without waiting for the upload deadline", async () => {
  const controller = new AbortController(), cancel = vi.fn();
  const pending = readCappedBytes(request(new ReadableStream({ cancel }), { signal: controller.signal }), 1024);
  controller.abort();
  expect(await pending).toBeUndefined(); expect(cancel).toHaveBeenCalledOnce();
});

it("bounds empty chunks even when microtasks prevent its timer from firing", async () => {
  let pulls = 0;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array()); }, cancel });
  expect(await readCappedBytes(request(body), 1024)).toBeUndefined();
  expect(pulls).toBeLessThanOrEqual(1026); expect(cancel).toHaveBeenCalledOnce();
});

it("accepts fragmented content and returns an exact backing buffer for MCP forwarding", async () => {
  let value = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    if (value === 20_000) controller.close();
    else { controller.enqueue(Uint8Array.of(value % 251)); value++; }
  } });
  const bytes = await readCappedBytes(request(body), 32_768);
  expect(bytes?.byteLength).toBe(20_000); expect(bytes?.buffer.byteLength).toBe(20_000);
  expect(bytes?.[19_999]).toBe(19_999 % 251);
});

it.each(["data", "eof"])("rejects late upload %s even before the deadline timer runs", async phase => {
  let clock = 0, reads = 0;
  const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
  try {
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (reads++ === 0) { if (phase === "data") clock = 10; controller.enqueue(Uint8Array.of(1)); }
      else { clock = 10; controller.close(); }
    } }, { highWaterMark: 0 });
    expect(await readCappedBytes(request(body), 32, 10)).toBeUndefined();
  } finally { now.mockRestore(); }
});

it("discards a rejected body without awaiting its underlying cancellation", async () => {
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  await discardBody(request(new ReadableStream({ cancel })));
  expect(cancel).toHaveBeenCalledOnce();
});

it("retains form decoding with the exact bounded bytes", async () => {
  const form = await readCappedFormData(new Request("https://body.test/", { method: "POST", body: new URLSearchParams({ label: "测试", csrf_token: "token" }) }), 1024);
  expect(form?.get("label")).toBe("测试"); expect(form?.get("csrf_token")).toBe("token");
});
