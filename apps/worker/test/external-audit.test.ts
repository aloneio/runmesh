import { env } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { ExternalAuditHistory, AuditHistoryUnavailableError } from "../src/external-audit.js";
import { MCP_AUDIT_RETENTION_MS } from "../src/audit-metadata.js";
import worker from "../src/index.js";

const db = (env as unknown as { HISTORY_DB: D1Database }).HISTORY_DB;
const life = "audit-lifecycle-test-v1";
function metadata(callId = "call-test", completed = Date.now()): Record<string, unknown> {
  return { runner_id: "r", lifecycle_id: life, call_id: callId, client_id: "c", method: "fs.read", status: "ok", workspace_id: "w", completed_at_ms: completed, started_at_ms: completed - 1, duration_ms: 1,
    command: "DO_NOT_PERSIST_COMMAND", secret: "DO_NOT_PERSIST_SECRET", output: "DO_NOT_PERSIST_OUTPUT" };
}

it("D1 audit stores only bounded metadata, isolates identities, and counts retries once", async () => {
  const namespace = `audit-${crypto.randomUUID()}`, sink = new ExternalAuditHistory(db, namespace);
  expect(await sink.append(metadata())).toBe(true);
  expect(await sink.append(metadata())).toBe(true);
  const rows = await sink.list("r", life);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ call_id: "call-test", runner_id: "r", lifecycle_id: life, method: "fs.read" });
  expect(JSON.stringify(rows)).not.toMatch(/DO_NOT_PERSIST|command|secret|output/);
  expect(await sink.list("other-runner", life)).toEqual([]);
  expect(await sink.list("r", "replacement-lifecycle")).toEqual([]);
  expect(await new ExternalAuditHistory(db, "different-namespace").list("r", life)).toEqual([]);
  const count = await db.prepare("SELECT total FROM runmesh_audit_counts_v1 WHERE namespace=? AND runner_id='r' AND lifecycle_id=?").bind(namespace, life).first<{ total: number }>();
  expect(count?.total).toBe(1);
  expect(await new ExternalAuditHistory(db, namespace).list("r", life)).toHaveLength(1);
});

it("D1 retention caps history without a retained-row scan and expiry cleanup is bounded", async () => {
  const namespace = `retention-${crypto.randomUUID()}`, sink = new ExternalAuditHistory(db, namespace), now = Date.now();
  expect(await sink.append(metadata("seed", now))).toBe(true);
  await db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1200)
    INSERT INTO runmesh_audit_v1 SELECT ?, 'r', ?, printf('call-%04d',x), ?+x, json_object('runner_id','r','lifecycle_id',?,'call_id',printf('call-%04d',x),'completed_at_ms',?+x) FROM n`)
    .bind(namespace, life, now, life, now).run();
  expect(await sink.append(metadata("last", now + 2000))).toBe(true);
  const count = await db.prepare("SELECT total FROM runmesh_audit_counts_v1 WHERE namespace=? AND runner_id='r' AND lifecycle_id=?").bind(namespace, life).first<{ total: number }>();
  expect(count?.total).toBe(1000);
  const rows = await sink.list("r", life, 5000);
  expect(rows).toHaveLength(100);
  expect(rows[0]?.call_id).toBe("last");
  await db.prepare("UPDATE runmesh_audit_v1 SET completed_at_ms=? WHERE namespace=?").bind(now - MCP_AUDIT_RETENTION_MS - 1000, namespace).run();
  expect(await sink.list("r", life)).toEqual([]);
  await sink.cleanup();
  const left = await db.prepare("SELECT COUNT(*) AS n FROM runmesh_audit_v1 WHERE namespace=?").bind(namespace).first<{ n: number }>();
  expect(left?.n).toBe(900);
});

it("D1 quota opens an in-memory circuit, never returns fake empty history, and resumes after UTC reset", async () => {
  const now = Date.UTC(2026, 8, 14, 12), clock = vi.spyOn(Date, "now").mockReturnValue(now);
  let attempts = 0, unavailable = true;
  const fake = {
    prepare(query: string) { attempts++; if (unavailable) throw new Error("D1_ERROR: daily rows_read limit exceeded"); return db.prepare(query); },
    batch(statements: D1PreparedStatement[]) { return db.batch(statements); },
  } as D1Database;
  const sink = new ExternalAuditHistory(fake, `circuit-${crypto.randomUUID()}`);
  try {
    expect(await sink.append(metadata())).toBe(false);
    const afterFailure = attempts;
    for (let i = 0; i < 1000; i++) expect(await sink.append(metadata(`call-${i}`))).toBe(false);
    await expect(sink.list("r", life)).rejects.toBeInstanceOf(AuditHistoryUnavailableError);
    await sink.cleanup();
    expect(attempts).toBe(afterFailure);
    expect(sink.health()?.disabled_until_ms).toBe(Date.UTC(2026, 8, 15) + 30_000);
    unavailable = false; clock.mockReturnValue(Date.UTC(2026, 8, 15) + 30_001);
    expect(await sink.append(metadata("recovered"))).toBe(true);
    expect(await sink.list("r", life)).toHaveLength(1);
  } finally { clock.mockRestore(); }
});

it("independent audit expiry never instantiates the core DO or reads its SQLite storage", async () => {
  const get = vi.fn(() => { throw new Error("core DO quota exhausted"); });
  const localEnv = { ...env, HISTORY_DB: db, RUNMESH_AUDIT_BACKEND: "d1", REGISTRY: { idFromName: () => ({ toString: () => "cron-test" }), get } } as unknown as typeof env;
  await worker.scheduled({} as ScheduledController, localEnv);
  expect(get).not.toHaveBeenCalled();
});

it("a late transient failure cannot shorten a concurrent daily quota cooldown", async () => {
  const now = Date.UTC(2026, 8, 14, 12), clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const pending: Array<(error: Error) => void> = [];
  let failWrites = false;
  const database = {
    prepare: db.prepare.bind(db),
    batch: (statements: D1PreparedStatement[]) => failWrites
      ? new Promise<never>((_resolve, reject) => { pending.push(reject); }) : db.batch(statements),
  } as D1Database;
  try {
    const sink = new ExternalAuditHistory(database, `concurrent-circuit-${crypto.randomUUID()}`);
    expect(await sink.append(metadata("seed"))).toBe(true);
    failWrites = true;
    const quotaFailure = sink.append(metadata("quota")), transientFailure = sink.append(metadata("transient"));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[0]!(new Error("D1_ERROR: daily rows_written limit exceeded"));
    expect(await quotaFailure).toBe(false);
    pending[1]!(new Error("D1 temporarily unavailable"));
    expect(await transientFailure).toBe(false);
    expect(sink.health()).toMatchObject({ disabled_until_ms: Date.UTC(2026, 8, 15) + 30_000, failure_count: 2 });
    clock.mockReturnValue(now + 3_600_000);
    expect(await sink.append(metadata("still-blocked"))).toBe(false);
    expect(pending).toHaveLength(2);
  } finally { clock.mockRestore(); }
});
