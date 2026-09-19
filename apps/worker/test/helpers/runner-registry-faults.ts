import { RunnerDO } from "../../src/runner-do.js";
import { requestRunnerRegistry } from "../../src/platform/runner-registry.js";
import type { RegistryRequestPort } from "../../src/contracts/runner-transport.js";
import type { WorkerEnv } from "../../src/platform/env.js";

export interface RegistryFaults { request: RegistryRequestPort; }
/** Keep the real DO storage and lifecycle; inject only its existing I/O port. */
export function runnerRegistryFaults(state: DurableObjectState, env: WorkerEnv, request?: RegistryRequestPort) {
  const registry: RegistryFaults = { request: request ?? ((runnerId, action, init) => requestRunnerRegistry(env, runnerId, action, init)) };
  return { registry, runner: new RunnerDO(state, env, { registryRequest: (runnerId, action, init) => registry.request(runnerId, action, init) }) };
}
