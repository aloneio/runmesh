import { expect, it } from "vitest";
import { bytePageMetadata, BytePageMetadataSchema } from "../src/pagination.js";
import { failureMetadata } from "../src/failure.js";

it("counts UTF-8 payload bytes rather than JS characters or escaped JSON length", () => {
  const data = "中😀\r\n\0";
  const page = bytePageMetadata(data, 0, 10, 20);
  expect(page).toMatchObject({ returned_bytes: 10, total_bytes: 20, next_cursor: "10", resume_offset: 10, page_state: "more", snapshot_id: null });
  const fields = Object.fromEntries(Object.keys(BytePageMetadataSchema.shape).map(key => [key, page[key as keyof typeof page]]));
  expect(BytePageMetadataSchema.safeParse(fields).success).toBe(true);
});

it("distinguishes EOF, response limits and undecodable final bytes without inventing a snapshot", () => {
  expect(bytePageMetadata("", 0, 0, 0)).toMatchObject({ page_state: "end", truncated_reason: null, truncated: false });
  expect(bytePageMetadata("x", 3, 4, 10, true)).toMatchObject({ truncated_reason: "response_bytes", next_cursor: "4" });
  expect(bytePageMetadata("", 3, 3, 5)).toMatchObject({ page_state: "incomplete", truncated_reason: "incomplete_utf8", next_cursor: null, resume_offset: 3, pending_bytes: 2, truncated: true });
});

it.each([[0, -1, 0], [-1, 0, 1], [0, 2, 1], [0, Infinity, Infinity], [0, 0, Number.MAX_SAFE_INTEGER + 1]])("refuses invalid internal bounds %j", (offset, next, size) => {
  expect(() => bytePageMetadata("", offset!, next!, size!)).toThrow("bounds");
});

it("read errors remain separate from process success and never imply rerunning a command", () => {
  expect(failureMetadata("log_unavailable")).toMatchObject({ failure_class: "availability", operation_state: "not_started", next_action: "inspect_job" });
  for (const code of ["file_changed", "log_changed"]) expect(failureMetadata(code)).toMatchObject({ failure_class: "conflict", next_action: "re_read_and_retry" });
  expect(failureMetadata("read_budget_exhausted")).toMatchObject({ failure_class: "resource", next_action: "correct_request" });
});
