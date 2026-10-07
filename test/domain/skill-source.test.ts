import { expect, it, vi } from "vitest";
import { createSkillSourceService } from "../../apps/worker/src/application/skills/source.js";
import type { AdminDecision } from "../../apps/worker/src/contracts/connectors.js";
import type { SkillSourcePort, SkillSourcePorts } from "../../apps/worker/src/contracts/skill-source.js";
import type { SkillBundle, SkillMutation } from "../../apps/worker/src/contracts/skills.js";
import { parseSkillSource, skillSourceUrl } from "../../apps/worker/src/contracts/skill-source-values.js";
import { fixtureDigest } from "./catalog-fixtures.js";

const source = { repository: "https://github.com/example/skills", commit: "a".repeat(40), path: "skills/research" },
  files = [{ path: "SKILL.md", text: "---\nname: research\ndescription: Research documentation\nlicense: MIT\n---\nRead and verify references.\n" }];
function fixture() {
  const ports = {
    source: { read: vi.fn(async (): ReturnType<SkillSourcePort["read"]> => ({ state: "read", files })) },
    repository: { install: vi.fn((bundle: SkillBundle, revision: number): SkillMutation => ({ state: "written", head: {
      skill_id: bundle.skill_id, revision: revision + 1, staged_digest: bundle.digest, active_digest: bundle.digest, enabled: true } })) },
    admin: vi.fn(async (): Promise<AdminDecision> => "allowed"), digest: vi.fn(fixtureDigest),
  } satisfies SkillSourcePorts;
  return { ports, run: (action: "preview" | "install", input: unknown = { source, expected_revision: 0 }, signal = new AbortController().signal) => createSkillSourceService(ports)("session", action, input, signal) };
}

it("RM07 accepts a public GitHub repository pinned to a full commit", () => {
  expect(parseSkillSource({ ...source, repository: "https://github.com/example/skills.git/" })).toEqual(source);
  expect(parseSkillSource({ ...source, path: "" })).toEqual({ ...source, path: "" });
  expect(skillSourceUrl(source)).toBe(`https://github.com/example/skills/tree/${source.commit}/skills/research`);
});

it.each([
  { repository: "https://github.com.example.org/example/skills" }, { repository: "https://token@github.com/example/skills" },
  { repository: "http://github.com/example/skills" }, { repository: "https://gitlab.com/example/skills" },
  { repository: "https://github.com/example/skills?token=private" }, { repository: "https://github.com/example/skills/tree/main" },
  { commit: "main" }, { commit: "a".repeat(7) }, { commit: "a".repeat(39) }, { commit: "A".repeat(40) },
  { path: "../private" }, { path: "skills//research" }, { path: "a/".repeat(8) + "b" },
  { token: "private" },
])("RM07 rejects a noncanonical source %j", change => {
  expect(parseSkillSource({ ...source, ...change })).toBeUndefined();
});

it("RM07 previews deterministic metadata and performs one atomic install at the supplied revision", async () => {
  const f = fixture(), preview = await f.run("preview");
  expect(preview.state).toBe("previewed");
  if (preview.state !== "previewed" || !("source" in preview)) throw new Error(preview.state);
  expect(preview.bundle).toMatchObject({ skill_id: "research", name: "research", license: "MIT", source: skillSourceUrl(source), files });
  expect(f.ports.repository.install).not.toHaveBeenCalled();
  const result = await f.run("install", { source, expected_revision: 7, digest: preview.bundle.digest });
  expect(result).toMatchObject({ state: "written", head: { revision: 8, active_digest: preview.bundle.digest, staged_digest: preview.bundle.digest, enabled: true } });
  expect(f.ports.repository.install).toHaveBeenCalledExactlyOnceWith(preview.bundle, 7);
  expect(f.ports.source.read).toHaveBeenCalledTimes(2);
  expect(f.ports.admin).toHaveBeenCalledTimes(4);
});

it("RM07 requires the previewed digest and never installs changed content", async () => {
  const f = fixture(), preview = await f.run("preview");
  if (preview.state !== "previewed") throw new Error(preview.state);
  f.ports.source.read.mockResolvedValueOnce({ state: "read", files: [{ ...files[0]!, text: files[0]!.text + "Changed" }] });
  expect(await f.run("install", { source, expected_revision: 0, digest: preview.bundle.digest })).toEqual({ state: "changed" });
  expect(f.ports.repository.install).not.toHaveBeenCalled();
});

