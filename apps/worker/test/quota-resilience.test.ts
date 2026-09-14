import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { ensureHistoryRetentionSchema, pruneHistory } from "../src/history-retention.js";
import { FIXED_RELEASE_VERSION } from "../src/installer.js";

it("MCP storage failures and malformed replies are 503, never invalid-secret 404", async () => {
  for (const result of [503, 429, 500, 404, "malformed", "throw"] as const) {
    const fetch = vi.fn(async () => {
      if (result === "throw") throw new Error("synthetic DO constructor quota failure");
      return result === "malformed" ? Response.json({}) : new Response("unavailable", { status: result });
    });
    const brokenEnv = { ...env, REGISTRY: { idFromName: () => "test", get: () => ({ fetch }) } } as unknown as typeof env;
    const response = await worker.fetch(new Request(`https://quota.invalid/${"q".repeat(43)}/mcp`), brokenEnv, {} as ExecutionContext);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).not.toContain("q".repeat(43));
  }
});

it("an authoritative invalid MCP credential still returns 404", async () => {
  const bad = { ...env, REGISTRY: { idFromName: () => "test", get: () => ({ fetch: async () => new Response(null, { status: 401 }) }) } } as unknown as typeof env;
  expect((await worker.fetch(new Request(`https://quota.invalid/${"q".repeat(43)}/mcp`), bad, {} as ExecutionContext)).status).toBe(404);
});

it("public health and signed distribution never construct an unavailable Registry", async () => {
  const get = vi.fn(() => { throw new Error("storage unavailable"); });
  const independent = { ...env, RUNMESH_TEST_MODE: undefined, RUNMESH_PUBLIC_ORIGIN: "https://quota.invalid", RUNMESH_SIGNED_RELEASE_AVAILABLE: FIXED_RELEASE_VERSION,
    REGISTRY: { idFromName: () => "test", get } } as unknown as typeof env;
  for (const path of ["/health", "/runner/releases/latest", "/runner/install.sh", "/runner/install.ps1", "/runner/uninstall.sh"]) {
    const response = await worker.fetch(new Request(`https://quota.invalid${path}`, { headers: { host: "quota.invalid" } }), independent, {} as ExecutionContext);
    expect(response.status, path).toBe(200);
  }
  expect(get).not.toHaveBeenCalled();
});

it("bounded audit retention preserves the cap, counts overwrites once, and rolls back atomically", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`quota-history-${crypto.randomUUID()}`));
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    state.storage.transactionSync(() => {
      sql.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1200)
        INSERT INTO mcp_calls SELECT 'r', printf('c-%04d',x), '{}', x FROM n`);
      pruneHistory(sql, "audit", "r", 1000);
    });
    expect(sql.exec("SELECT call_id FROM mcp_calls WHERE runner_id='r' ORDER BY completed_at_ms LIMIT 1").toArray()).toEqual([{ call_id: "c-0201" }]);
    expect(sql.exec("SELECT total FROM history_retention_counts WHERE kind='audit' AND runner_id='r'").toArray()).toEqual([{ total: 1000 }]);
    sql.exec("INSERT INTO mcp_calls VALUES ('r','c-1200','{}',2000) ON CONFLICT(runner_id,call_id) DO UPDATE SET completed_at_ms=excluded.completed_at_ms");
    expect(sql.exec("SELECT total FROM history_retention_counts WHERE kind='audit' AND runner_id='r'").one().total).toBe(1000);
    expect(() => state.storage.transactionSync(() => { sql.exec("DELETE FROM mcp_calls WHERE runner_id='r'"); throw new Error("rollback"); })).toThrow("rollback");
    expect(sql.exec("SELECT total FROM history_retention_counts WHERE kind='audit' AND runner_id='r'").one().total).toBe(1000);
    state.storage.transactionSync(() => ensureHistoryRetentionSchema(sql));
    expect(sql.exec("SELECT COUNT(*) AS n FROM mcp_calls WHERE runner_id='r'").one().n).toBe(1000);
  });
});

it("retention hot paths use constant reads at 1000 retained rows and do not prune active jobs", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`quota-rows-${crypto.randomUUID()}`));
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000)
      INSERT INTO jobs SELECT 'r', printf('j-%04d',x), '{"status":"succeeded"}', x FROM n`);
    sql.exec("INSERT INTO jobs VALUES ('r','active','{\"status\":\"running\"}',0)");
    const baseline = sql.exec("SELECT job_id, job_json FROM jobs WHERE runner_id='r' ORDER BY updated_at_ms DESC, job_id DESC");
    baseline.toArray();
    const oldReads = baseline.rowsRead;
    const cursors: Array<{ readonly rowsRead: number }> = [];
    const original = sql.exec.bind(sql);
    const spy = vi.spyOn(sql, "exec").mockImplementation((query: string, ...args: any[]) => {
      const cursor = original(query, ...args); cursors.push(cursor); return cursor;
    });
    try { pruneHistory(sql, "terminal_job", "r", 1000); }
    finally { spy.mockRestore(); }
    const reads = cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0);
    expect(reads).toBeLessThanOrEqual(4);
    expect(oldReads).toBeGreaterThanOrEqual(1000);
    console.log(JSON.stringify({ scenario: "terminal_retention_1000", old_rows_read: oldReads, new_rows_read: reads }));
    sql.exec("UPDATE jobs SET job_json='{\"status\":\"succeeded\"}', updated_at_ms=2000 WHERE job_id='active'");
    pruneHistory(sql, "terminal_job", "r", 1000);
    expect(sql.exec("SELECT COUNT(*) AS n FROM jobs WHERE runner_id='r'").one().n).toBe(1000);
    expect(sql.exec("SELECT total FROM history_retention_counts WHERE kind='terminal_job' AND runner_id='r'").one().total).toBe(1000);
  });
});


it("structural validation uses supported SQLite metadata and rejects a missing required table", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`schema-contract-${crypto.randomUUID()}`));
  await runInDurableObject(stub, (instance, state) => {
    const spy = vi.spyOn(state.storage.sql, "exec");
    try {
      expect((instance as any).schemaIsCurrent()).toBe(true);
      expect(spy.mock.calls.some(([query]) => /PRAGMA schema_version/i.test(query))).toBe(false);
    } finally { spy.mockRestore(); }
    state.storage.sql.exec("DROP TABLE client_runner_overrides");
    expect((instance as any).schemaIsCurrent()).toBe(false);
  });
});
