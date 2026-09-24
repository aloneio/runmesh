import { CATALOG_LIMITS } from "./catalog.js";

/** Bounded canonical JSON, never getter/toJSON evaluation or unbounded stringify.
 * Property order is normalized; arrays retain order. No source objects are mutated. */
export function catalogJson(value: unknown, maxBytes: number): string | undefined {
  let bytes = 0, nodes = 0;
  const chunks: string[] = [], active = new Set<object>(), encoder = new TextEncoder();
  const append = (text: string): void => {
    bytes += encoder.encode(text).byteLength;
    if (bytes > maxBytes) throw new Error("catalog_budget");
    chunks.push(text);
  };
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > CATALOG_LIMITS.nodes || depth > CATALOG_LIMITS.depth) throw new Error("catalog_budget");
    if (item === null || typeof item === "boolean") { append(String(item)); return; }
    if (typeof item === "number") {
      if (!Number.isFinite(item) || Math.abs(item) > Number.MAX_SAFE_INTEGER) throw new Error("catalog_number");
      append(JSON.stringify(item)); return;
    }
    if (typeof item === "string") {
      if (item.length > maxBytes) throw new Error("catalog_budget");
      append(JSON.stringify(item)); return;
    }
    if (typeof item !== "object" || active.has(item)) throw new Error("catalog_value");
    const array = Array.isArray(item), proto = Object.getPrototypeOf(item);
    if (!array && proto !== Object.prototype && proto !== null) throw new Error("catalog_value");
    active.add(item);
    if (array) {
      if (item.length > CATALOG_LIMITS.nodes) throw new Error("catalog_budget");
      append("[");
      for (let i = 0; i < item.length; i++) {
        if (i > 0) append(",");
        const property = Object.getOwnPropertyDescriptor(item, String(i));
        if (property === undefined || !("value" in property)) throw new Error("catalog_value");
        visit(property.value, depth + 1);
      }
      append("]");
    } else {
      const keys = Reflect.ownKeys(item);
      if (keys.length > CATALOG_LIMITS.nodes || keys.some(key => typeof key !== "string")) throw new Error("catalog_value");
      append("{");
      for (const [i, key] of (keys as string[]).sort().entries()) {
        const property = Object.getOwnPropertyDescriptor(item, key);
        if (property === undefined || !property.enumerable || !("value" in property) || key.length > maxBytes) throw new Error("catalog_value");
        if (i > 0) append(",");
        append(JSON.stringify(key)); append(":"); visit(property.value, depth + 1);
      }
      append("}");
    }
    active.delete(item);
  };
  try { visit(value, 0); return chunks.join(""); } catch { return undefined; }
}

export const catalogObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export const catalogDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
export const catalogRevision = (value: unknown, zero = false): value is number =>
  Number.isSafeInteger(value) && (value as number) >= (zero ? 0 : 1) && (value as number) < Number.MAX_SAFE_INTEGER;
export const toolName = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.-]{1,128}$/u.test(value);
export const catalogKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every(key => keys.includes(key));
