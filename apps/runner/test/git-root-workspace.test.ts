import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { describe, expect, it } from "vitest";
import { GitService } from "../src/git-service.js";
import { createIsolatedGitContext } from "../src/git/isolated-context.js";
import { isolatedGitEnvironment, isPathWithin, trustedGitPathEntries } from "../src/git/trust.js";
import { PathPolicy } from "../src/path-policy.js";

const root = parse(process.cwd()).root;
const workspace = join(root, "workspace");

describe("filesystem-root Git boundaries", () => {
  it.each([
    [root, root, true],
    [join(root, ".git"), root, true],
    [join(root, "usr", "bin"), root, true],
    [join(workspace, ".git"), workspace, true],
    [workspace, workspace, true],
    [join(root, "workspace-other", ".git"), workspace, false],
    [root, workspace, false],
    [workspace + "/../outside", workspace, false],
    [workspace + "/nested/../.git", workspace, true],
    [join(workspace, ".git"), workspace + "/", true],
    ["relative-child", root, false],
  ] as const)("contains %s in %s: %s", (candidate, parent, expected) => {
    expect(isPathWithin(candidate, parent)).toBe(expected);
  });

  it.skipIf(process.platform !== "win32")("handles drive roots, case folding, and UNC share boundaries", () => {
    expect(isPathWithin("C:\\Windows\\System32", "c:\\")).toBe(true);
    expect(isPathWithin("D:\\outside", "C:\\")).toBe(false);
    expect(isPathWithin("\\\\server\\share\\repo", "\\\\server\\share\\")).toBe(true);
    expect(isPathWithin("\\\\server\\share-other\\repo", "\\\\server\\share\\")).toBe(false);
  });

  it("does not trust a system Git path inside a filesystem-root workspace", () => {
    expect(trustedGitPathEntries(root)).toEqual([]);
    expect(() => isolatedGitEnvironment(join(tmpdir(), "unused-git-context"), root))
      .toThrow(/no trusted Git executable directory/i);
  });

  it("rejects root inspection before reading repository metadata or creating an isolated directory", async () => {
    await expect(createIsolatedGitContext(root)).rejects.toMatchObject({
      code: "git_unavailable", message: expect.stringMatching(/filesystem-root.*dedicated workspace directory/i),
    });
    await expect(createIsolatedGitContext(root + ".")).rejects.toMatchObject({
      code: "git_unavailable", message: expect.stringMatching(/filesystem-root/i),
    });
  });

  it.each(["status", "diff", "log", "show", "blame"] as const)("gives git.%s the same actionable root-workspace failure", async (method) => {
    const service = new GitService(new PathPolicy([{ workspaceId: "root", rootPath: root, readonly: true, shell: false }]));
    await expect(service[method]({ workspace_id: "root", path: ".", revision: "a".repeat(40) })).rejects.toMatchObject({
      code: "git_unavailable", message: expect.stringMatching(/filesystem-root.*dedicated workspace directory/i),
    });
  });
});
