import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/client/validators/cf-worker";
import { catalogJson } from "../../contracts/catalog-json.js";
import { catalogSchemaGraph } from "../../contracts/catalog-schema.js";
import { REMOTE_LIMITS } from "../../contracts/remote.js";
import type { JsonSchemaType, jsonSchemaValidator } from "@modelcontextprotocol/client";

/** Bound expanded acyclic schema work before passing it to the non-codegen
 * interpreter. This rejects expensive-but-legal schemas instead of timing out
 * synchronous evaluation or enabling eval/new Function in a Worker. */
function work(schema: unknown): number {
  const graph = catalogSchemaGraph(schema, false);
  if (graph === undefined) return Infinity;
  const memo = new Map<string, number>();
  const visit = (path: string): number => {
    if (memo.has(path)) return memo.get(path)!;
    let cost = 1;
    for (const child of graph.get(path)!) cost = Math.min(REMOTE_LIMITS.validation_cost + 1, cost + visit(child));
    memo.set(path, cost); return cost;
  };
  return visit("");
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
