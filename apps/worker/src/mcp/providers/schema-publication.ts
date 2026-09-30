import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";

/** Publish static tool definitions once per isolate. Keep the original
 * Standard Schema validator: defaults, refinements and transforms still run
 * on every request, and no client identity or authorization is cached. */
export function publishSchema<Input, Output>(schema: StandardSchemaWithJSON<Input, Output>, io: "input" | "output"): StandardSchemaWithJSON<Input, Output> {
  const standard = schema["~standard"];
  const published = standard.jsonSchema[io]({ target: "draft-2020-12" });
  freezeJson(published);
  const convert = (mode: "input" | "output"): typeof standard.jsonSchema.input => options =>
    mode === io && options.target === "draft-2020-12" && options.libraryOptions === undefined
      ? published : standard.jsonSchema[mode](options);
  return { "~standard": { ...standard, jsonSchema: { input: convert("input"), output: convert("output") } } };
}

function freezeJson(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeJson(child);
}
