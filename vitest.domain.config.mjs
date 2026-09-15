import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@aloneio/runmesh-protocol": fileURLToPath(new URL("./packages/protocol/src/index.ts", import.meta.url)) } },
  test: { include: ["test/domain/**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"], environment: "node", testTimeout: 5000, hookTimeout: 5000 },
});
