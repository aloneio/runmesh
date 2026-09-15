import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { planContextRetention, type RetentionCandidate, type RetentionPlanInput } from "../src/context/retention-plan.js";

afterEach(() => vi.restoreAllMocks());
function candidate(contextId: string, revision: number): RetentionCandidate {
  const stamp = { dev: 1, ino: revision, size: revision * 10, mtimeMs: 1, ctimeMs: 1 };
  return { file: { contextId, revision, stamp }, hash: String(revision).repeat(64), latest: { contextId, revision: 10, stamp } };
}
function input(): RetentionPlanInput {
  return { workspaceId: "w", generation: 1, keepDays: 30, keepRevisions: 2, maxDelete: 2, inventoryDigest: "a".repeat(64),
    candidates: [candidate("b", 2), candidate("a", 3), candidate("a", 1)], preservedContexts: 2, scannedFiles: 5, scannedBytes: 120 };
}

it("AR07 retention planning is deterministic, does not mutate observations or consult a clock", () => {
  const value = input(), before = JSON.stringify(value);
  Object.freeze(value.candidates); Object.freeze(value);
  const time = vi.spyOn(Date, "now").mockImplementation(() => { throw new Error("planner must not read time"); });
  const result = planContextRetention(value);
  expect(planContextRetention(value)).toEqual(result);
  expect(JSON.stringify(value)).toBe(before); expect(time).not.toHaveBeenCalled();
  expect(result.selected.map(item => [item.file.contextId, item.file.revision])).toEqual([["a", 1], ["a", 3]]);
  expect(result.summary).toMatchObject({ applied: false, candidate_records: 2, candidate_bytes: 40, eligible_records: 3, has_more: true, deleted_records: 0, deleted_bytes: 0 });
});

it("AR07 retention hash retains the previous explicit property order and candidate binding", () => {
  const value = input(), plan = planContextRetention(value);
  const expected = createHash("sha256").update(JSON.stringify({ schema: 1, workspaceId: "w", generation: 1, keepDays: 30,
    keepRevisions: 2, maxDelete: 2, inventory: "a".repeat(64), selected: [["a", 1, "1".repeat(64)], ["a", 3, "3".repeat(64)]] })).digest("hex");
  expect(plan.summary.plan_hash).toBe(expected);
});

it.each([
  { workspaceId: "another" }, { generation: 2 }, { keepDays: 31 }, { keepRevisions: 3 }, { maxDelete: 1 }, { inventoryDigest: "b".repeat(64) },
])("AR07 plan identity changes with reviewed scope and settings %j", extra => {
  expect(planContextRetention({ ...input(), ...extra }).summary.plan_hash).not.toBe(planContextRetention(input()).summary.plan_hash);
});

it("AR07 changed candidate content invalidates the old plan without selecting the latest record", () => {
  const value = input(), changed = { ...value, candidates: value.candidates.map(c => ({ ...c, hash: "f".repeat(64) })) };
  expect(planContextRetention(changed).summary.plan_hash).not.toBe(planContextRetention(value).summary.plan_hash);
  expect(planContextRetention(changed).selected.every(item => item.file.revision !== item.latest.revision)).toBe(true);
});

it("AR07 empty eligible input produces a no-op preview, not a disk deletion", () => {
  expect(planContextRetention({ ...input(), candidates: [] }).summary).toMatchObject({ candidate_records: 0, eligible_records: 0,
    candidate_bytes: 0, has_more: false, applied: false, complete: true, deleted_records: 0 });
});
