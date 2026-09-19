import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { checkProjectDocuments } from "./project-facts.mjs";

try {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || args.length === 1 && args[0] === "--write", "Use check-project-facts [--write]");
  await checkProjectDocuments(fileURLToPath(new URL("../", import.meta.url)), args[0] === "--write");
  console.log("Source facts and all documented tool/action inputs verified; no deployment or execution was inferred.");
} catch (error) {
  console.error(`Source documentation verification failed: ${error instanceof Error ? error.message.split("\n")[0] : "invalid input"}`);
  process.exitCode = 1;
}
