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
    aliases: {
      [protocolPackage.name]: fileURLToPath(new URL("../../packages/protocol/src/index.ts", import.meta.url)),
    },
  },
});
