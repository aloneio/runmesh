import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { PatchService } from "../src/patch-service.js";
import { PathPolicy } from "../src/path-policy.js";

describe.each(["preview", "apply"] as const)("public patch %s with many short lines", operation => {
  it.each(["before", "after"] as const)("preserves 200,000 unchanged lines %s the hunk", async position => {
    const root = await mkdtemp(join(tmpdir(), "runmesh-many-lines-"));
    try {
      const unchanged = "\n".repeat(200_000);
      const baseline = position === "before" ? `${unchanged}original\n` : `original\n${unchanged}`;
      const expected = position === "before" ? `${unchanged}updated\n` : `updated\n${unchanged}`;
      const path = join(root, "many-lines.txt");
      await writeFile(path, baseline);
      const service = new PatchService(new PathPolicy([{ workspaceId: "lines", rootPath: await realpath(root), readonly: false, shell: false }]));
      const input = { workspace_id: "lines", patch: "*** Begin Patch\n*** Update File: many-lines.txt\n@@\n-original\n+updated\n*** End Patch\n" };
      const result = await service[operation](input);
      expect(result).toMatchObject({ changed_paths: [{ path: "many-lines.txt", status: "updated" }] });
      if (operation === "preview") {
        expect(await readFile(path, "utf8")).toBe(baseline);
        await service.apply({ ...input, preview_id: result.preview_id });
      }
      expect(await readFile(path, "utf8")).toBe(expected);
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });
});