it("RM07 checks administrator identity before source reads and again before publication", async () => {
  const f = fixture();
  f.ports.admin.mockResolvedValueOnce("denied");
  expect(await f.run("preview")).toEqual({ state: "denied" });
  expect(f.ports.source.read).not.toHaveBeenCalled();
  f.ports.admin.mockResolvedValueOnce("allowed").mockResolvedValueOnce("denied");
  expect(await f.run("install", { source, expected_revision: 0, digest: "b".repeat(64) })).toEqual({ state: "denied" });
  expect(f.ports.repository.install).not.toHaveBeenCalled();
});

it("RM07 cancellation prevents reads and publication and failures are not replayed", async () => {
  const f = fixture();
  expect(await f.run("preview", { source, expected_revision: 0 }, AbortSignal.abort())).toEqual({ state: "unavailable" });
  expect(f.ports.source.read).not.toHaveBeenCalled();
  const abort = new AbortController();
  f.ports.source.read.mockImplementationOnce(async () => { abort.abort(); return { state: "read", files }; });
  expect(await f.run("preview", { source, expected_revision: 0 }, abort.signal)).toEqual({ state: "unavailable" });
  f.ports.source.read.mockRejectedValueOnce(new Error("synthetic read failure"));
  expect(await f.run("preview")).toEqual({ state: "unavailable" });
  expect(f.ports.source.read).toHaveBeenCalledTimes(2);
  expect(f.ports.repository.install).not.toHaveBeenCalled();
});

it("RM07 returns concurrent revision conflicts without retrying the mutation", async () => {
  const f = fixture(), preview = await f.run("preview");
  if (preview.state !== "previewed") throw new Error(preview.state);
  f.ports.repository.install.mockReturnValueOnce({ state: "conflict", current_revision: 4 });
  expect(await f.run("install", { source, expected_revision: 3, digest: preview.bundle.digest })).toEqual({ state: "conflict", current_revision: 4 });
  expect(f.ports.repository.install).toHaveBeenCalledOnce();
});

it("RM07 preserves an unknown publication outcome and leaves recovery to the caller", async () => {
  const f = fixture(), preview = await f.run("preview");
  if (preview.state !== "previewed") throw new Error(preview.state);
  f.ports.repository.install.mockReturnValueOnce({ state: "unknown" });
  expect(await f.run("install", { source, expected_revision: 0, digest: preview.bundle.digest })).toEqual({ state: "unknown" });
  expect(f.ports.repository.install).toHaveBeenCalledOnce();
  expect(f.ports.source.read).toHaveBeenCalledTimes(2);
});

it("RM07 separates source download capacity from retained library capacity", async () => {
  const f = fixture(); f.ports.source.read.mockResolvedValueOnce({ state: "capacity" });
  expect(await f.run("preview")).toEqual({ state: "source_capacity" });
  const preview = await f.run("preview");
  if (preview.state !== "previewed") throw new Error(preview.state);
  f.ports.repository.install.mockReturnValueOnce({ state: "capacity" });
  expect(await f.run("install", { source, expected_revision: 0, digest: preview.bundle.digest })).toEqual({ state: "capacity" });
  expect(f.ports.repository.install).toHaveBeenCalledOnce();
});

it("RM07 reports thrown publication results as unknown without an automatic retry", async () => {
  const f = fixture(), preview = await f.run("preview");
  if (preview.state !== "previewed") throw new Error(preview.state);
  f.ports.repository.install.mockImplementationOnce(() => { throw new Error("publication result lost"); });
  expect(await f.run("install", { source, expected_revision: 0, digest: preview.bundle.digest })).toEqual({ state: "unknown" });
  expect(f.ports.repository.install).toHaveBeenCalledOnce();
});

it("RM07 treats a preview returned by the install port as an incomplete publication receipt", async () => {
  const f = fixture(), preview = await f.run("preview");
  if (preview.state !== "previewed") throw new Error(preview.state);
  f.ports.repository.install.mockReturnValueOnce({ state: "previewed", bundle: preview.bundle });
  expect(await f.run("install", { source, expected_revision: 0, digest: preview.bundle.digest })).toEqual({ state: "unknown" });
  expect(f.ports.repository.install).toHaveBeenCalledOnce();
  expect(f.ports.source.read).toHaveBeenCalledTimes(2);
});

it.each([-1, 1.5, Number.MAX_SAFE_INTEGER, "0"])("RM07 rejects invalid revision %s before source access", async expected_revision => {
  const f = fixture();
  expect(await f.run("preview", { source, expected_revision })).toEqual({ state: "invalid" });
  expect(f.ports.source.read).not.toHaveBeenCalled();
});
