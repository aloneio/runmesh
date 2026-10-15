import { CATALOG_LIMITS } from "./catalog.js";
import { catalogKeys, catalogObject, toolName } from "./catalog-json.js";
import type { RemoteToolIssue } from "./remote.js";
export function parseRemoteToolIssues(value: unknown): readonly RemoteToolIssue[] | undefined {
  if (!Array.isArray(value) || value.length > CATALOG_LIMITS.tools) return undefined;
  const result: RemoteToolIssue[] = [];
  for (const entry of value) {
    const item = catalogObject(entry);
    if (!item || !catalogKeys(item, ["name", "code"]) || item.name !== null && !toolName(item.name)
      || !["invalid_tool", "schema_unsupported", "interaction_required"].includes(item.code as string)) return undefined;
    result.push({ name: item.name as string | null, code: item.code as RemoteToolIssue["code"] });
  }
  return result;
}
