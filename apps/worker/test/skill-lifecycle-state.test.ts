import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { SkillState } from "../src/platform/skills/store.js";
import { SkillLifecycleState } from "../src/platform/skills/lifecycle-store.js";
import { initializeSkillSchema } from "../src/platform/skills/schema.js";
import { CentralSchema } from "../src/platform/capabilities/schema.js";
import { createSkillLifecycle } from "../src/application/skills/lifecycle.js";
import { createSkillAdministration } from "../src/application/skills/admin.js";
import { makeSkillBundle } from "../src/domain/skills/bundle.js";
import { catalogSha256 } from "../src/platform/capabilities/catalog-crypto.js";
import { SKILL_LIMITS, type SkillBundle } from "../src/contracts/skills.js";
import type { SkillCleanupPlan, SkillLifecycleAction } from "../src/contracts/skill-lifecycle.js";

const namespace = (env as unknown as { CAPABILITIES: DurableObjectNamespace }).CAPABILITIES;
const owner = () => namespace.get(namespace.idFromName(crypto.randomUUID()));
const session = "a".repeat(64), signal = () => new AbortController().signal;
async function bundle(index: number): Promise<SkillBundle> {
  return (await makeSkillBundle({ skill_id: "lifecycle", source: "Local", license: "MIT", files: [
    { path: "SKILL.md", text: "---\nname: lifecycle\ndescription: Lifecycle example\n---\nVersion " + index },
    { path: "reference.txt", text: "Reference " + index },
  ] }, catalogSha256))!;
}
function fixture(state: DurableObjectState) {
  const schema = new CentralSchema(state.storage), store = new SkillState(state.storage, () => schema.initialize());
  const repository = new SkillLifecycleState(state.storage, () => schema.initialize(), store);
  let now = 1000, allowed = true, authorizationCalls = 0;
  let onAuthorize = () => undefined;
  const service = createSkillLifecycle({ repository, digest: catalogSha256, now: () => now,
    admin: async () => { authorizationCalls++; onAuthorize(); return allowed ? "allowed" : "denied"; } });
  return { store, repository, now: (value: number) => { now = value; }, deny: () => { allowed = false; },
    onAuthorize: (action: () => void) => { onAuthorize = action; }, calls: () => authorizationCalls,
    run: (action: SkillLifecycleAction, input: unknown, hash = session) => service(hash, "lifecycle", action, input, signal()) };
}
function preview(value: Awaited<ReturnType<ReturnType<typeof createSkillLifecycle>>>): SkillCleanupPlan {
  expect(value.state).toBe("previewed"); if (value.state !== "previewed") throw new Error("expected preview"); return value.plan;
}

it.each(["same", "different", "aborted", "invalid-before", "aliased-after", "denied", "revision"] as const)("compares only verified requested Skill bodies with bounded repeated work: %s", async mode => {
  const first = await bundle(0), second = await bundle(1);
  await runInDurableObject(owner(), async (_instance, state) => {
    const f = fixture(state); f.store.install(first, 0); f.store.install(second, 1);
    const controller = new AbortController(), read = vi.spyOn(f.repository, "bundle");
    if (mode === "invalid-before") read.mockReturnValueOnce({ ...first, source: "Modified without updating the digest" });
    if (mode === "aliased-after") read.mockReturnValue(first);
    const digest = vi.fn(async (value: string) => {
      const result = await catalogSha256(value);
      if (mode === "aborted") controller.abort();
      return result;
    });
    const admin = vi.fn(async () => {
      if (admin.mock.calls.length === 2) {
        if (mode === "denied") return "denied" as const;
        if (mode === "revision") f.repository.retain("lifecycle", first.digest, true, 2);
      }
      return "allowed" as const;
    });
    const compare = createSkillLifecycle({ repository: f.repository, digest, admin, now: () => 1000 });
    const same = ["same", "denied", "revision"].includes(mode);
    try {
      const result = await compare(session, "lifecycle", "compare", { before: first.digest, after: same ? first.digest : second.digest }, controller.signal);
      expect(result.state).toBe(mode === "denied" ? "denied" : mode === "revision" ? "conflict"
        : ["aborted", "invalid-before", "aliased-after"].includes(mode) ? "unavailable" : "compared");
      if (result.state === "compared") {
        expect(result).toMatchObject({ skill_id: "lifecycle", before: first.digest, after: same ? first.digest : second.digest, revision: 2 });
        expect(result.files).toHaveLength(same ? 0 : 2);
      }
      const stopsEarly = mode === "aborted" || mode === "invalid-before";
      expect(read).toHaveBeenCalledTimes(same || stopsEarly ? 1 : 2);
      expect(digest).toHaveBeenCalledTimes(same || stopsEarly ? 1 : 2);
      expect(admin).toHaveBeenCalledTimes(stopsEarly || mode === "aliased-after" ? 1 : 2);
    } finally { read.mockRestore(); }
  });
});

