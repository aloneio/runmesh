import type { CliDependencies, MaintenanceCliDependencies, ServiceProfilePort } from "../../apps/runner/src/cli/contracts.js";
import type { serviceManifestFor } from "../../apps/runner/src/cli/service-plan.js";
import type { ProfileStore } from "../../apps/runner/src/profile.js";

type Assert<T extends true> = T;
type ExactKeys<Value, Keys> = [keyof Value] extends [Keys] ? [Keys] extends [keyof Value] ? true : false : false;
export type MaintenanceCapabilities = Assert<ExactKeys<ServiceProfilePort, "filePath" | "load" | "save" | "remove" | "assertServiceOwnership">>;
export type PlanningReads = Assert<ExactKeys<Parameters<typeof serviceManifestFor>[1], "filePath" | "load">>;

const store: ServiceProfilePort = {
  filePath: "fixture/profile.json",
  async load() { return undefined; },
  async save() {},
  async remove() {},
  async assertServiceOwnership() {},
};
export const maintenance: MaintenanceCliDependencies = { store };
export const planning: Parameters<typeof serviceManifestFor>[1] = { filePath: store.filePath, load: store.load };

const incomplete = { filePath: store.filePath, load: store.load, save: store.save, remove: store.remove };
// @ts-expect-error Lifecycle commands require the ownership check.
export const missingOwnership: MaintenanceCliDependencies = { store: incomplete };
// @ts-expect-error Read-only planning does not expose profile mutations.
planning.save;
// @ts-expect-error Ordinary CLI operations still require the full profile store.
export const incompleteCli: CliDependencies = { store };
declare const concreteStore: ProfileStore;
export const ordinary: CliDependencies = { store: concreteStore };
export const concreteMaintenance: MaintenanceCliDependencies = { store: concreteStore };
