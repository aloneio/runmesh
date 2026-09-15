import { createHash } from "node:crypto";
import { lstat, mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextStore } from "../src/context-store.js";

const cleanups: string[] = [];

async function fixture(): Promise<{ root: string; state: string; store: ContextStore }> {
  const root = await mkdtemp(join(tmpdir(), "runmesh-context-"));
  cleanups.push(root);
  const state = join(root, "state");
  return { root, state, store: new ContextStore({ stateDir: state }) };
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("ContextStore", () => {
  it("keeps bootstrap read-only when no context exists", async () => {
    const test = await fixture();
    await expect(test.store.bootstrap({ workspace_id: "workspace" })).resolves.toEqual({ workspace_id: "workspace", state: "missing", context: null });
    await expect(lstat(test.state)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deduplicates checkpoints, versions changes, and searches only the derived index", async () => {
    const test = await fixture();
    const firstInput = {
      workspace_id: "workspace",
      turn_id: "turn-1",
      base_commit: "0123456789abcdef",
      goal: "finish the recovery handoff",
      decisions: ["keep jobs separate from context"],
      evidence: [{ kind: "note", status: "claimed", summary: "reviewed the design" }],
      open_risks: ["production hibernation is not verified"],
      missing_checks: ["production recovery"],
      next_actions: ["run the isolated recovery fixture"],
    };
    const first = await test.store.checkpoint(firstInput);
    expect(first).toMatchObject({ deduplicated: false, context: { revision: 1, review_state: "incomplete", supersedes_revision: null } });
    const contextId = (first.context as { context_id: string }).context_id;
    const duplicate = await test.store.checkpoint(firstInput);
    expect(duplicate).toMatchObject({ deduplicated: true, context: { context_id: contextId, revision: 1 } });

    const second = await test.store.checkpoint({ ...firstInput, context_id: contextId, expected_revision: 1, goal: "finish and verify the recovery handoff", missing_checks: [] });
    expect(second).toMatchObject({ deduplicated: false, context: { context_id: contextId, revision: 2, supersedes_revision: 1, review_state: "claimed" } });
    await expect(test.store.checkpoint({ ...firstInput, context_id: contextId, expected_revision: 1, goal: "stale writer" })).rejects.toMatchObject({ code: "context_revision_conflict" });
    await expect(test.store.checkpoint({ ...firstInput, context_id: contextId, turn_id: "turn-2", expected_revision: 2 })).rejects.toMatchObject({ code: "context_turn_conflict" });

    await expect(test.store.bootstrap({ workspace_id: "workspace" })).resolves.toMatchObject({ state: "ready", context: { context_id: contextId, revision: 2 } });
    await expect(test.store.read({ workspace_id: "workspace", context_id: contextId, revision: 1 })).resolves.toMatchObject({ context: { revision: 1 } });
    await expect(test.store.search({ workspace_id: "workspace", query: "recovery", limit: 10 })).resolves.toMatchObject({ state: "ready", scanned_records: 1, results: [{ context_id: contextId, revision: 2 }] });
  });

  it("rebuilds a missing derived index without rewriting immutable records", async () => {
    const test = await fixture();
    const created = await test.store.checkpoint({ workspace_id: "workspace", turn_id: "turn-1", goal: "rebuild canary", evidence: [], missing_checks: [], decisions: [], open_risks: [], next_actions: [] });
    const contextId = (created.context as { context_id: string }).context_id;
    const recordPath = join(test.state, "contexts", "workspace", contextId, "1.json");
    const before = await lstat(recordPath);
    await rm(join(test.state, "contexts", "workspace", "index.json"));
    await expect(test.store.bootstrap({ workspace_id: "workspace" })).resolves.toMatchObject({ state: "missing" });
    await expect(test.store.rebuild({ workspace_id: "workspace" })).resolves.toMatchObject({ rebuilt: true, records: 1, scanned_files: 1 });
    await expect(test.store.bootstrap({ workspace_id: "workspace" })).resolves.toMatchObject({ state: "ready", context: { context_id: contextId, revision: 1 } });
    const after = await lstat(recordPath);
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);
  });
});


it("R04 deduplicates unchanged observed Job facts without discarding the first observation time", async () => {
  const f=await fixture();
  const input={workspace_id:"workspace",turn_id:"observed",goal:"retain facts",evidence:[{kind:"job",status:"observed",job_id:"j",job_status:"succeeded",exit_code:0,observed_at_ms:100}]};
  const first=await f.store.checkpoint(input);
  const next=await f.store.checkpoint({...input,evidence:[{...input.evidence[0],observed_at_ms:1100}]});
  expect(next).toMatchObject({deduplicated:true,context:{revision:1,evidence:[{observed_at_ms:100}]}});
  expect(next.context).toEqual(first.context);
});
it("R04 returns the last receipt for an identical expected-revision retry and still rejects stale writes", async () => {
  const f=await fixture();const input={workspace_id:"workspace",turn_id:"retry",goal:"one",expected_revision:0};
  const first=await f.store.checkpoint(input); const id=(first.context as {context_id:string}).context_id;
  expect(await f.store.checkpoint(input)).toMatchObject({deduplicated:true,context:{revision:1,context_id:id}});
  await expect(f.store.checkpoint({...input,goal:"different"})).rejects.toMatchObject({code:"context_revision_conflict"});
  await f.store.checkpoint({...input,context_id:id,expected_revision:1,goal:"two"});
  await expect(f.store.checkpoint(input)).rejects.toMatchObject({code:"context_revision_conflict"});
});
it("R04 refuses to create a second context when its record committed but the index write failed", async () => {
  const f=await fixture();const input={workspace_id:"workspace",turn_id:"recover",goal:"durable receipt",expected_revision:0};
  const internal=f.store as unknown as {writeIndex:(input:unknown)=>Promise<void>};
  const write=vi.spyOn(internal,"writeIndex").mockRejectedValueOnce(new Error("synthetic index write failure"));
  await expect(f.store.checkpoint(input)).rejects.toThrow();write.mockRestore();
  const recovered=new ContextStore({stateDir:f.state});
  await expect(recovered.checkpoint(input)).rejects.toMatchObject({code:"context_index_stale"});
  expect(await recovered.rebuild({workspace_id:"workspace"})).toMatchObject({records:1});
  expect(await recovered.checkpoint(input)).toMatchObject({deduplicated:true,context:{revision:1}});
});


it("R04 keeps v1 immutable records readable and unchanged through rebuild", async () => {
  const f=await fixture();const first=await f.store.checkpoint({workspace_id:"workspace",turn_id:"legacy",goal:"legacy record"});
  const original=first.context as any; const path=join(f.state,"contexts","workspace",original.context_id,"1.json");
  const {base_worktree_state:_worktree,...old}=original;old.schema_version=1;
  old.fingerprint=createHash("sha256").update(JSON.stringify({turn_id:old.turn_id,base_commit:old.base_commit,goal:old.goal,decisions:old.decisions,evidence:old.evidence,open_risks:old.open_risks,missing_checks:old.missing_checks,next_actions:old.next_actions})).digest("hex");
  await writeFile(path,JSON.stringify(old)+"\n");await rm(join(f.state,"contexts","workspace","index.json"));const before=await readFile(path);
  await f.store.rebuild({workspace_id:"workspace"});
  expect(await f.store.read({workspace_id:"workspace",context_id:old.context_id})).toMatchObject({context:{schema_version:1,base_worktree_state:"unknown"}});
  expect(await readFile(path)).toEqual(before);
  const next=await f.store.checkpoint({workspace_id:"workspace",context_id:old.context_id,turn_id:"legacy",goal:"new explicit checkpoint",expected_revision:1});
  expect(next).toMatchObject({context:{schema_version:2,revision:2}});expect(await readFile(path)).toEqual(before);
});
it("R04 rejects unsupported record versions and tampered observed baseline fields", async () => {
  const f=await fixture();const result=await f.store.checkpoint({workspace_id:"workspace",turn_id:"integrity",goal:"verify integrity",base_worktree_state:"dirty"});
  const record=result.context as any;const path=join(f.state,"contexts","workspace",record.context_id,"1.json");
  for(const changed of [{...record,schema_version:999},{...record,base_worktree_state:"clean"}]) {
    await writeFile(path,JSON.stringify(changed));
    await expect(f.store.read({workspace_id:"workspace",context_id:record.context_id})).rejects.toMatchObject({code:"context_record_corrupt"});
  }
});
it("R04 serializes two service instances sharing one managed state directory", async () => {
  const f=await fixture();const other=new ContextStore({stateDir:f.state});const input={workspace_id:"workspace",turn_id:"shared",goal:"one checkpoint",expected_revision:0};
  const results=await Promise.all([f.store.checkpoint(input),other.checkpoint(input)]);
  expect(results.map(r=>r.deduplicated).sort()).toEqual([false,true]);
  const records=await readdir(join(f.state,"contexts","workspace"));expect(records.filter(x=>x.startsWith("ctx-"))).toHaveLength(1);
});
it("R04 retains a committed next revision after index failure and recovers explicitly", async () => {
  const f=await fixture();const base={workspace_id:"workspace",turn_id:"next",goal:"one",expected_revision:0};
  const first=await f.store.checkpoint(base);const id=(first.context as any).context_id;
  const input={...base,context_id:id,goal:"two",expected_revision:1};
  const fail=vi.spyOn(f.store as unknown as {writeIndex:(input:unknown)=>Promise<void>},"writeIndex").mockRejectedValueOnce(new Error("index failed"));
  await expect(f.store.checkpoint(input)).rejects.toMatchObject({code:"context_index_stale"});fail.mockRestore();
  await expect(f.store.checkpoint(input)).rejects.toMatchObject({code:"context_index_stale"});
  await f.store.rebuild({workspace_id:"workspace"});expect(await f.store.checkpoint(input)).toMatchObject({deduplicated:true,context:{revision:2}});
  expect((await readdir(join(f.state,"contexts","workspace",id))).sort()).toEqual(["1.json","2.json"]);
});
it("R04 retains changed evidence facts and rejects caller-invented context identities", async () => {
  const f=await fixture();const input={workspace_id:"workspace",turn_id:"facts",goal:"job evidence",evidence:[{kind:"job",status:"observed",job_id:"j",job_status:"running",observed_at_ms:100}]};
  await f.store.checkpoint(input);
  expect(await f.store.checkpoint({...input,evidence:[{...input.evidence[0],job_status:"succeeded",exit_code:0,observed_at_ms:200}]})).toMatchObject({deduplicated:false,context:{revision:2}});
  await expect(f.store.checkpoint({...input,context_id:"invented"})).rejects.toMatchObject({code:"context_revision_conflict"});
});