it("version history reads metadata only, preserves old unknown times, and leaves schema-2 readers compatible", async () => {
  const first = await bundle(0), second = await bundle(1);
  await runInDurableObject(owner(), (_instance, state) => {
    const f = fixture(state); f.store.install(first, 0); f.store.install(second, 1);
    state.storage.sql.exec("DELETE FROM skill_version_metadata_v1 WHERE digest=?", first.digest);
    f.store.bundle = () => { throw new Error("history must not read content"); };
    const listed = f.repository.history("lifecycle")!;
    expect(listed.versions.find(version => version.digest === first.digest)).toMatchObject({ created_at_ms: null, pinned: false });
    expect(listed.versions.find(version => version.digest === second.digest)?.created_at_ms).toEqual(expect.any(Number));
    expect(listed.capacity).toMatchObject({ skill_versions: 2, library_skills: 1, max_versions: 32 });
    // The original schema-2 initializer checks only its owned tables.
    initializeSkillSchema(state.storage);
    expect(state.storage.sql.exec("SELECT schema_version FROM skill_meta").toArray()).toEqual([{ schema_version: 2 }]);
    expect(new SkillState(state.storage, () => undefined).bundle(first.skill_id, first.digest)).toEqual(first);
  });
});

it("restored and paused Skill library summaries read metadata with zero SQL writes", async () => {
  const first = await bundle(0), second = await bundle(1);
  await runInDurableObject(owner(), async (_instance, state) => {
    const f = fixture(state); f.store.install(first, 0); f.store.install(second, 1); f.store.activate("lifecycle", first.digest, 2);
    const service = createSkillAdministration({ repository: f.store, digest: catalogSha256, admin: async () => "allowed" });
    const bodies = vi.spyOn(f.store, "bundle").mockImplementation(() => { throw new Error("library must not read content"); });
    let written = 0;
    const exec = state.storage.sql.exec.bind(state.storage.sql);
    const sql = vi.spyOn(state.storage.sql, "exec").mockImplementation((query: string, ...args: any[]) => {
      const cursor = exec(query, ...args); written += cursor.rowsWritten; return cursor;
    });
    try {
      expect(await service.library(session, undefined, signal())).toMatchObject({ state: "listed", skills: [{
        head: { active_digest: first.digest, staged_digest: second.digest, enabled: true }, summary: { digest: first.digest } }] });
      expect(written).toBe(0);
      f.store.disable("lifecycle", 3); written = 0;
      for (let index = 0; index < 10; index++) expect(await service.library(session, undefined, signal())).toMatchObject({ state: "listed", skills: [{
        head: { active_digest: first.digest, staged_digest: second.digest, enabled: false }, summary: { digest: first.digest } }] });
      expect(written).toBe(0); expect(bodies).not.toHaveBeenCalled();
    } finally { sql.mockRestore(); bodies.mockRestore(); }
  });
});

