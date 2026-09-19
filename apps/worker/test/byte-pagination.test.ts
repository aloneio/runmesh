import { expect, it } from "vitest";
import { bytePageMetadata } from "@aloneio/runmesh-protocol";
import { safeReadResult, safeJobLogResult, safeShellResult } from "../src/mcp/server.js";
import { ReadOutputSchema } from "../src/mcp/catalog.js";
import { catalogContract } from "../src/mcp/catalog-contract.js";

const page = () => ({ workspace_id: "w", path: "file.txt", data: "中", encoding: "utf-8", offset: 0, size: 10, ...bytePageMetadata("中", 0, 3, 10) });

it("advertises and preserves typed read-page fields, with no invented metadata for old peers", () => {
  expect(safeReadResult(page())).toEqual(page());
  const legacy = { workspace_id: "w", path: "old.txt", data: "old", offset: 0, size: 3, next_cursor: null, truncated: false };
  expect(safeReadResult(legacy)).toEqual(legacy);
  expect(ReadOutputSchema.safeParse(legacy).success).toBe(true);
  const schema = catalogContract().tools.find(tool => tool.name === "read")!.outputSchema as any;
  expect(schema.properties.page_state.enum).toEqual(["more", "end", "incomplete"]);
  expect(schema.properties.returned_bytes.type).toBe("integer");
});

it.each([{ returned_bytes: 1 }, { total_bytes: 11 }, { resume_offset: 0 }, { page_state: "end" }, { pending_bytes: 1 }, { snapshot_id: "private-path" }, { resume_offset: Infinity }])("rejects incoherent or secret-bearing page evidence %j", override => {
  const result = safeReadResult({ ...page(), ...override, root_path: "/private/root", token: "private-token" });
  expect(result.page_protocol).toBeUndefined();
  expect(result.data).toBe("中");
  expect(JSON.stringify(result)).not.toContain("private");
});

it("preserves incomplete log tails and a Job-wide source truncation flag", () => {
  const result = safeJobLogResult({ job_id: "j", stream: "stdout", data: "", offset: 2, size: 4, ...bytePageMetadata("", 2, 2, 4), source_truncated: true });
  expect(result).toMatchObject({ next_cursor: null, page_state: "incomplete", resume_offset: 2, pending_bytes: 2, source_truncated: true });
});

it("unavailable inline logs do not leak exceptions or hide a real nonzero exit code", () => {
  const result = safeShellResult({ completed: true, job: { job_id: "j", status: "failed", exit_code: 7 }, stdout: { job_id: "j", stream: "stdout", available: false, error: { code: "log_unavailable", message: "/private/secret" }, data: "must-not-be-used", token: "private-token" } });
  expect(result).toMatchObject({ completed: true, status: "failed", exit_code: 7, stdout: { job_id: "j", available: false, error: { code: "log_unavailable" } } });
  expect(JSON.stringify(result)).not.toContain("private"); expect(JSON.stringify(result)).not.toContain("must-not-be-used");
});
