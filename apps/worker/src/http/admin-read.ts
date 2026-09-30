import { json } from "../platform/control-plane.js";
import { record } from "../values.js";

/** A failed or incomplete read is distinct from a successfully empty list. */
export async function registryRecord(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    if (response.status !== 200) { void response.body?.cancel().catch(() => undefined); return undefined; }
    return record(await json(response));
  } catch { return undefined; }
}

export function recordArray(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows = value.map(record);
  return rows.every((row): row is Record<string, unknown> => row !== undefined) ? rows : undefined;
}

export async function registryArray(response: Response, key: string): Promise<Record<string, unknown>[] | undefined> {
  return recordArray((await registryRecord(response))?.[key]);
}