it("32 versions can explicitly free an old version, install the 33rd, and reimport without inflating capacity", async () => {
  const bundles = await Promise.all(Array.from({ length: SKILL_LIMITS.versions + 1 }, (_, index) => bundle(index)));
  await runInDurableObject(owner(), async (_instance, state) => {
    const f = fixture(state);
    bundles.slice(0, 32).forEach((item, index) => expect(f.store.install(item, index).state).toBe("written"));
    expect(f.store.install(bundles[32]!, 32)).toEqual({ state: "capacity" });
    const old = bundles[0]!, previous = f.repository.history("lifecycle")!;
    const plan = preview(await f.run("cleanup-preview", { digests: [old.digest], expected_revision: 32 }));
    const cleaned = await f.run("cleanup", { fingerprint: plan.fingerprint, expected_revision: 32, confirm: true });
    expect(cleaned).toMatchObject({ state: "cleaned", head: { revision: 33 }, deleted_digests: [old.digest], capacity: { skill_versions: 31 } });
    expect(f.store.bundle("lifecycle", old.digest)).toBeUndefined();
    expect(f.repository.history("lifecycle")!.capacity.library_bytes).toBe(previous.capacity.library_bytes - plan.bytes);
    expect(f.store.bundle("lifecycle", bundles[31]!.digest)).toEqual(bundles[31]);
    expect(f.store.install(bundles[32]!, 33).state).toBe("written");
    const full = f.repository.history("lifecycle")!;
    expect(full.capacity.skill_versions).toBe(32);
    expect(f.store.install(bundles[32]!, 34).state).toBe("written");
    expect(f.repository.history("lifecycle")!.capacity).toEqual(full.capacity);
    expect(await f.run("cleanup", { fingerprint: plan.fingerprint, expected_revision: 32, confirm: true })).toMatchObject({ state: "conflict" });
  });
});

it("cleanup protects active, staged and pinned content including paused active content", async () => {
  const [active, old, staged] = await Promise.all([bundle(0), bundle(1), bundle(2)]);
  await runInDurableObject(owner(), async (_instance, state) => {
    const f = fixture(state); f.store.install(active!, 0); f.store.stage(old!, 1); f.store.stage(staged!, 2); f.store.disable("lifecycle", 3);
    for (const digest of [active!.digest, staged!.digest]) expect(await f.run("cleanup-preview", { digests: [digest], expected_revision: 4 })).toEqual({ state: "protected" });
    expect(await f.run("retention", { digest: old!.digest, pinned: true, expected_revision: 4 })).toMatchObject({ state: "retained", head: { revision: 5 }, pinned: true });
    expect(await f.run("cleanup-preview", { digests: [old!.digest], expected_revision: 5 })).toEqual({ state: "protected" });
    expect(await f.run("retention", { digest: old!.digest, pinned: false, expected_revision: 5 })).toMatchObject({ state: "retained", head: { revision: 6 }, pinned: false });
    preview(await f.run("cleanup-preview", { digests: [old!.digest], expected_revision: 6 }));
    expect(f.repository.history("lifecycle")!.versions).toHaveLength(3);
  });
});

it("retaining an unchanged Skill pin advances its revision without rewriting metadata", async () => {
  const first = await bundle(0);
  await runInDurableObject(owner(), (_instance, state) => {
    const f = fixture(state); f.store.install(first, 0); f.repository.history("lifecycle");
    let metadataWrites = 0, totalWrites = 0;
    const exec = state.storage.sql.exec.bind(state.storage.sql);
    const sql = vi.spyOn(state.storage.sql, "exec").mockImplementation((query: string, ...args: any[]) => {
      const cursor = exec(query, ...args); totalWrites += cursor.rowsWritten;
      if (query.includes("skill_version_metadata_v1")) metadataWrites += cursor.rowsWritten;
      return cursor;
    });
    try {
      for (const [index, pinned] of [false, true, true, false, false].entries()) {
        metadataWrites = 0; totalWrites = 0;
        expect(f.repository.retain("lifecycle", first.digest, pinned, index + 1)).toMatchObject({ state: "retained", head: { revision: index + 2 }, pinned });
        const changed = index === 1 || index === 3;
        expect(metadataWrites).toBe(changed ? 1 : 0);
        expect(totalWrites).toBe(changed ? 2 : 1);
      }
      expect(f.repository.retain("lifecycle", first.digest, true, 1)).toEqual({ state: "conflict", current_revision: 6 });
      expect(f.repository.history("lifecycle")!.versions[0]!.pinned).toBe(false);
    } finally { sql.mockRestore(); }
  });
});

