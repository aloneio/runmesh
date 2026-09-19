import { expect, it } from "vitest";
import { isBoundCursor, BoundBytePageMetadataSchema } from "../src/cursors.js";
import { bytePageMetadata } from "../src/pagination.js";
import { failureMetadata } from "../src/failure.js";

it.each(["file", "log"] as const)("accepts canonical %s cursors only within safe integer bounds", kind => {
  const prefix = kind === "file" ? "f1" : "l1", id = "a".repeat(64);
  expect(isBoundCursor(`${prefix}:${id}:0`, kind)).toBe(true);
  expect(isBoundCursor(`${prefix}:${id}:9007199254740991`, kind)).toBe(true);
  for (const cursor of [`${prefix}:${id}:01`, `${prefix}:${id}:-1`, `${prefix}:${id}:9007199254740992`, `${prefix}:${id}:1e2`, `${prefix}:${id}:1\n`, `https://private/${id}`, `${prefix}:${"a".repeat(65)}:0`]) expect(isBoundCursor(cursor, kind)).toBe(false);
  expect(isBoundCursor(`${prefix}:${id}:0`, kind === "file" ? "log" : "file")).toBe(false);
});

it("bound page metadata is a distinct strict version, not a reinterpretation of legacy null snapshots", () => {
  const legacy = bytePageMetadata("a", 0, 1, 2); const { next_cursor: _next, truncated: _truncated, ...metadata } = legacy;
  const value = { ...metadata, page_protocol: 2, snapshot_id: "b".repeat(64), consistency: "snapshot", resume_cursor: `f1:${"a".repeat(64)}:1`, cursor_expires_at_ms: 1 };
  expect(BoundBytePageMetadataSchema.safeParse(value).success).toBe(true);
  for (const extra of [{page_protocol:1}, {snapshot_id:null}, {consistency:"guaranteed"}, {cursor_expires_at_ms:Infinity}, {token:"private"}]) expect(BoundBytePageMetadataSchema.safeParse({...value,...extra}).success).toBe(false);
});

it.each(["cursor_expired", "cursor_mismatch"])("%s is a read conflict, not credential failure or an execution retry", code => {
  expect(failureMetadata(code)).toEqual({ failure_class: "conflict", operation_state: "not_started", next_action: "re_read_and_retry" });
});
it("snapshot limits remain a resource failure", () => {
  expect(failureMetadata("snapshot_too_large")).toEqual({failure_class:"resource",operation_state:"not_started",next_action:"correct_request"});
});
