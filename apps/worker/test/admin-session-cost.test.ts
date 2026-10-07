import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { internalHeaders } from "../src/security.js";

const secret = "test-internal-control-secret-not-for-production";
const sessionHash = "a".repeat(64), csrfHash = "b".repeat(64);
async function signed(path: string, input: Record<string, unknown>, timestamp = Date.now()): Promise<Request> {
  const body = JSON.stringify(input);
  return new Request("https://registry.internal" + path, { method: "POST", body,
    headers: await internalHeaders(secret, "POST", path, body, { timestamp }) });
}

it("repeated administrator session checks perform zero SQL writes", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName("admin-cost-" + crypto.randomUUID()));
  await runInDurableObject(stub, async (instance, state) => {
    const now = Date.now();
    instance.setupAdmin("synthetic-admin", now);
    expect(instance.createAdminSession(sessionHash, csrfHash, now + 60_000, now, 1)).toBe(true);
    const original = state.storage.sql.exec.bind(state.storage.sql);
    let rows = 0;
    const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((query: string, ...args: any[]) => {
      const cursor = original(query, ...args); rows += cursor.rowsWritten; return cursor;
    });
    try {
      for (let n = 0; n < 40; n++) {
        const response = await instance.fetch(await signed("/auth/sessions/verify", { session_hash: sessionHash }));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ csrf_hash: csrfHash });
      }
      console.log(JSON.stringify({ scenario: "admin_session_checks_40", sql_rows_written: rows }));
      expect(rows).toBe(0);
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM internal_request_nonces").one().n).toBe(0);
    } finally { spy.mockRestore(); }
  });
});

it("single-client administration reads one row in a populated library and retains revoked records", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName("client-detail-cost-" + crypto.randomUUID()));
  await runInDurableObject(stub, async (instance, state) => {
    state.storage.sql.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000)
      INSERT INTO mcp_clients(client_id,label,secret_verifier,secret_prefix,scopes_json,secret_version,created_at_ms,updated_at_ms)
      SELECT printf('client%04d',x),'Client',printf('%064d',x),'test','["coding:read"]',1,x,x FROM n`);
    const path = "/auth/clients/client0500";
    const read = async (target = path) => instance.fetch(new Request("https://registry.internal" + target, {
      headers: await internalHeaders(secret, "GET", target, ""),
    }));
    const original = state.storage.sql.exec.bind(state.storage.sql);
    let reads = 0, writes = 0;
    const sql = vi.spyOn(state.storage.sql, "exec").mockImplementation((query: string, ...args: SqlStorageValue[]) => {
      const cursor = original(query, ...args); reads += cursor.rowsRead; writes += cursor.rowsWritten; return cursor;
    });
    try {
      const response = await read();
      expect(response.status).toBe(200);
      const value = await response.json();
      expect(value).toMatchObject({ client_id: "client0500", revoked_at_ms: null });
      expect(value).not.toHaveProperty("secret_verifier");
      expect(reads).toBe(1); expect(writes).toBe(0);
      expect(sql).toHaveBeenCalledTimes(1);
    } finally { sql.mockRestore(); }
    instance.revokeMcpClient("client0500", Date.now());
    const revoked = await read();
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ client_id: "client0500", revoked_at_ms: expect.any(Number) });
    expect((await read("/auth/clients/missing")).status).toBe(404);
    expect((await instance.fetch(new Request("https://registry.internal" + path))).status).toBe(404);
    expect((await read(path + "/unexpected")).status).toBe(404);
    const outage = vi.spyOn(state.storage.sql, "exec").mockImplementation(() => { throw new Error("synthetic client storage outage"); });
    try { expect((await read()).status).toBe(503); }
    finally { outage.mockRestore(); }
  });
});

it.each(["logout", "expiry", "password"] as const)("session-check replay revalidates %s without granting authority", async reason => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName("admin-replay-" + crypto.randomUUID()));
  await runInDurableObject(stub, async instance => {
    const now = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      instance.setupAdmin("synthetic-admin", now);
      instance.createAdminSession(sessionHash, csrfHash, now + 60_000, now, 1);
      const request = await signed("/auth/sessions/verify", { session_hash: sessionHash });
      expect((await instance.fetch(request.clone())).status).toBe(200);
      expect((await instance.fetch(request.clone())).status).toBe(200);
      if (reason === "logout") instance.logoutAdminSession(sessionHash);
      else if (reason === "password") instance.changeAdminPassword("synthetic-replacement", now);
      else clock.mockReturnValue(now + 60_000);
      expect((await instance.fetch(request.clone())).status).toBe(404);
    } finally { clock.mockRestore(); }
  });
});

it("session reads retain HMAC validation while session mutations retain nonce protection", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName("admin-proof-" + crypto.randomUUID()));
  await runInDurableObject(stub, async instance => {
    const now = Date.now();
    instance.setupAdmin("synthetic-admin", now);
    instance.createAdminSession(sessionHash, csrfHash, now + 60_000, now, 1);
    const path = "/auth/sessions/verify", body = JSON.stringify({ session_hash: sessionHash });
    const proof = await signed(path, { session_hash: sessionHash });
    expect((await instance.fetch(new Request("https://registry.internal" + path, { method: "POST", body }))).status).toBe(404);
    expect((await instance.fetch(new Request(proof.url, { method: "POST", headers: proof.headers, body: JSON.stringify({ session_hash: "c".repeat(64) }) }))).status).toBe(404);
    expect((await instance.fetch(await signed(path, { session_hash: sessionHash }, now - 300_001))).status).toBe(404);
    const logout = await signed("/auth/sessions/logout", { session_hash: sessionHash });
    expect((await instance.fetch(logout.clone())).status).toBe(204);
    expect((await instance.fetch(logout.clone())).status).toBe(404);
  });
});

it("session reads survive nonce write exhaustion but mutations report storage unavailability", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName("admin-quota-" + crypto.randomUUID()));
  await runInDurableObject(stub, async (instance, state) => {
    const now = Date.now();
    instance.setupAdmin("synthetic-admin", now);
    instance.createAdminSession(sessionHash, csrfHash, now + 60_000, now, 1);
    const original = state.storage.sql.exec.bind(state.storage.sql);
    const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((query: string, ...args: any[]) => {
      if (query.startsWith("INSERT INTO internal_request_nonces")) throw new Error("synthetic write quota");
      return original(query, ...args);
    });
    try {
      expect((await instance.fetch(await signed("/auth/sessions/verify", { session_hash: sessionHash }))).status).toBe(200);
      expect((await instance.fetch(await signed("/auth/sessions/logout", { session_hash: sessionHash }))).status).toBe(503);
      expect(instance.verifyAdminSession(sessionHash, now)).toBeDefined();
    } finally { spy.mockRestore(); }
  });
});
