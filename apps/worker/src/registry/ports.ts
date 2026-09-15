import type { RunnerRecord, RegistryFeatureKey, RunnerRow } from './records.js';

/** Narrow synchronous collaboration ports. No concrete DO/service imports. */
export interface AuthPorts {
  disableFeatureHealth(feature: RegistryFeatureKey, error: unknown, nowMs?: number, cooldownMs?: number): void;
  featureHealthDisabled(feature: RegistryFeatureKey, nowMs?: number): boolean;
  listRunners(): RunnerRecord[];
  runnerRow(runnerId: string): RunnerRow | undefined;
}
