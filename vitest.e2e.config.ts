import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import TestJsonReporter from "./scripts/test-json-reporter.mjs";

export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  test: {
    exclude: ["**/node_modules/**", "**/.git/**", "**/.audit/**", "**/dist/**"],
    ...(process.env.RUNMESH_TEST_RESULT_PATH === undefined ? {} : {
      reporters: ["default", new TestJsonReporter({ outputFile: process.env.RUNMESH_TEST_RESULT_PATH })],
    }),
    include: ["test/e2e/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    fileParallelism: false,
  },
});
