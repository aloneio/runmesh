import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  test: {
    include: ["test/browser/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.git/**", "**/.audit/**", "**/dist/**"],
    ...(process.env.RUNMESH_TEST_RESULT_PATH === undefined ? {} : {
      reporters: ["default", "json"], outputFile: process.env.RUNMESH_TEST_RESULT_PATH,
    }),
    testTimeout: 45_000,
    hookTimeout: 90_000,
    pool: "forks",
    fileParallelism: false,
  },
});
