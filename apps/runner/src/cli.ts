import { access, rm } from "node:fs/promises";
import { parseRunnerArgs, validateRunnerConfig } from "./config.js";
import { RunnerConnection } from "./connection.js";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "start") {
    throw new Error("usage: coding-runner start --server <wss://host> [--token <token>|CODING_RUNNER_TOKEN] --runner-id <id> [--insecure-local] [--state-dir <path>] [--disconnect-after-ms <milliseconds>] [--workspace id=path]");
  }
  const config = await validateRunnerConfig(parseRunnerArgs(args));
  const runner = new RunnerConnection({
    config,
    onStateChange: (state) => process.stderr.write(`runner ${config.runnerId}: ${state}\n`),
  });
  if (config.disconnectControlFile !== undefined) {
    let disconnectControlBusy = false;
    const interval = setInterval(async () => {
      if (disconnectControlBusy) return;
      disconnectControlBusy = true;
      try {
        await access(config.disconnectControlFile as string);
        await rm(config.disconnectControlFile as string, { force: true });
        runner.disconnectForTest();
      } catch { /* control file absent */ }
      finally { disconnectControlBusy = false; }
    }, 50);
    interval.unref();
  }
  const stop = (): void => runner.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  // SIGUSR1 is intentionally a transport-only local test/operator control.
  // It never stops JobManager or signals child job process groups.
  process.on("SIGUSR1", () => runner.disconnectForTest());
  await runner.start();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
