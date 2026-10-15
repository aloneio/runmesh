import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_MANIFEST_REVISION,
  BOOTSTRAP_REMOTE_PROFILE_LIMIT,
  bootstrapStaticContractForTest,
  buildBootstrapManifest,
} from "../src/mcp/bootstrap-manifest.js";
import { BootstrapOutputSchema } from "../src/mcp/output-contracts.js";
import { sha256Hex } from "../src/security.js";

describe("bootstrap manifest", () => {
  it("publishes a stable static contract plus bounded dynamic summaries", async () => {
    const profiles = Array.from({ length: BOOTSTRAP_REMOTE_PROFILE_LIMIT + 3 }, (_, index) => ({
      profile_id: "service-" + index,
      name: "service " + index,
    }));
    const result = await buildBootstrapManifest({
      runner: { selection: "selected", state: "online", available: true },
      remote_mcp: { state: "ready", profile_count: profiles.length, profiles },
      skills: { state: "ready", page_count: 4, has_more: false },
    });

    expect(BootstrapOutputSchema.safeParse(result).success).toBe(true);
    expect(result.manifest).toEqual({
      revision: BOOTSTRAP_MANIFEST_REVISION,
      sha256: await sha256Hex(JSON.stringify(bootstrapStaticContractForTest)),
      digest_scope: "static_contract",
    });
    expect(result.directory.remote_mcp.profiles).toHaveLength(BOOTSTRAP_REMOTE_PROFILE_LIMIT);
    expect(result.directory.remote_mcp).toMatchObject({ profile_count: profiles.length, profiles_truncated: true });
    expect(result.authorization.bootstrap_grants_permissions).toBe(false);
    expect(result.usage.full_remote_schemas_included).toBe(false);
  });

  it("keeps the response compact when optional directories are unavailable", async () => {
    const result = await buildBootstrapManifest({
      runner: { selection: "unavailable", state: null, available: false },
      remote_mcp: { state: "unavailable" },
      skills: { state: "disabled" },
    });

    expect(BootstrapOutputSchema.safeParse(result).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(8 * 1024);
    expect(result.directory.remote_mcp).not.toHaveProperty("profile_count");
    expect(result.directory.skills).not.toHaveProperty("page_count");
  });
});
