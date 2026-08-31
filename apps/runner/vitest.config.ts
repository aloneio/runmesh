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
  test: {
    // Filesystem/process tests are materially slower on Windows (and on
    // freshly provisioned CI hosts) than Vitest's five-second default. Keep
    // the suite deterministic without changing production timeouts.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    aliases: {
      [protocolPackage.name]: fileURLToPath(new URL("../../packages/protocol/src/index.ts", import.meta.url)),
    },
  },
});
