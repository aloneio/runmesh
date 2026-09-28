import { expect, it } from "vitest";
import { decodePathIdentifier, matchIdentifierPath } from "../../apps/worker/src/http/path-identifiers.js";
import { FairJobQueue } from "../../apps/runner/src/job-queue.js";
import { projectReauthorization } from "../../apps/worker/src/mcp/reauthorization.js";
import { planContextRetention, type RetentionCandidate } from "../../apps/runner/src/context/retention-plan.js";

it.each(["runner:host.1", "runner-1", "a".repeat(128)])("decodes a valid HTTP identifier exactly once: %s", id => {
  expect(decodePathIdentifier(id)).toBe(id);
  expect(decodePathIdentifier(encodeURIComponent(id))).toBe(id);
});

it.each([undefined, "", ".", "..", "r%2Fx", "r%5Cx", "r%253Ax", "r%00x", "r%3Fx", "r%23x", "r%", "%zz", "%E0%A4%A", "%E2%98%83", "a".repeat(129)])("rejects malformed or unsafe HTTP identifier %s", value => {
  expect(decodePathIdentifier(value)).toBeUndefined();
});

it("decodes only identifier captures and preserves literal route actions", () => {
  const action = /^\/admin\/runners\/([^/]+)\/(delete|revoke)$/;
  expect(matchIdentifierPath(action, "/admin/runners/r%3A1/delete")?.slice(1)).toEqual(["r:1", "delete"]);
  expect(matchIdentifierPath(action, "/admin/runners/r%2F1/delete")).toBeNull();
  expect(matchIdentifierPath(action, "/admin/runners/r%3A1/%64elete")).toBeNull();
  const job = /^\/admin\/runners\/([^/]+)\/jobs\/([^/]+)$/;
  expect(matchIdentifierPath(job, "/admin/runners/r%3a1/jobs/job%3A2", [1, 2])?.slice(1)).toEqual(["r:1", "job:2"]);
  expect(matchIdentifierPath(job, "/admin/runners/r%3A1/jobs/job%253A2", [1, 2])).toBeNull();
});

it("AR08 public queue operations preserve per-client FIFO and progress without a process manager", () => {
  const queue = new FairJobQueue<string>(4, 3);
  queue.push("a", "a1", "first"); queue.push("a", "a2", "second"); queue.push("b", "b1", "third");
  expect([queue.shift()?.id, queue.shift()?.id, queue.shift()?.id]).toEqual(["a1", "b1", "a2"]);
  expect(queue.size).toBe(0); expect(queue.shift()).toBeUndefined();
});

it("AR08 queue limits and removals are observable through public methods", () => {
  const queue = new FairJobQueue<number>(2, 1);
  queue.push("a", "one", 1); expect(() => queue.push("a", "two", 2)).toThrow("queue_full");
  queue.push("b", "two", 2); expect(() => queue.push("c", "three", 3)).toThrow("queue_full");
  queue.remove("one"); queue.push("c", "three", 3);
  expect(queue.count("a")).toBe(0); expect(queue.size).toBe(2);
});

it.each([null, {}, { client_id: "client", secret_version: 1, scopes: ["admin"] },
  { client_id: "client", secret_version: 1, scopes: ["coding:read", "coding:read"] }])(
  "AR08 malformed authorization evidence is not proof of credential revocation: %j", value => {
    expect(projectReauthorization(value, { client_id: "client", secret_version: 1 })).toEqual({ state: "malformed" });
  });

it("AR08 valid principal observations distinguish allowed from changed identity", () => {
  const value = { client_id: "client", secret_version: 1, scopes: ["coding:read"] };
  expect(projectReauthorization(value, { client_id: "client", secret_version: 1 })).toEqual({ state: "allowed", scopes: ["coding:read"] });
  expect(projectReauthorization(value, { client_id: "client", secret_version: 2 })).toEqual({ state: "denied" });
});

it("AR08 retention preview is a deterministic description, not deletion authorization", () => {
  const stamp = { dev: 1, ino: 2, size: 12, mtimeMs: 10, ctimeMs: 10 };
  const candidate: RetentionCandidate = { file: { contextId: "c", revision: 1, stamp }, hash: "b".repeat(64), latest: { contextId: "c", revision: 2, stamp } };
  const input = Object.freeze({ workspaceId: "w", generation: 1, keepDays: 30, keepRevisions: 1,
    maxDelete: 1, inventoryDigest: "a".repeat(64), candidates: Object.freeze([candidate]), preservedContexts: 1, scannedFiles: 2, scannedBytes: 24 });
  const first = planContextRetention(input);
  expect(planContextRetention(input)).toEqual(first);
  expect(first.summary).toMatchObject({ applied: false, deleted_records: 0, deleted_bytes: 0, candidate_records: 1 });
  expect(planContextRetention({ ...input, generation: 2 }).summary.plan_hash).not.toBe(first.summary.plan_hash);
});
