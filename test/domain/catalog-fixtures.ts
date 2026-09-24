import type { ConnectionProfile } from "../../apps/worker/src/contracts/connectors.js";
// Computation-only fixtures shared with adapter tests; no storage or network I/O.
import type { CatalogSnapshot, RemoteToolDefinition } from "../../apps/worker/src/contracts/catalog.js";
import { buildCatalogSnapshot } from "../../apps/worker/src/domain/capabilities/catalog.js";
import { parseCatalogCommand } from "../../apps/worker/src/contracts/catalog-values.js";

export const catalogProfile = (id = "docs"): ConnectionProfile => ({ schema_version: 1, profile_id: id, connector_id: "docs-service",
  endpoint: "https://catalog-test.invalid/mcp", owner: { kind: "instance_admin" }, revision: 2, enabled: true,
  credential: { secret_id: id, secret_version: 1 } });
export const catalogDefinition = (name = "search", description = "Search fixture documents"): RemoteToolDefinition => ({ name, description,
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } });
export async function fixtureDigest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function catalogSnapshot(profileId = "docs", tools: readonly RemoteToolDefinition[] = [catalogDefinition()]): Promise<CatalogSnapshot> {
  const command = parseCatalogCommand({ action: "stage", profile_id: profileId, expected_revision: 0, tools });
  if (command?.action !== "stage") throw new Error("invalid fixture");
  const snapshot = await buildCatalogSnapshot(catalogProfile(profileId), command.tools, fixtureDigest, () => false);
  if (snapshot === undefined) throw new Error("invalid fixture snapshot");
  return snapshot;
}
