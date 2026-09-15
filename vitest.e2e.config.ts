import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
