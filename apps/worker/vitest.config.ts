import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: { bindings: {
      ADMIN_TOKEN: "test-admin-token-0123456789abcdef",
      SETUP_TOKEN: "test-setup-token-0123456789abcdef",
      RUNNER_TOKEN_PEPPER: "test-runner-token-pepper-not-for-production",
      INTERNAL_CONTROL_SECRET: "test-internal-control-secret-not-for-production",
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
