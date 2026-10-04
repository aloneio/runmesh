import { afterEach, expect, it, vi } from "vitest";
import { boundedJsonReceipt } from "../src/bounded-json.js";
import { hmacHex, internalHeaders, sha256Hex, verifyInternalRequest } from "../src/security.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("does not allocate the full wire limit for a small internal JSON receipt", async () => {
  const response = Response.json({ ok: true });
  const sizes: number[] = [];
  const Original = Uint8Array;
  vi.stubGlobal("Uint8Array", new Proxy(Original, {
    construct(target, args, newTarget) {
      if (typeof args[0] === "number") sizes.push(args[0]);
      return Reflect.construct(target, args, newTarget);
    },
  }));
  expect(await boundedJsonReceipt(async () => response, [200], 5000, 1048576)).toEqual({ status: 200, value: { ok: true } });
  expect(Math.max(0, ...sizes)).toBeLessThanOrEqual(8192);
});

it("grows only for received bytes and preserves split UTF-8 at the exact limit", async () => {
  const value = { text: "中😀".repeat(3000) };
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === encoded.length) { controller.close(); return; }
      const end = Math.min(offset + 997, encoded.length);
      controller.enqueue(encoded.slice(offset, end)); offset = end;
    },
  });
  expect(await boundedJsonReceipt(async () => new Response(body, { headers: { "content-length": "1" } }), [200], 5000, encoded.length)).toEqual({ status: 200, value });
  expect(await boundedJsonReceipt(async () => new Response(encoded), [200], 5000, encoded.length - 1)).toBeUndefined();
});

it("releases a fully consumed receipt without aborting an already completed request", async () => {
  const response = Response.json({ ok: true }), onAbort = vi.fn();
  const result = await boundedJsonReceipt(async signal => {
    signal.addEventListener("abort", onAbort, { once: true });
    return response;
  }, [200]);
  expect(result).toEqual({ status: 200, value: { ok: true } });
  expect(onAbort).not.toHaveBeenCalled();
  expect(response.body?.locked).toBe(false);
});

it("does not retain aliases when a response source reuses its chunk buffer", async () => {
  const chunk = new Uint8Array(1), text = '{"value":"safe"}';
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === text.length) { controller.close(); return; }
    chunk[0] = text.charCodeAt(offset++); controller.enqueue(chunk);
  } }, { highWaterMark: 0 });
  expect(await boundedJsonReceipt(async () => new Response(body), [200], 5000, 1048576)).toEqual({ status: 200, value: { value: "safe" } });
});

it("reuses a completed signing key while signatures still bind each message", async () => {
  const secret = "cost-regression-shared-signing-key-0123456789";
  const importKey = vi.spyOn(crypto.subtle, "importKey");
  const first = await hmacHex(secret, "one");
  const second = await hmacHex(secret, "two");
  expect(first).toMatch(/^[0-9a-f]{64}$/u);
  expect(second).not.toBe(first);
  expect(await hmacHex(secret, "one")).toBe(first);
  expect(importKey).toHaveBeenCalledTimes(1);
});

it("isolates concurrent key rotation and still consumes each signed nonce once", async () => {
  const oldSecret = "cost-rotation-original-key-0123456789", newSecret = "cost-rotation-replaced-key-0123456789";
  const old = await hmacHex(oldSecret, "value"), current = await hmacHex(newSecret, "value");
  expect(old).not.toBe(current);
  expect(await Promise.all([hmacHex(oldSecret, "value"), hmacHex(newSecret, "value"), hmacHex(oldSecret, "value")])).toEqual([old, current, old]);
  const body = '{"ok":true}', path = "/auth/mcp/authorize-rpc";
  const headers = await internalHeaders(newSecret, "POST", path, body);
  const request = () => new Request("https://registry.internal" + path, { method: "POST", headers, body });
  const nonces = new Set<string>();
  const consume = (nonce: string) => { if (nonces.has(nonce)) return false; nonces.add(nonce); return true; };
  expect(await verifyInternalRequest(request(), oldSecret, body, consume)).toBe(false);
  expect(await verifyInternalRequest(request(), newSecret, body, consume)).toBe(true);
  expect(await verifyInternalRequest(request(), newSecret, body, consume)).toBe(false);
  expect(await verifyInternalRequest(request(), newSecret, '{"ok":false}', () => true)).toBe(false);
});

it("keeps standard digest and signing vectors unchanged", async () => {
  expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(await hmacHex("key", "The quick brown fox jumps over the lazy dog")).toBe("f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
});

it("does not cache a failed key import", async () => {
  const secret = "cost-failed-import-key-0123456789";
  const imported = vi.spyOn(crypto.subtle, "importKey").mockRejectedValueOnce(new Error("temporary import failure"));
  await expect(hmacHex(secret, "value")).rejects.toThrow("temporary import failure");
  const result = await hmacHex(secret, "value");
  expect(await hmacHex(secret, "value")).toBe(result);
  expect(imported).toHaveBeenCalledTimes(2);
});
