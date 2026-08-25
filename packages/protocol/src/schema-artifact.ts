import { z } from "zod";
import { WireMessageSchema } from "./schema.js";

/**
 * Generates the public language-neutral contract from the runtime schema.
 * Zod cannot describe an iterative custom JSON validator, so the recursive
 * JSON value shape is represented explicitly in the artifact while runtime
 * validation additionally enforces depth and node limits.
 */
export function generateWireMessageJsonSchema(): string {
  const schema = z.toJSONSchema(WireMessageSchema) as Record<string, unknown>;
  replaceJsonValuePlaceholders(schema);
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
