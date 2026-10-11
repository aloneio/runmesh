#!/usr/bin/env node
import { runCli } from "./cli.js";
import { isCliErrorReported } from "./cli/reporting.js";

runCli(process.argv.slice(2)).catch((error: unknown) => {
  if (!isCliErrorReported(error)) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Runmesh Runner command failed: ${detail}\n`);
  }
  process.exitCode = 1;
});