it.each(["activate", "pin", "install"] as const)("a concurrent %s invalidates the exact cleanup preview", async change => {
  const [first, second, third] = await Promise.all([bundle(0), bundle(1), bundle(2)]);
  await runInDurableObject(owner(), async (_instance, state) => {
    const f = fixture(state); f.store.install(first!, 0); f.store.install(second!, 1);
    const plan = preview(await f.run("cleanup-preview", { digests: [first!.digest], expected_revision: 2 }));
    if (change === "activate") f.store.activate("lifecycle", first!.digest, 2);
    else if (change === "pin") f.repository.retain("lifecycle", first!.digest, true, 2);
    else f.store.install(third!, 2);
    expect(await f.run("cleanup", { fingerprint: plan.fingerprint, expected_revision: 2, confirm: true })).toMatchObject({ state: "conflict" });
    expect(f.store.bundle("lifecycle", first!.digest)).toEqual(first);
  });
});

it("cleanup previews are session-bound, expiring and replaced with at most one row per Skill", async () => {
  const [first, second, third] = await Promise.all([bundle(0), bundle(1), bundle(2)]);
  await runInDurableObject(owner(), async (_instance, state) => {
    const f = fixture(state); f.store.install(first!, 0); f.store.install(second!, 1); f.store.install(third!, 2);
    const old = preview(await f.run("cleanup-preview", { digests: [first!.digest], expected_revision: 3 }));
    const current = preview(await f.run("cleanup-preview", { digests: [second!.digest], expected_revision: 3 }));
    const command = { fingerprint: current.fingerprint, expected_revision: 3, confirm: true };
    expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM skill_cleanup_plans_v1").toArray()).toEqual([{ count: 1 }]);
    expect(await f.run("cleanup", { ...command, fingerprint: old.fingerprint })).toEqual({ state: "conflict" });
    expect(await f.run("cleanup", command, "b".repeat(64))).toEqual({ state: "denied" });
    expect(await f.run("cleanup", { ...command, confirm: false })).toEqual({ state: "invalid" });
    f.now(current.expires_at_ms);
    expect(await f.run("cleanup", command)).toEqual({ state: "expired" });
    expect(f.repository.history("lifecycle")!.versions).toHaveLength(3);
  });
});

