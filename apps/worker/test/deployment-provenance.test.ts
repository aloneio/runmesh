import { env } from "cloudflare:test";
import { expect, it, vi } from "vitest";

const source = vi.hoisted(() => ({ schema_version: 1, state: "clean", commit: "a".repeat(40), tree: "b".repeat(40), branch: "main", reason: null }));
vi.mock("../src/generated-provenance.js", () => ({ BUILD_PROVENANCE: source }));
import { deploymentProvenance } from "../src/deployment-provenance.js";
import worker from "../src/index.js";

it("R01 untagged builds report compiled source instead of losing all deployment identity", () => {
  expect(deploymentProvenance({}, source)).toMatchObject({ state: "identified", source: "git_build", branch: "main", commit: source.commit, tree: source.tree, agreement: "not_comparable", attestation: "self_reported" });
});

it("R01 matching provider metadata corroborates but does not turn source into a signature", () => {
  const metadata = { id: "A1234567-1234-1234-1234-123456789ABC", tag: `main:${source.commit}`, timestamp: "2026-09-15T05:00:00Z" };
  expect(deploymentProvenance({ CF_VERSION_METADATA: metadata }, source)).toMatchObject({ state: "identified", agreement: "matched", attestation: "self_reported", provider: { version_id: metadata.id.toLowerCase(), created_at: "2026-09-15T05:00:00.000Z", tag_state: "recognized" } });
});

it.each([`main:${"c".repeat(40)}`, `dev:${"a".repeat(40)}`])("R01 incompatible provider tag %s is not silently preferred", tag => {
  expect(deploymentProvenance({ CF_VERSION_METADATA: { tag } }, source)).toMatchObject({ state: "conflict", reason: "provider_mismatch", branch: null, commit: null, tree: null, agreement: "conflict" });
});

it.each(["dirty", "unavailable", "conflict"])("R01 %s source cannot be rescued by a plausible provider tag", state => {
  const build = { schema_version: 1, state, reason: state === "dirty" ? "dirty_checkout" : state === "conflict" ? "metadata_conflict" : "git_unavailable", commit: null, tree: null, branch: null };
  expect(deploymentProvenance({ CF_VERSION_METADATA: { tag: `main:${source.commit}` } }, build)).toMatchObject({ state: state === "conflict" ? "conflict" : "unavailable", commit: null, branch: null, source: null });
});

it("R01 malformed provider and build fields never leak arbitrary strings or paths", () => {
  const value = deploymentProvenance({ CF_VERSION_METADATA: { id: "/private/path", tag: "secret-url-token", timestamp: "wrong", token: "private-token" } }, { ...source, commit: "secret/path", author: "private-email" });
  expect(value).toMatchObject({ state: "unavailable", build_state: "invalid", commit: null, provider: { version_id: null, created_at: null, tag_state: "unrecognized", branch: null, commit: null } });
  for (const secret of ["private", "secret-url", "private-email"]) expect(JSON.stringify(value)).not.toContain(secret);
});

it("R01 detached source keeps its verified commit without inventing a branch", () => {
  expect(deploymentProvenance({}, { ...source, branch: null })).toMatchObject({ state: "identified", branch: null, commit: source.commit });
  expect(deploymentProvenance({ CF_VERSION_METADATA: { tag: `dev:${source.commit}` } }, { ...source, branch: null })).toMatchObject({ branch: "dev", agreement: "matched" });
});

it("R01 invalid tag text does not erase a clean compiled source identity", () => {
  expect(deploymentProvenance({ CF_VERSION_METADATA: { tag: "v0.1.3" } }, source)).toMatchObject({ state: "identified", commit: source.commit, agreement: "not_comparable", provider: { tag_state: "unrecognized" } });
});

it("R01 public health reads no authority or history storage to report provenance", async () => {
  const inaccessible = new Proxy({}, { get() { throw new Error("storage must not be accessed"); } });
  const input = { ...env, REGISTRY: inaccessible, RUNNER: inaccessible, HISTORY_DB: inaccessible, CF_VERSION_METADATA: {} } as unknown as typeof env;
  const response = await worker.fetch(new Request("https://test.example/health"), input, {} as ExecutionContext);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  const result = await response.json() as any;
  expect(result.deployment).toMatchObject({ state: "identified", commit: source.commit, source: "git_build" });
  expect(JSON.stringify(result.deployment).length).toBeLessThan(1024);
  const date = vi.spyOn(Date, "now");
  for (let index = 0; index < 1000; index++) deploymentProvenance({}, source);
  expect(date).not.toHaveBeenCalled(); date.mockRestore();
});
