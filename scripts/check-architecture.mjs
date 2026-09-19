import { fileURLToPath } from "node:url";
import { checkArchitecture } from "./architecture-graph.mjs";

try {
  const report = await checkArchitecture(fileURLToPath(new URL("../", import.meta.url)));
  if (report.failures.length) {
    console.error(`Architecture check failed:\n${report.failures.map(value => `- ${value}`).join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ architecture: "source-dependencies-v1", modules: report.files.length, edges: report.edges.length,
      runtime_cycles: report.runtimeCycles.length, type_cycles: report.typeCycles.length, type_cycle_modules: report.typeCycles, source_bytes: report.sourceBytes }));
  }
} catch {
  console.error("Architecture check failed: source inventory or parser unavailable; no files modified.");
  process.exitCode = 1;
}
