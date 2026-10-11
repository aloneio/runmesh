#!/usr/bin/env node
import { runMaintenanceCli } from "./maintenance-cli.js";
import { isCliErrorReported } from "./cli/reporting.js";

runMaintenanceCli(process.argv.slice(2)).catch((error: unknown) => {
  if (!isCliErrorReported(error)) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Runmesh maintenance command failed: ${detail}\n`);
  }
  process.exitCode = 1;
});
