#!/usr/bin/env node
import { runMaintenanceCli } from "./maintenance-cli.js";

runMaintenanceCli(process.argv.slice(2)).catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Runmesh maintenance startup failed: ${detail}\n`);
  process.exitCode = 1;
});
