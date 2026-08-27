import { z } from "zod";
import { WireMessageSchema } from "./schema.js";

/**
 * Generates the public language-neutral contract from the runtime schema.
 * Zod cannot describe an iterative custom JSON validator, so the recursive
 * JSON value shape is represented explicitly in the artifact while runtime
 * validation additionally enforces depth and node limits.
 */
export function generateWireMessageJsonSchema(): string {
  const generated = z.toJSONSchema(WireMessageSchema) as Record<string, unknown>;
  if (Array.isArray(generated.anyOf)) generated.oneOf = generated.anyOf;
  delete generated.anyOf;
  replaceJsonValuePlaceholders(generated);
  const schema = generated;
  if (Array.isArray(schema.oneOf)) {
    for (const branch of schema.oneOf) {
      if (!isRecord(branch)) continue;
      const branchProperties = isRecord(branch.properties) ? branch.properties : undefined;
      const method = isRecord(branchProperties?.method) ? branchProperties.method : undefined;
      if (method?.const === "rpc.request" && branchProperties !== undefined) {
        const methodEnum = Array.isArray(method.enum) ? method.enum : undefined;
        if (methodEnum?.includes("echo") === true) {
          branch.required = Array.isArray(branch.required) ? branch.required.filter((name) => name !== "policy_revision") : branch.required;
        } else {
          branch.required = Array.isArray(branch.required) ? [...new Set([...branch.required, "policy_revision"])] : ["policy_revision"];
          if (methodEnum !== undefined) delete method.enum;
          branchProperties.method = { type: "string", minLength: 1, maxLength: 4096, not: { enum: ["echo", "runner.info"] } };
        }
      }
    }
  }
  schema.$defs = {
    ...(isRecord(schema.$defs) ? schema.$defs : {}),
    jsonValue: {
      anyOf: [
        { type: "null" },
        { type: "boolean" },
        { type: "number" },
        { type: "string" },
        { type: "array", items: { $ref: "#/$defs/jsonValue" } },
        {
          type: "object",
          propertyNames: { type: "string" },
          additionalProperties: { $ref: "#/$defs/jsonValue" },
        },
      ],
    },
  };
  return `${JSON.stringify(schema, null, 2)}\n`;
}

function replaceJsonValuePlaceholders(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) replaceJsonValuePlaceholders(item);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (
      (key === "params" || key === "result" || key === "details") &&
      isRecord(child) &&
      Object.keys(child).length === 0
    ) {
      value[key] = { $ref: "#/$defs/jsonValue" };
    } else {
      replaceJsonValuePlaceholders(child);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
