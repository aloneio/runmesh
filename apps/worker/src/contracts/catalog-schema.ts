import { catalogObject } from "./catalog-json.js";

const types = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
const text = new Set(["title", "description", "$comment", "contentEncoding", "contentMediaType"]);
const flag = new Set(["readOnly", "writeOnly", "deprecated", "uniqueItems", "nullable", "$recursiveAnchor"]);
const mcpHeaderToken = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const mcpHeaderTypes = new Set(["string", "integer", "boolean"]);
const schemaDialects = new Set([
  "https://json-schema.org/draft/2020-12/schema", "http://json-schema.org/draft/2020-12/schema",
  "https://json-schema.org/draft/2019-09/schema", "http://json-schema.org/draft/2019-09/schema",
  "https://json-schema.org/draft-07/schema", "http://json-schema.org/draft-07/schema",
  "https://json-schema.org/draft-06/schema", "http://json-schema.org/draft-06/schema",
  "https://json-schema.org/draft-04/schema", "http://json-schema.org/draft-04/schema",
  "https://spec.openapis.org/oas/3.1/dialect/base",
]);
const count = new Set(["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties", "minContains", "maxContains"]);
const numeric = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]);
const single = new Set(["additionalProperties", "unevaluatedProperties", "unevaluatedItems", "additionalItems", "contains", "not", "if", "then", "else", "propertyNames", "contentSchema"]);
const maps = new Set(["properties", "$defs", "definitions", "dependentSchemas"]);
const lists = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const opaqueOpenApi = new Set(["example", "discriminator", "xml", "externalDocs"]);
const pointer = (part: string): string => part.replaceAll("~", "~0").replaceAll("/", "~1");
const names = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 256
  && value.every(name => typeof name === "string" && name.length <= 256) && new Set(value).size === value.length;
const anchorName = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(value);

/** Catalog admission checks syntax only. Executable regexes receive an
 * independent static and input-size budget before reaching the interpreter. */
function validPattern(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  try { new RegExp(value, "u"); return true; } catch { return false; }
}

/** A conservative upper bound, not a heuristic claim of ReDoS safety. No
 * backreferences, lookarounds or quantified groups reach the native engine.
 * Repetition choices and the unanchored search multiply the evaluation budget. */
export function catalogPatternCost(value: unknown, length: number): number {
  if (!validPattern(value) || /\\(?:[1-9]|k<)/u.test(value) || /\(\?(?!:)/u.test(value)
    || /\)(?:[*+?]|\{\d+(?:,\d*)?\})/u.test(value)) return Infinity;
  let choices = 1, powers = 0, inClass = false, groupDepth = 0, topLevelAlternative = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "\\") { i++; continue; }
    if (c === "[") { inClass = true; continue; }
    if (c === "]" && inClass) { inClass = false; continue; }
    if (inClass) continue;
    if (c === "(") groupDepth++;
    else if (c === ")") groupDepth--;
    else if (c === "*" || c === "+") powers++;
    else if (c === "?" && value[i - 1] !== "(" && !["*", "+", "?", "}"].includes(value[i - 1] ?? "")) choices *= 2;
    else if (c === "|") { choices *= 2; topLevelAlternative ||= groupDepth === 0; }
    else if (c === "{") {
      const end = value.indexOf("}", i), quantifier = value.slice(i + 1, end);
      if (end < 0 || !/^\d+(?:,\d*)?$/u.test(quantifier)) return Infinity;
      const parts = quantifier.split(","), low = Number(parts[0]), high = parts.length === 1 ? low : parts[1] ? Number(parts[1]) : undefined;
      if (low > 256 || high !== undefined && high > 256) return Infinity;
      if (high === undefined) powers++; else choices *= high - low + 1;
      i = end;
    }
    if (powers > 4 || choices > 4096) return Infinity;
  }
  // A leading anchor applies only to the first top-level alternative. Other
  // alternatives may search at every input offset and need that extra factor.
  if (!value.startsWith("^") || topLevelAlternative) powers++;
  if (powers > 4) return Infinity;
  return choices * (value.length + 1) * Math.pow(length + 1, Math.max(1, powers));
}