it("cleanup rechecks the actual protected set and rolls back all content and metadata on a storage fault", async () => {
  const [first, second] = await Promise.all([bundle(0), bundle(1)]);
  await runInDurableObject(owner(), async (_instance, state) => {
    const f = fixture(state); f.store.install(first!, 0); f.store.install(second!, 1);
    const plan = preview(await f.run("cleanup-preview", { digests: [first!.digest], expected_revision: 2 }));
    const capacity = f.repository.history('lifecycle')!.capacity;
    state.storage.sql.exec("UPDATE skill_version_metadata_v1 SET pinned=1 WHERE digest=?", first!.digest);
    expect(await f.run("cleanup", { fingerprint: plan.fingerprint, expected_revision: 2, confirm: true })).toEqual({ state: "protected" });
    state.storage.sql.exec("UPDATE skill_version_metadata_v1 SET pinned=0 WHERE digest=?", first!.digest);
    state.storage.sql.exec("CREATE TRIGGER reject_skill_cleanup BEFORE DELETE ON skill_bundles_v2 BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    expect(await f.run("cleanup", { fingerprint: plan.fingerprint, expected_revision: 2, confirm: true })).toEqual({ state: "unknown" });
    expect(f.store.bundle("lifecycle", first!.digest)).toEqual(first);
    expect(f.repository.history("lifecycle")!.head.revision).toBe(2);
    expect(f.repository.history('lifecycle')!.capacity).toEqual(capacity);
    expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM skill_cleanup_plans_v1").toArray()).toEqual([{ count: 1 }]);
    expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM skill_version_metadata_v1 WHERE digest=?", first!.digest).toArray()).toEqual([{ count: 1 }]);
  });
});

it("cleanup rejects a changed preview byte total before deleting retained content", async () => {
  const [first, second] = await Promise.all([bundle(0), bundle(1)]);
  await runInDurableObject(owner(), async (_instance, state) => {
    const f = fixture(state); f.store.install(first!, 0); f.store.install(second!, 1);
    const before = f.repository.history("lifecycle")!;
    const plan = preview(await f.run("cleanup-preview", { digests: [first!.digest], expected_revision: 2 }));
    state.storage.sql.exec("UPDATE skill_cleanup_plans_v1 SET plan_json=? WHERE skill_id=?", JSON.stringify({ ...plan, bytes: plan.bytes + 1 }), "lifecycle");
    expect(await f.run("cleanup", { fingerprint: plan.fingerprint, expected_revision: 2, confirm: true })).toEqual({ state: "conflict" });
    expect(f.repository.history("lifecycle")).toEqual(before);
    expect(f.store.bundle("lifecycle", first!.digest)).toEqual(first);
  });
});

it("a capacity projection fault rolls back already deleted Skill files and versions", async () => {
  const [first, second] = await Promise.all([bundle(0), bundle(1)]);
  await runInDurableObject(owner(), async (_instance, state) => {
    const f = fixture(state); f.store.install(first!, 0); f.store.install(second!, 1);
    const before = f.repository.history('lifecycle')!;
    const plan = preview(await f.run('cleanup-preview', { digests: [first!.digest], expected_revision: 2 }));
    state.storage.sql.exec("CREATE TRIGGER reject_capacity BEFORE UPDATE ON skill_library_capacity_v1 BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    expect(await f.run('cleanup', { fingerprint: plan.fingerprint, expected_revision: 2, confirm: true })).toEqual({ state: 'unknown' });
    expect(f.store.bundle(first!.skill_id, first!.digest)).toEqual(first);
    expect(f.repository.history('lifecycle')).toEqual(before);
    state.storage.sql.exec('DROP TRIGGER reject_capacity');
    expect(await f.run('cleanup', { fingerprint: plan.fingerprint, expected_revision: 2, confirm: true })).toMatchObject({ state: 'cleaned', capacity: { skill_versions: 1, library_skills: 1 } });
  });
});

it("Skill history reads constant-size capacity even when other Skills fill the library", async () => {
  const versions = await Promise.all(Array.from({ length: 32 }, (_, index) => bundle(index)));
  await runInDurableObject(owner(), (_instance, state) => {
    const f = fixture(state);
    versions.forEach((version, index) => f.store.install(version, index));
    // Other libraries use valid metadata; history intentionally never loads file bodies.
    for (let index = 0; index < 40; index++) {
      const id = 'other-' + index;
      state.storage.sql.exec("INSERT INTO skill_heads_v1 VALUES (?,1,?,?,1)", id, versions[0]!.digest, versions[0]!.digest);
      for (const version of versions) state.storage.sql.exec("INSERT INTO skill_bundles_v2 VALUES (?,?,?,?,?,?,1)",
        id, version.digest, JSON.stringify({ ...version, skill_id: id, files: undefined }), '{}', 1000, 1);
    }
    // Reproduce the pre-projection schema-2 migration boundary.
    state.storage.sql.exec("DROP TABLE skill_capacity_v1"); state.storage.sql.exec("DROP TABLE skill_library_capacity_v1");
    const restored = new SkillLifecycleState(state.storage, () => undefined, f.store);
    const before = restored.history('lifecycle')!; expect(before.capacity.library_skills).toBe(41);
    const cursors: SqlStorageCursor[] = [], original = state.storage.sql.exec.bind(state.storage.sql);
    const spy = vi.spyOn(state.storage.sql, 'exec').mockImplementation((query: string, ...args: any[]) => {
      const cursor = original(query, ...args); cursors.push(cursor); return cursor;
    });
    try {
      expect(restored.history('lifecycle')).toEqual(before);
      expect(cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0)).toBeLessThanOrEqual(70);
      expect(cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0)).toBe(0);
    } finally { spy.mockRestore(); }
  });
});

it("authorization is rechecked before previews or destructive writes and history comparisons are revision-bound", async () => {
  const [first, second] = await Promise.all([bundle(0), bundle(1)]);
  await runInDurableObject(owner(), async (_instance, state) => {
    const f = fixture(state); f.store.install(first!, 0); f.store.install(second!, 1);
    f.onAuthorize(() => { if (f.calls() === 2) f.deny(); });
    expect(await f.run("cleanup-preview", { digests: [first!.digest], expected_revision: 2 })).toEqual({ state: "denied" });
    expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM skill_cleanup_plans_v1").toArray()).toEqual([{ count: 0 }]);
    const fresh = fixture(state);
    fresh.onAuthorize(() => { if (fresh.calls() === 2) fresh.store.activate("lifecycle", first!.digest, 2); });
    expect(await fresh.run("compare", { before: first!.digest, after: second!.digest })).toEqual({ state: "conflict" });
  });
});
