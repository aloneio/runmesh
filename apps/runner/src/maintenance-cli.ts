import type { MaintenanceCliDependencies } from "./cli/contracts.js";
import { MAINTENANCE_SERVICE_COMMANDS } from "./maintenance-contract.js";
import { parseProductArgs, requiredString, storeFor } from "./cli/input.js";
import { serviceCommand, uninstall } from "./cli/lifecycle.js";
import { markCliErrorReported } from "./cli/reporting.js";
import { runMaintenanceAgent } from "./updates/agent.js";
import { refreshMaintenanceManager } from "./updates/manager-refresh.js";
import { assertSupportedNodeVersion, RUNNER_VERSION } from "./version.js";

const MANAGEMENT_COMMANDS = new Set<string>(MAINTENANCE_SERVICE_COMMANDS);
const HELP = `Runmesh maintenance\nUsage: runmesh-maintenance <maintenance-agent|manager-refresh|${MAINTENANCE_SERVICE_COMMANDS.join("|")}> [options]\n\nRefresh the independent manager from a local signed release:\n  manager-refresh --profile <existing-profile> --install-root <root> --release-dir <signed-assets> [--user] [--json]\n\n  --help     Show maintenance commands\n  --version  Show the maintenance package version`;

/** The manager's entry graph excludes the selected Runner CLI and executor. */
export async function runMaintenanceCli(argv: readonly string[], dependencies: MaintenanceCliDependencies = {}): Promise<void> {
  assertSupportedNodeVersion();
  const output = dependencies.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const error = dependencies.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) { output(HELP); return; }
  if (argv.length === 1 && argv[0] === "--version") { output(RUNNER_VERSION); return; }
  if (argv[0] !== "maintenance-agent" && argv[0] !== "manager-refresh" && !MANAGEMENT_COMMANDS.has(argv[0] ?? "")) throw new Error(HELP);
  const parsed = parseProductArgs(argv);
  try {
    if (parsed.command === "manager-refresh") {
      const result = await (dependencies.refreshMaintenanceManager ?? refreshMaintenanceManager)({
        profilePath: requiredString(parsed, "profilePath"),
        installRoot: requiredString(parsed, "installRoot"),
        releaseDirectory: requiredString(parsed, "releaseDirectory"),
        mode: parsed.values.user === true ? "user" : "system",
        ...(dependencies.servicePlatform === undefined ? {} : { platform: dependencies.servicePlatform }),
      });
      output(parsed.json ? JSON.stringify(result) : `Maintenance manager version: ${result.manager_version}`);
      return;
    }
    if (parsed.command === "maintenance-agent") {
      await (dependencies.startMaintenanceAgent ?? runMaintenanceAgent)({
        profilePath: requiredString(parsed, "profilePath"),
        installRoot: requiredString(parsed, "installRoot"),
        mode: parsed.values.user === true ? "user" : "system",
        ...(dependencies.servicePlatform === undefined ? {} : { platform: dependencies.servicePlatform }),
        ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      });
      return;
    }
    const store = dependencies.store ?? storeFor(parsed, dependencies.servicePlatform);
    if (parsed.command === "uninstall") { await uninstall(parsed, store, output, dependencies); return; }
    await serviceCommand(parsed, store, output, dependencies);
  } catch (cause) {
    error(cause instanceof Error ? cause.message : String(cause));
    throw markCliErrorReported(cause);
  }
}
