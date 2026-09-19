import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const protocolPackage = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../packages/protocol/package.json", import.meta.url)),
    "utf8",
  ),
) as { name: string };

export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  resolve: {
    alias: {
      [protocolPackage.name]: fileURLToPath(new URL("../../packages/protocol/src/index.ts", import.meta.url)),
    },
  },
  test: {
    // These native fixtures spawn real Git/Node processes. Concurrent files
    // on Windows can exhaust the deliberately short production observation
    // budget; serialize the fixtures without changing that budget or assertions.
    fileParallelism: process.platform !== "win32",
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.git/**", "**/.audit/**", "**/dist/**"],
    setupFiles: [fileURLToPath(new URL("./test/setup.ts", import.meta.url))],
    // Filesystem/process tests are materially slower on Windows (and on
    // freshly provisioned CI hosts) than Vitest's five-second default. Keep
    // the suite deterministic without changing production timeouts.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
