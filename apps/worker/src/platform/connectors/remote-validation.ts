import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/client/validators/cf-worker";
import { catalogJson, catalogObject } from "../../contracts/catalog-json.js";
import { catalogSchemaGraph, safeCatalogPattern, catalogPatternCost } from "../../contracts/catalog-schema.js";
import { CATALOG_LIMITS } from "../../contracts/catalog.js";
import { REMOTE_LIMITS } from "../../contracts/remote.js";
import type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator } from "@modelcontextprotocol/client";

const compatibilitySingles = new Set(["additionalProperties", "unevaluatedProperties", "unevaluatedItems", "additionalItems", "items", "contains", "not", "if", "then", "else", "propertyNames", "contentSchema"]);
const compatibilityMaps = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const compatibilityLists = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const compatibilityDialects = new Set([
  "https://json-schema.org/draft-04/schema", "http://json-schema.org/draft-04/schema",
  "https://spec.openapis.org/oas/3.1/dialect/base",
]);
const validationKeywords = new Set(["$schema", "$id", "id", "$anchor", "$ref", "type", "enum", "const", "multipleOf", "maximum", "exclusiveMaximum",
  "minimum", "exclusiveMinimum", "maxLength", "minLength", "pattern", "format", "maxItems", "minItems", "uniqueItems", "maxContains",
  "minContains", "maxProperties", "minProperties", "required", "dependentRequired", "dependencies", "properties", "patternProperties",
  "additionalProperties", "unevaluatedProperties", "unevaluatedItems", "additionalItems", "items", "contains", "propertyNames",
  "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "$defs", "definitions", "dependentSchemas", "prefixItems"]);

/** Normalize widespread pre-2020/OpenAPI spellings on the private validation
 * copy only. The catalog retains the provider's exact admitted schema so a
 * provider-side contract change still changes its catalog digest. */
function normalizeCompatibilitySchema(root: Record<string, unknown>): void {
  const declared = typeof root.$schema === "string" ? root.$schema.replace(/#$/u, "") : undefined;
  const draft4 = declared?.includes("draft-04") === true;
  const explicitLegacy = draft4 || declared?.includes("draft-07") === true || declared?.includes("draft-06") === true;
  const compatibilityDialect = declared !== undefined && compatibilityDialects.has(declared);
  // Draft-04 and vendor/OpenAPI dialect URIs are common in generated tool
  // schemas but are outside the Workerd validator's native dispatch. Treat
  // them as compatibility input and validate the standard subset after the
  // normalizations below; the provider remains authoritative for extensions.
  if (compatibilityDialect) { if (draft4) root.$schema = "http://json-schema.org/draft-07/schema#"; else delete root.$schema; }
  const walk = (schema: unknown): void => {
    const item = catalogObject(schema);
    if (item === undefined) return;
    if (item.nullable === true) {
      if (typeof item.type === "string" && item.type !== "null") item.type = [item.type, "null"];
      else if (Array.isArray(item.type) && !item.type.includes("null")) item.type = [...item.type, "null"];
      // nullable widens only type; enum and other constraints still apply.
    }
    if (typeof item.pattern === "string" && !safeCatalogPattern(item.pattern)) throw new Error("unsupported_pattern");
    const patternProperties = catalogObject(item.patternProperties);
    if (patternProperties && Object.keys(patternProperties).some(pattern => !safeCatalogPattern(pattern))) throw new Error("unsupported_pattern");
    for (const [exclusive, inclusive] of [["exclusiveMinimum", "minimum"], ["exclusiveMaximum", "maximum"]] as const) {
      if (typeof item[exclusive] !== "boolean") continue;
      if (item[exclusive] === true && typeof item[inclusive] === "number") item[exclusive] = item[inclusive];
      else delete item[exclusive];
    }
    const dependencies = catalogObject(item.dependencies);
    if (dependencies !== undefined && !explicitLegacy) {
      const required = catalogObject(item.dependentRequired) ?? Object.create(null) as Record<string, unknown>;
      const schemas = catalogObject(item.dependentSchemas) ?? Object.create(null) as Record<string, unknown>;
      for (const [name, dependency] of Object.entries(dependencies)) {
        if (Array.isArray(dependency)) required[name] = dependency;
        else schemas[name] = dependency;
      }
      if (Object.keys(required).length) item.dependentRequired = required;
      if (Object.keys(schemas).length) item.dependentSchemas = schemas;
    }
    if (!explicitLegacy && Array.isArray(item.items)) {
      if (item.prefixItems === undefined) item.prefixItems = item.items;
      item.items = item.additionalItems ?? true;
      delete item.additionalItems;
    }
    if (!explicitLegacy) delete item.dependencies;
    delete item.nullable;
    for (const key of Object.keys(item)) if (!validationKeywords.has(key)) delete item[key];
    for (const [key, child] of Object.entries(item)) {
      if (compatibilitySingles.has(key)) {
        if (Array.isArray(child)) child.forEach(walk); else walk(child);
      } else if (compatibilityMaps.has(key)) {
        const map = catalogObject(child); if (map) Object.values(map).forEach(walk);
      } else if (compatibilityLists.has(key) && Array.isArray(child)) child.forEach(walk);
      else if (key === "dependencies") {
        const map = catalogObject(child); if (map) Object.values(map).filter(value => !Array.isArray(value)).forEach(walk);
      }
    }
  };
  walk(root);
}

/** Bound expanded acyclic schema work before passing it to the non-codegen
 * interpreter. This rejects expensive-but-legal schemas instead of timing out
 * synchronous evaluation or enabling eval/new Function in a Worker. */
function prepareSchema(schema: unknown): number {
  // Validation semantics ignore SEP-2243 x-mcp-header annotations. Tool
  // admission has already checked whether such annotations are legal input
  // metadata, so accept either an output-shaped schema or an input-shaped one.
  const graph = catalogSchemaGraph(schema, false) ?? catalogSchemaGraph(schema, true);
  if (graph === undefined) return Infinity;
  // The interpreter omits contains' default minimum when maxContains is set.
  // Only visit admitted schema locations, never const/default/example data.
  for (const path of graph.keys()) {
    const item = catalogObject(path === "" ? schema : path.slice(1).split("/").reduce<unknown>(
      (value, part) => (value as Record<string, unknown>)[part.replaceAll("~1", "/").replaceAll("~0", "~")], schema));
    if (item?.contains !== undefined && item.minContains === undefined) item.minContains = 1;
  }
  const memo = new Map<string, number>();
  const visit = (path: string): number => {
    if (memo.has(path)) return memo.get(path)!;
    let cost = 1;
    for (const child of graph.get(path)!) cost = Math.min(REMOTE_LIMITS.validation_cost + 1, cost + visit(child));
    memo.set(path, cost); return cost;
  };
  return visit("");
}

/** The interpreter uses `in` for JSON properties. Private null-prototype copies
 * keep required/properties/dependencies limited to the JSON object's own keys. */
function parseInstance(encoded: string): unknown {
  return JSON.parse(encoded, (_key, value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.setPrototypeOf(value, null) : value);
}

function nodes(value: unknown): number {
  if (value === null || typeof value !== "object") return 1;
  return 1 + Object.values(value).reduce<number>((sum, child) => sum + nodes(child), 0);
}

type Prepared = { evaluate: JsonSchemaValidator<unknown>; cost: number; quadratic: boolean; patterns: readonly string[] };
const formats = new Set(["date", "time", "date-time", "duration", "uri", "uri-reference", "uri-template", "url", "email", "hostname",
  "ipv4", "ipv6", "regex", "uuid", "json-pointer", "json-pointer-uri-fragment", "relative-json-pointer"]);

export class BoundedRemoteValidator implements jsonSchemaValidator {
  private readonly cache = new Map<string, Prepared | undefined>();
  private prepare(schema: JsonSchemaType): Prepared | undefined {
    const encoded = catalogJson(schema, CATALOG_LIMITS.tool_bytes);
    if (encoded === undefined) return undefined;
    if (this.cache.has(encoded)) return this.cache.get(encoded);
    let prepared: Prepared | undefined;
    try {
      const copy = parseInstance(encoded);
      if (catalogSchemaGraph(copy, false) === undefined && catalogSchemaGraph(copy, true) === undefined) return undefined;
      normalizeCompatibilitySchema(copy as Record<string, unknown>);
      const cost = prepareSchema(copy), graph = catalogSchemaGraph(copy, false);
      if (graph === undefined || cost > REMOTE_LIMITS.validation_cost) return undefined;
      const patterns: string[] = []; let quadratic = false;
      for (const path of graph.keys()) {
        const item = catalogObject(path === "" ? copy : path.slice(1).split("/").reduce<unknown>(
          (value, part) => (value as Record<string, unknown>)[part.replaceAll("~1", "/").replaceAll("~0", "~")], copy));
        if (!item) continue;
        quadratic ||= item.uniqueItems === true;
        if (typeof item.pattern === "string") patterns.push(item.pattern);
        const properties = catalogObject(item.patternProperties);
        if (properties) patterns.push(...Object.keys(properties));
        // Unknown formats are annotations, not callable keys on the interpreter's format object.
        if (typeof item.format === "string" && !formats.has(item.format)) delete item.format;
      }
      const evaluate = new CfWorkerJsonSchemaValidator({ shortcircuit: true }).getValidator(copy as JsonSchemaType);
      prepared = { evaluate, cost, quadratic, patterns };
    } catch { prepared = undefined; }
    if (this.cache.size >= 16) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(encoded, prepared); return prepared;
  }
  public supports(schema: JsonSchemaType): boolean { return this.prepare(schema) !== undefined; }
  public getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    const prepared = this.prepare(schema);
    return (value: unknown) => {
      try {
        const body = catalogJson(value, REMOTE_LIMITS.response_bytes);
        if (body === undefined || prepared === undefined) return { valid: false as const, data: undefined, errorMessage: "remote_schema_budget" };
        const clean = parseInstance(body), size = nodes(clean);
        let work = prepared.cost * size * (prepared.quadratic ? size : 1);
        const strings: number[] = [];
        const lengths = (v: unknown): void => {
          if (typeof v === "string") strings.push(v.length);
          else if (Array.isArray(v)) v.forEach(lengths);
          else if (v !== null && typeof v === "object") for (const [key, child] of Object.entries(v)) { strings.push(key.length); lengths(child); }
        };
        if (prepared.patterns.length) lengths(clean);
        for (const pattern of prepared.patterns) for (const length of strings) {
          work += catalogPatternCost(pattern, length);
          if (work > REMOTE_LIMITS.validation_cost) return { valid: false as const, data: undefined, errorMessage: "remote_schema_budget" };
        }
        if (work > REMOTE_LIMITS.validation_cost) return { valid: false as const, data: undefined, errorMessage: "remote_schema_budget" };
        const result = prepared.evaluate(clean);
        return result.valid ? { valid: true as const, data: result.data as T, errorMessage: undefined } : { valid: false as const, data: undefined, errorMessage: "remote_schema_invalid" };
      } catch { return { valid: false as const, data: undefined, errorMessage: "remote_schema_invalid" }; }
    };
  }
  public validate(schema: JsonSchemaType, value: unknown): boolean {
    try { return this.getValidator(schema)(value).valid; } catch { return false; }
  }
}
