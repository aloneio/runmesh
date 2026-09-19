import { expect, it } from "vitest";
import { bytePageMetadata } from "@aloneio/runmesh-protocol";
import { ReadInputSchema, JobInputSchema, ReadOutputSchema } from "../src/mcp/catalog.js";
import { safeReadResult, safeJobLogResult } from "../src/mcp/server.js";
import { boundPageResponseProblem } from "../src/mcp/byte-pages.js";

const id = "a".repeat(64), f = `f1:${id}:2`, l = `l1:${id}:2`;
function page(kind: "file" | "log") {
  const cursor = kind === "file" ? f : l;
  return {workspace_id:"w",path:"a",job_id:"j",stream:"stdout",data:"ok",encoding:"utf-8",offset:0,size:4,
    ...bytePageMetadata("ok",0,2,4),page_protocol:2,consistency:kind==="file"?"snapshot":"append",snapshot_id:kind==="file"?"b".repeat(64):id,next_cursor:cursor,resume_cursor:cursor,cursor_expires_at_ms:1000};
}
it("advertises typed opt-in modes while numeric legacy cursors remain accepted", () => {
  for (const cursor of [undefined,"2",f]) expect(ReadInputSchema.safeParse({workspace_id:"w",path:"a",cursor}).success).toBe(true);
  for (const cursor of [undefined,"2",l]) expect(JobInputSchema.safeParse({action:"logs",job_id:"j",cursor}).success).toBe(true);
  expect(ReadInputSchema.safeParse({workspace_id:"w",path:"a",consistency:"snapshot"}).success).toBe(true);
  expect(JobInputSchema.safeParse({action:"logs",job_id:"j",consistency:"append"}).success).toBe(true);
});
it.each([{cursor:l}, {cursor:f,offset:2}, {cursor:f,consistency:"live"}, {cursor:"2",consistency:"snapshot"}, {consistency:"append"}])("refuses mixed file cursor semantics %j", extra => {
  expect(ReadInputSchema.safeParse({workspace_id:"w",path:"a",...extra}).success).toBe(false);
});
it.each([{cursor:f}, {cursor:l,offset:2}, {cursor:l,tail:true}, {cursor:l,consistency:"live"}, {cursor:"2",consistency:"append"}])("refuses mixed log cursor semantics %j", extra => {
  expect(JobInputSchema.safeParse({action:"logs",job_id:"j",...extra}).success).toBe(false);
});
it("only projects coherent resource-specific cursor evidence and no host data", () => {
  const file = safeReadResult({...page("file"),token:"private",root:"/private"});
  expect(file).toMatchObject({page_protocol:2,next_cursor:f,resume_cursor:f,consistency:"snapshot"});
  expect(ReadOutputSchema.safeParse(file).success).toBe(true);
  expect(JSON.stringify(file)).not.toContain("private");
  expect(safeJobLogResult(page("log"))).toMatchObject({page_protocol:2,next_cursor:l,resume_cursor:l});
  for (const extra of [{resume_cursor:`f1:${id}:3`}, {next_cursor:"2"}, {next_cursor:`f1:${"c".repeat(64)}:2`}, {consistency:"append"}, {cursor_expires_at_ms:-1}]) expect(safeReadResult({...page("file"),...extra}).page_protocol).toBeUndefined();
  expect(safeReadResult(page("log")).page_protocol).toBeUndefined();
  expect(safeJobLogResult(page("file")).page_protocol).toBeUndefined();
});
it("explicit consistency cannot silently downgrade to a legacy response", () => {
  expect(boundPageResponseProblem("fs.read",{consistency:"snapshot"},{page_protocol:1},{})).toBe("runner_upgrade_required");
  expect(boundPageResponseProblem("job.logs",{cursor:l},{page_protocol:1},{})).toBe("runner_upgrade_required");
  expect(boundPageResponseProblem("fs.read",{cursor:"2"},{page_protocol:1},{})).toBeUndefined();
});
it("transport evidence cannot swap resource or cursor generation during continuation", () => {
  const raw = {...page("file"),offset:2,data:"ok",size:4,...bytePageMetadata("ok",2,4,4),page_protocol:2,consistency:"snapshot",snapshot_id:"b".repeat(64),resume_cursor:`f1:${id}:4`,cursor_expires_at_ms:1000};
  const params={workspace_id:"w",path:"./a",cursor:f};
  expect(boundPageResponseProblem("fs.read",params,raw,safeReadResult(raw))).toBeUndefined();
  for (const extra of [{path:"b"},{workspace_id:"other"},{resume_cursor:`f1:${"c".repeat(64)}:4`},{offset:1}]) expect(boundPageResponseProblem("fs.read",params,{...raw,...extra},safeReadResult({...raw,...extra}))).toBe("cursor_mismatch");
});