export function safeCatalogPattern(value: unknown): value is string {
  return Number.isFinite(catalogPatternCost(value, 0));
}

function schemaId(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 2048) return false;
  try { new URL(value, "https://runmesh.invalid/schema"); return true; } catch { return false; }
}

function headerType(value: unknown): string | undefined {
  if (typeof value === "string") return mcpHeaderTypes.has(value) ? value : undefined;
  if (!Array.isArray(value) || value.length !== 2 || !value.includes("null")) return undefined;
  const primitive = value.find(type => type !== "null");
  return typeof primitive === "string" && mcpHeaderTypes.has(primitive) ? primitive : undefined;
}

/** Reviewed JSON Schema compatibility envelope, not an argument validator.
 * The complete JSON is bounded before this walk. Standard validation keywords
 * are traversed; annotation and vendor-extension data is admitted but never
 * interpreted. External/dynamic refs and recursive graphs remain unsupported.
 * Native dialects match the Worker validator (2020-12, 2019-09, draft-07/06);
 * draft-04 and the OpenAPI 3.1 base dialect are compatibility-normalized before
 * local validation. SEP-2243 x-mcp-header remains limited to primitive inputs. */
export function catalogSchemaGraph(value: unknown, input: boolean): ReadonlyMap<string, readonly string[]> | undefined {
  const root = catalogObject(value);
  if (root === undefined || (input && root.type !== "object")) return undefined;
  const graph = new Map<string, string[]>(), refs: Array<[string, string]> = [], anchors = new Map<string, string>(), mcpHeaders = new Set<string>();
  let nodes = 0;
  const walk = (schema: unknown, path: string, depth: number, headerReachable: boolean): boolean => {
    if (++nodes > 4096 || depth > 16) return false;
    graph.set(path, []);
    if (typeof schema === "boolean") return true;
    const item = catalogObject(schema);
    if (item === undefined) return false;
    const child = (next: unknown, suffix: string, reachable = false): boolean => {
      const nextPath = path + suffix;
      graph.get(path)!.push(nextPath);
      return walk(next, nextPath, depth + 1, reachable);
    };
    for (const [key, field] of Object.entries(item)) {
      if (text.has(key)) { if (typeof field !== "string" || field.length > 8192) return false; }
      else if (key === "x-mcp-header") {
        const primitive = headerType(item.type);
        if (!input || !headerReachable || path === "" || typeof field !== "string" || field.length > 128
          || !mcpHeaderToken.test(field) || primitive === undefined) return false;
        const lower = field.toLowerCase(); if (mcpHeaders.has(lower)) return false; mcpHeaders.add(lower);
      }
      else if (/^x[-_]/iu.test(key)) { /* Bounded vendor annotation; never interpreted. */ }
      else if (flag.has(key)) { if (typeof field !== "boolean") return false; }
      else if (count.has(key)) { if (!Number.isSafeInteger(field) || (field as number) < 0) return false; }
      else if (numeric.has(key)) {
        if (typeof field === "boolean" && ["exclusiveMinimum", "exclusiveMaximum"].includes(key)) {
          const base = key === "exclusiveMinimum" ? item.minimum : item.maximum;
          if (field === true && (typeof base !== "number" || !Number.isFinite(base))) return false;
        } else if (typeof field !== "number" || !Number.isFinite(field) || (key === "multipleOf" && field <= 0)) return false;
      }
      else if (key === "$schema") {
        if (path !== "" || typeof field !== "string" || !schemaDialects.has(field.replace(/#$/u, ""))) return false;
      }
      else if (key === "$id" || key === "id") { if (!schemaId(field) || path !== "") return false; }
      else if (key === "$anchor" || key === "$dynamicAnchor") {
        if (!anchorName(field) || anchors.has(field)) return false; anchors.set(field, path);
      }
      else if (key === "$vocabulary") {
        const object = catalogObject(field);
        if (object === undefined || Object.keys(object).length > 32
          || Object.entries(object).some(([name, required]) => name.length > 2048 || typeof required !== "boolean" || !schemaId(name)
            || required && !/^https:\/\/json-schema\.org\/draft\/(?:2019-09|2020-12)\/vocab\/(?:core|applicator|validation|meta-data|content|format|format-annotation|unevaluated)$/u.test(name))) return false;
      }
      else if (key === "format") { if (typeof field !== "string" || field.length === 0 || field.length > 128) return false; }
      else if (key === "pattern") { if (!validPattern(field)) return false; }
      else if (key === "type") {
        if (typeof field === "string" ? !types.has(field) : !Array.isArray(field) || field.length === 0
          || new Set(field).size !== field.length || field.some(kind => typeof kind !== "string" || !types.has(kind))) return false;
      }
      else if (key === "required") { if (!names(field)) return false; }
      else if (key === "enum") { if (!Array.isArray(field) || field.length === 0 || field.length > 256) return false; }
      else if (key === "const" || key === "default" || opaqueOpenApi.has(key)) { /* Bounded JSON data/annotation. */ }
      else if (key === "examples") { if (!Array.isArray(field) || field.length > 256) return false; }
      else if (key === "dependentRequired") {
        const object = catalogObject(field);
        if (object === undefined || Object.values(object).some(value => !names(value))) return false;
      }
      else if (key === "dependencies") {
        const object = catalogObject(field);
        if (object === undefined) return false;
        for (const [name, dependency] of Object.entries(object)) {
          if (name.length > 256) return false;
          if (Array.isArray(dependency)) { if (!names(dependency)) return false; }
          else if (!child(dependency, "/dependencies/" + pointer(name), false)) return false;
        }
      }
      else if (key === "items") {
        if (Array.isArray(field)) {
          if (field.length > 32) return false;
          for (const [i, next] of field.entries()) if (!child(next, "/items/" + i, false)) return false;
        } else if (!child(field, "/items", false)) return false;
      }
      else if (single.has(key)) { if (!child(field, "/" + key, false)) return false; }
      else if (key === "patternProperties") {
        const object = catalogObject(field);
        if (object === undefined) return false;
        for (const [pattern, next] of Object.entries(object)) {
          if (!validPattern(pattern) || !child(next, "/patternProperties/" + pointer(pattern), false)) return false;
        }
      }
      else if (maps.has(key)) {
        const object = catalogObject(field);
        if (object === undefined) return false;
        for (const [name, next] of Object.entries(object)) {
          const reachable = key === "properties" ? headerReachable : false;
          if (name.length > 256 || !child(next, "/" + key + "/" + pointer(name), reachable)) return false;
        }
      }
      else if (lists.has(key)) {
        if (!Array.isArray(field) || field.length === 0 || field.length > 32) return false;
        for (const [i, next] of field.entries()) if (!child(next, "/" + key + "/" + i, false)) return false;
      }
      else if (key === "$ref") {
        if (typeof field !== "string" || field.length > 1024 || !field.startsWith("#")) return false;
        refs.push([path, field]);
      }
      else if (key === "$dynamicRef" || key === "$recursiveRef") return false;
      else if (key.startsWith("$")) return false;
      else { /* Unknown JSON Schema keywords are extension annotations by default. */ }
    }
    return true;
  };
  if (!walk(root, "", 0, true)) return undefined;
  for (const [from, ref] of refs) {
    let to: string | undefined;
    if (ref === "#") to = "";
    else if (ref.startsWith("#/")) {
      try { to = decodeURIComponent(ref).slice(1); } catch { return undefined; }
      if (/~(?![01])/u.test(to)) return undefined;
    } else to = anchors.get(ref.slice(1));
    if (to === undefined || !graph.has(to)) return undefined;
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
  return acyclic("") ? graph : undefined;
}

export function validCatalogSchema(value: unknown, input: boolean): boolean {
  return catalogSchemaGraph(value, input) !== undefined;
}
