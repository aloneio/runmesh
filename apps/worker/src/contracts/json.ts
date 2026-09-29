export const JSON_LIMITS = Object.freeze({ depth: 16, nodes: 8_192 });

/** Bounded canonical JSON, never getter/toJSON evaluation or unbounded stringify.
 * Property order is normalized; arrays retain order. No source objects are mutated. */
export function canonicalJson(value: unknown, maxBytes: number, limits: { readonly depth: number; readonly nodes: number } = JSON_LIMITS): string | undefined {
  let bytes = 0, nodes = 0;
  const chunks: string[] = [], active = new Set<object>(), encoder = new TextEncoder();
  const append = (text: string): void => {
    bytes += encoder.encode(text).byteLength;
    if (bytes > maxBytes) throw new Error("json_budget");
    chunks.push(text);
  };
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > limits.nodes || depth > limits.depth) throw new Error("json_budget");
    if (item === null || typeof item === "boolean") { append(String(item)); return; }
    if (typeof item === "number") {
      if (!Number.isFinite(item) || Math.abs(item) > Number.MAX_SAFE_INTEGER) throw new Error("json_number");
      append(JSON.stringify(item)); return;
    }
    if (typeof item === "string") {
      if (item.length > maxBytes) throw new Error("json_budget");
      append(JSON.stringify(item)); return;
    }
    if (typeof item !== "object" || active.has(item)) throw new Error("json_value");
    const array = Array.isArray(item), proto = Object.getPrototypeOf(item);
    if (!array && proto !== Object.prototype && proto !== null) throw new Error("json_value");
    active.add(item);
    if (array) {
      if (item.length > limits.nodes) throw new Error("json_budget");
      append("[");
      for (let i = 0; i < item.length; i++) {
        if (i > 0) append(",");
        const property = Object.getOwnPropertyDescriptor(item, String(i));
        if (property === undefined || !("value" in property)) throw new Error("json_value");
        visit(property.value, depth + 1);
      }
      append("]");
    } else {
      const keys = Reflect.ownKeys(item);
      if (keys.length > limits.nodes || keys.some(key => typeof key !== "string")) throw new Error("json_value");
      append("{");
      for (const [i, key] of (keys as string[]).sort().entries()) {
        const property = Object.getOwnPropertyDescriptor(item, key);
        if (property === undefined || !property.enumerable || !("value" in property) || key.length > maxBytes) throw new Error("json_value");
        if (i > 0) append(",");
        append(JSON.stringify(key)); append(":"); visit(property.value, depth + 1);
      }
      append("}");
    }
    active.delete(item);
  };
  try { visit(value, 0); return chunks.join(""); } catch { return undefined; }
}
