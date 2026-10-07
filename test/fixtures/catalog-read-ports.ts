import type { CatalogAdminPorts, CatalogReadPorts, CatalogSnapshotPorts, DirectoryReadPorts } from "../../apps/worker/src/contracts/catalog.js";
import type { RemoteCallPorts } from "../../apps/worker/src/contracts/remote.js";
import type { ToolSearchPorts } from "../../apps/worker/src/contracts/tool-search.js";
import type { createDependencyReader } from "../../apps/worker/src/application/capabilities/dependencies.js";

type Assert<T extends true> = T;
type ExactKeys<Value, Keys> = [keyof Value] extends [Keys] ? [Keys] extends [keyof Value] ? true : false : false;
type ReadMethods = "readHead" | "readSnapshot";
export type SnapshotReads = Assert<ExactKeys<CatalogSnapshotPorts["repository"], ReadMethods>>;
export type CatalogReads = Assert<ExactKeys<CatalogReadPorts["repository"], ReadMethods>>;
export type DirectoryReads = Assert<ExactKeys<DirectoryReadPorts["repository"], ReadMethods>>;
export type RemoteReads = Assert<ExactKeys<RemoteCallPorts["repository"], ReadMethods>>;
export type SearchReads = Assert<ExactKeys<ToolSearchPorts["repository"], ReadMethods>>;
export type DependencyReads = Assert<ExactKeys<Parameters<typeof createDependencyReader>[0]["repository"], ReadMethods>>;
export type AdminWrites = Assert<ExactKeys<CatalogAdminPorts["repository"], ReadMethods | "stage" | "publish" | "approve" | "disable">>;
export type RemoteDependencies = Assert<ExactKeys<RemoteCallPorts, "repository" | "profile" | "identity" | "digest" | "connector" | "observation">>;

declare const reader: CatalogReadPorts;
reader.repository.readHead("docs");
reader.repository.readSnapshot("docs", "a".repeat(64));
// @ts-expect-error Publication remains an administrator operation.
reader.repository.publish;
// @ts-expect-error Reading does not stage content.
reader.repository.stage;
// @ts-expect-error Reading does not approve content.
reader.repository.approve;
// @ts-expect-error Reading does not change availability.
reader.repository.disable;
declare const remote: RemoteCallPorts;
// @ts-expect-error Remote execution has no pagination dependency.
remote.cursor;
// @ts-expect-error Remote execution has no cursor-expiry clock dependency.
remote.now;
