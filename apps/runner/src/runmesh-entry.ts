#!/usr/bin/env node
import { isCliErrorReported } from "./cli/reporting.js";
import { HELP } from "./cli/help.js";
import { assertSupportedNodeVersion, RUNNER_VERSION } from "./version.js";

async function runEntry(argv: readonly string[]): Promise<void> {
  assertSupportedNodeVersion();
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) { process.stdout.write(`${HELP}\n`); return; }
  if (argv.length === 1 && argv[0] === "--version") { process.stdout.write(`${RUNNER_VERSION}\n`); return; }
  if (argv[0] === "enroll") {
    const { runEnrollCli } = await import("./cli/enrollment.js");
    await runEnrollCli(argv.slice(1));
    return;
  }
  const { runCli } = await import("./cli.js");
  await runCli(argv);
}

runEntry(process.argv.slice(2)).catch((error: unknown) => {
  if (!isCliErrorReported(error)) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Runmesh Runner command failed: ${detail}\n`);
  }
  process.exitCode = 1;
});
