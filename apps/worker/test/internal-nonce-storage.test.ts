import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { internalHeaders, INTERNAL_SIGNATURE_SKEW_MS } from "../src/security.js";

const secret = "test-internal-control-secret-not-for-production";
const path = "/auth/internal-nonces";

async function signedRequest(body: string, options: { path?: string; nonce?: string; timestamp?: number } = {}): Promise<Request> {
  const target = options.path ?? path;
  return new Request("https://registry.internal" + target, {
    method: "POST", body, headers: await internalHeaders(secret, "POST", target, body, {
      ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
      ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }),
    }),
  });
}

it("stores only the original nonce and rejects exact and rewrapped replays without writes", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName("nonce-storage-" + crypto.randomUUID()));
  await runInDurableObject(stub, async (instance, state) => {
    const now = Date.now(), nonce = "a".repeat(64), wrapper = "b".repeat(64);
    const body = JSON.stringify({ nonce, expires_at_ms: now + INTERNAL_SIGNATURE_SKEW_MS });
    const request = await signedRequest(body, { nonce: wrapper });
    const exec = state.storage.sql.exec.bind(state.storage.sql);
    let written = 0;
    const sql = vi.spyOn(state.storage.sql, "exec").mockImplementation((query: string, ...args: any[]) => {
      const result = exec(query, ...args); written += result.rowsWritten; return result;
    });
    try {
      expect((await instance.fetch(request.clone())).status).toBe(204);
      expect(state.storage.sql.exec("SELECT nonce FROM internal_request_nonces").toArray()).toEqual([{ nonce }]);
      expect(written).toBeGreaterThan(0);
      written = 0;
      expect((await instance.fetch(request.clone())).status).toBe(404);
      expect((await instance.fetch(await signedRequest(body))).status).toBe(404);
      expect(written).toBe(0);
      expect(state.storage.sql.exec("SELECT nonce FROM internal_request_nonces").toArray()).toEqual([{ nonce }]);

      const fresh = "c".repeat(64);
      const freshBody = JSON.stringify({ nonce: fresh, expires_at_ms: now + INTERNAL_SIGNATURE_SKEW_MS });
      const competing = await Promise.all([signedRequest(freshBody), signedRequest(freshBody)]);
      const responses = await Promise.all(competing.map(value => instance.fetch(value)));
      expect(responses.map(value => value.status).sort()).toEqual([204, 404]);
      expect(state.storage.sql.exec("SELECT nonce FROM internal_request_nonces ORDER BY nonce").toArray()).toEqual([{ nonce }, { nonce: fresh }]);
    } finally { sql.mockRestore(); }
  });
});

it("keeps wrapper signatures bound to the body, path, query and timestamp", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName("nonce-signatures-" + crypto.randomUUID()));
  await runInDurableObject(stub, async (instance, state) => {
    const now = Date.now(), body = JSON.stringify({ nonce: "a".repeat(64), expires_at_ms: now + INTERNAL_SIGNATURE_SKEW_MS });
    const headers = await internalHeaders(secret, "POST", path, body);
    const request = (target: string, payload: string, signed: HeadersInit = headers) => new Request("https://registry.internal" + target, { method: "POST", body: payload, headers: signed });
    const wrongSignature = new Headers(headers); wrongSignature.set("x-internal-control", "0".repeat(64));
    const attempts = [
      request(path, body.replace("a".repeat(64), "c".repeat(64))),
      request(path + "/", body),
      request(path + "?altered=1", body),
      request(path, body, wrongSignature),
      request(path, body, {}),
      await signedRequest(body, { timestamp: now - INTERNAL_SIGNATURE_SKEW_MS - 1 }),
      await signedRequest(body, { timestamp: now + INTERNAL_SIGNATURE_SKEW_MS + 60_000 }),
      await signedRequest(JSON.stringify({ nonce: "invalid", expires_at_ms: now + INTERNAL_SIGNATURE_SKEW_MS })),
      await signedRequest(JSON.stringify({ nonce: "d".repeat(64), expires_at_ms: now - 1 })),
    ];
    for (const attempt of attempts) expect((await instance.fetch(attempt)).status).toBe(404);
    expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM internal_request_nonces").one().n).toBe(0);
    expect(await state.storage.getAlarm()).toBeNull();
  });
});

it("retains nonce consumption for other mutations and neighboring routes", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName("nonce-mutations-" + crypto.randomUUID()));
  await runInDurableObject(stub, async (instance, state) => {
    const nonce = "a".repeat(64), body = JSON.stringify({ password_verifier: "synthetic-admin" });
    const setup = await signedRequest(body, { path: "/auth/setup", nonce });
    expect((await instance.fetch(setup.clone())).status).toBe(204);
    expect((await instance.fetch(setup.clone())).status).toBe(404);
    expect(state.storage.sql.exec("SELECT nonce FROM internal_request_nonces").toArray()).toEqual([{ nonce }]);
    const neighborNonce = "b".repeat(64);
    expect((await instance.fetch(await signedRequest("{}", { path: path + "/extra", nonce: neighborNonce }))).status).toBe(404);
    expect(state.storage.sql.exec("SELECT nonce FROM internal_request_nonces ORDER BY nonce").toArray()).toEqual([{ nonce }, { nonce: neighborNonce }]);
  });
});

it("schedules cleanup at the original nonce expiry and removes the final alarm", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName("nonce-cleanup-" + crypto.randomUUID()));
  await runInDurableObject(stub, async (instance, state) => {
    const now = Date.now(), expires = now + 60_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const alarm = vi.spyOn(state.storage, "setAlarm");
    try {
      const body = JSON.stringify({ nonce: "a".repeat(64), expires_at_ms: expires });
      expect((await instance.fetch(await signedRequest(body))).status).toBe(204);
      expect(await state.storage.getAlarm()).toBe(expires);
      expect(alarm).toHaveBeenCalledTimes(1);
      expect((await instance.fetch(await signedRequest(body))).status).toBe(404);
      expect(alarm).toHaveBeenCalledTimes(1);
      clock.mockReturnValue(expires);
      await instance.alarm();
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM internal_request_nonces").one().n).toBe(0);
      expect(await state.storage.getAlarm()).toBeNull();
    } finally { alarm.mockRestore(); clock.mockRestore(); }
  });
});
