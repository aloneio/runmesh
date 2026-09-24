import { catalogObject } from "./catalog-json.js";

const types = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
const text = new Set(["title", "description", "$comment"]);
const flag = new Set(["readOnly", "writeOnly", "deprecated", "uniqueItems"]);
const count = new Set(["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties", "minContains", "maxContains"]);
const numeric = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]);
const single = new Set(["additionalProperties", "unevaluatedProperties", "items", "contains", "not", "if", "then", "else"]);
const maps = new Set(["properties", "$defs", "definitions", "dependentSchemas"]);
const lists = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const pointer = (part: string): string => part.replaceAll("~", "~0").replaceAll("/", "~1");
const names = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 128
  && value.every(name => typeof name === "string" && name.length <= 256) && new Set(value).size === value.length;

/** Reviewed 2020-12 metadata subset, not an argument validator. The caller bounds
 * the complete JSON first. No regex compilation, remote lookup or ref expansion.
 * Unknown keywords/dialects, patterns, formats, dynamic headers and recursive refs
 * are unsupported rather than silently discarded. W05 still needs an evaluator. */
export function validCatalogSchema(value: unknown, input: boolean): boolean {
  const root = catalogObject(value);
  if (root === undefined || (input && root.type !== "object")) return false;
  const graph = new Map<string, string[]>(), refs: Array<[string, string]> = [];
  let nodes = 0;
  const walk = (schema: unknown, path: string, depth: number): boolean => {
    if (++nodes > 2048 || depth > 12) return false;
    graph.set(path, []);
    if (typeof schema === "boolean") return true;
    const item = catalogObject(schema);
    if (item === undefined) return false;
    const child = (next: unknown, suffix: string): boolean => {
      const nextPath = path + suffix;
      graph.get(path)!.push(nextPath);
      return walk(next, nextPath, depth + 1);
    };
    for (const [key, field] of Object.entries(item)) {
      if (text.has(key)) { if (typeof field !== "string") return false; }
      else if (flag.has(key)) { if (typeof field !== "boolean") return false; }
      else if (count.has(key)) { if (!Number.isSafeInteger(field) || (field as number) < 0) return false; }
      else if (numeric.has(key)) { if (typeof field !== "number" || !Number.isFinite(field) || (key === "multipleOf" && field <= 0)) return false; }
      else if (key === "$schema") { if (path !== "" || field !== "https://json-schema.org/draft/2020-12/schema") return false; }
      else if (key === "type") {
        if (typeof field === "string" ? !types.has(field) : !Array.isArray(field) || field.length === 0
          || new Set(field).size !== field.length || field.some(kind => typeof kind !== "string" || !types.has(kind))) return false;
      } else if (key === "required") { if (!names(field)) return false; }
      else if (key === "enum") {
        if (!Array.isArray(field) || field.length === 0 || field.length > 128 || new Set(field.map(item => JSON.stringify(item))).size !== field.length) return false;
      } else if (key === "const" || key === "default") { /* Bounded JSON data, never interpreted as a schema. */ }
      else if (key === "examples") { if (!Array.isArray(field) || field.length > 128) return false; }
      else if (key === "dependentRequired") {
        const object = catalogObject(field);
        if (object === undefined || Object.values(object).some(value => !names(value))) return false;
      } else if (single.has(key)) { if (!child(field, "/" + key)) return false; }
      else if (maps.has(key)) {
        const object = catalogObject(field);
        if (object === undefined) return false;
        for (const [name, next] of Object.entries(object)) {
          if (name.length > 256 || !child(next, "/" + key + "/" + pointer(name))) return false;
        }
      } else if (lists.has(key)) {
        if (!Array.isArray(field) || field.length === 0 || field.length > 32) return false;
        for (const [i, next] of field.entries()) if (!child(next, "/" + key + "/" + i)) return false;
      } else if (key === "$ref") {
        if (typeof field !== "string" || field.length > 1024) return false;
        let target: string;
        try { target = decodeURIComponent(field); } catch { return false; }
        if (!/^#\/(?:\$defs|definitions)\//u.test(target) || /~(?![01])/u.test(target)) return false;
        refs.push([path, target.slice(1)]);
      } else return false;
    }
    return true;
  };
  if (!walk(root, "", 0)) return false;
  for (const [from, to] of refs) {
    if (!graph.has(to)) return false;
    graph.get(from)!.push(to);
  }
  const visiting = new Set<string>(), done = new Set<string>();
  const acyclic = (path: string): boolean => {
    if (visiting.has(path)) return false;
    if (done.has(path)) return true;
    visiting.add(path);
    for (const child of graph.get(path)!) if (!acyclic(child)) return false;
    visiting.delete(path); done.add(path); return true;
  };
  return acyclic("");
}
