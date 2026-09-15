import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  test: {
    exclude: ["**/node_modules/**", "**/.git/**", "**/.audit/**", "**/dist/**"],
    ...(process.env.RUNMESH_TEST_RESULT_PATH === undefined ? {} : {
      reporters: ["default", "json"], outputFile: process.env.RUNMESH_TEST_RESULT_PATH,
    }),
    include: ["test/e2e/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    fileParallelism: false,
  },
});
