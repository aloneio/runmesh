import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/client/validators/cf-worker";
import { catalogJson, catalogObject } from "../../contracts/catalog-json.js";
import { validCatalogSchema } from "../../contracts/catalog-schema.js";
import { REMOTE_LIMITS } from "../../contracts/remote.js";
import type { JsonSchemaType, jsonSchemaValidator } from "@modelcontextprotocol/client";

/** Bound expanded acyclic schema work before passing it to the non-codegen
 * interpreter. This rejects expensive-but-legal schemas instead of timing out
 * synchronous evaluation or enabling eval/new Function in a Worker. */
function work(schema: unknown): number {
  if (!validCatalogSchema(schema, false)) return Infinity;
  const root = catalogObject(schema)!, active = new Set<unknown>(), memo = new Map<unknown, number>();
  const visit = (value: unknown): number => {
    if (typeof value === "boolean") return 1;
    const item = catalogObject(value);
    if (item === undefined || active.has(value)) return Infinity;
    if (memo.has(value)) return memo.get(value)!;
    active.add(value); let cost = 1;
    const add = (child: unknown) => { cost = Math.min(REMOTE_LIMITS.validation_cost + 1, cost + visit(child)); };
    for (const [key, child] of Object.entries(item)) {
      if (["additionalProperties", "unevaluatedProperties", "items", "contains", "not", "if", "then", "else"].includes(key)) add(child);
      else if (["properties", "$defs", "definitions", "dependentSchemas"].includes(key)) {
        for (const next of Object.values(catalogObject(child) ?? {})) add(next);
      } else if (["allOf", "anyOf", "oneOf", "prefixItems"].includes(key) && Array.isArray(child)) {
        for (const next of child) add(next);
      } else if (key === "$ref" && typeof child === "string") {
        const parts = decodeURIComponent(child).slice(2).split("/").map(p => p.replaceAll("~1", "/").replaceAll("~0", "~"));
        let ref: unknown = root;
        for (const part of parts) ref = catalogObject(ref)?.[part];
        add(ref);
      }
    }
    active.delete(value); memo.set(value, cost); return cost;
  };
  return visit(root);
}

function nodes(value: unknown): number {
  if (value === null || typeof value !== "object") return 1;
  return 1 + Object.values(value).reduce<number>((sum, child) => sum + nodes(child), 0);
}

export class BoundedRemoteValidator implements jsonSchemaValidator {
  public getValidator<T>(schema: JsonSchemaType) {
    const encoded = catalogJson(schema, 32_768);
    const copy = encoded === undefined ? undefined : JSON.parse(encoded);
    const cost = copy === undefined ? Infinity : work(copy);
    // Construction is also bounded: never instantiate an unsupported schema.
    const evaluate = cost > REMOTE_LIMITS.validation_cost ? undefined
      : new CfWorkerJsonSchemaValidator({ draft: "2020-12", shortcircuit: true }).getValidator<T>(copy);
    return (value: unknown) => {
      try {
        const body = catalogJson(value, REMOTE_LIMITS.response_bytes);
        if (body === undefined || evaluate === undefined) return { valid: false as const, data: undefined, errorMessage: "remote_schema_budget" };
        const clean: unknown = JSON.parse(body), size = nodes(clean);
        if (cost * size * size > REMOTE_LIMITS.validation_cost) return { valid: false as const, data: undefined, errorMessage: "remote_schema_budget" };
        const result = evaluate(clean);
        return result.valid ? result : { valid: false as const, data: undefined, errorMessage: "remote_schema_invalid" };
      } catch { return { valid: false as const, data: undefined, errorMessage: "remote_schema_invalid" }; }
    };
  }
  public validate(schema: JsonSchemaType, value: unknown): boolean {
    try { return this.getValidator(schema)(value).valid; } catch { return false; }
  }
}
