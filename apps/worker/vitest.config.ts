import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    // Use an isolated Wrangler environment so production's hosted bootstrap
    // vars never leak into requests exercised by the local Worker harness.
    wrangler: { configPath: "./wrangler.jsonc", environment: "test" },
    miniflare: { bindings: {
      ADMIN_TOKEN: "test-admin-token-0123456789abcdef",
      SETUP_TOKEN: "test-setup-token-0123456789abcdef",
      RUNNER_TOKEN_PEPPER: "test-runner-token-pepper-not-for-production",
      INTERNAL_CONTROL_SECRET: "test-internal-control-secret-not-for-production",
      RUNMESH_PUBLIC_ORIGIN: "",
      RUNMESH_SIGNED_RELEASE_AVAILABLE: "",
    } },
  })],
  test: {
    pool: "@cloudflare/vitest-pool-workers",
    // Durable-object startup/KDF tests can exceed Vitest's five-second
    // default on a cold Miniflare isolate. This is a test harness bound only.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
