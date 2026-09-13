import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
