import { BoundFileCursorSchema, BoundLogCursorSchema } from "@aloneio/runmesh-protocol";
import { z } from "zod";

/** Keep strict action branches, and also expose fields to clients that only
 * render root properties. The root is derived, never a second input model. */
export function publishActionInput<Schema extends z.ZodType>(schema: Schema): Schema {
  const json = z.toJSONSchema(schema, { io: "input", target: "draft-2020-12" });
  const branches = json.oneOf ?? json.anyOf;
  if (!Array.isArray(branches) || branches.length === 0) throw new Error("action_input_requires_branches");
  const variants = new Map<string, unknown[]>();
  let required: string[] | undefined;
  for (const branch of branches) {
    if (typeof branch !== "object" || branch === null || branch.properties === undefined) throw new Error("action_input_requires_object_branches");
    const branchRequired = branch.required ?? [];
    required = required === undefined ? [...branchRequired] : required.filter(key => branchRequired.includes(key));
    for (const [key, value] of Object.entries(branch.properties)) {
      const choices = variants.get(key) ?? [];
      if (!choices.some(choice => JSON.stringify(choice) === JSON.stringify(value))) choices.push(value);
      variants.set(key, choices);
    }
  }
  const properties = Object.fromEntries([...variants].map(([key, choices]) => {
    if (key === "action") return [key, { type: "string", enum: choices.map(choice => (choice as { const: string }).const), description: "Choose one action; only that action's branch fields are accepted." }];
    return [key, choices.length === 1 ? choices[0] : { anyOf: choices }];
  }));
  return schema.meta({ type: "object", properties, required: required ?? [], additionalProperties: false });
}

/** JSON Schema counterparts of the bounded-read runtime checks. Keeping the
 * cursor schema imported avoids inventing a second cursor syntax. */
export function boundInputJson(kind: "file" | "log"): Record<string, unknown> {
  const { $schema: _dialect, ...cursor } = z.toJSONSchema(kind === "file" ? BoundFileCursorSchema : BoundLogCursorSchema, { io: "input" });
  return { allOf: [
    { if: { properties: { cursor }, required: ["cursor"] }, then: {
      not: { anyOf: [{ required: ["offset"] }, { properties: { tail: { const: true } }, required: ["tail"] }, { properties: { consistency: { const: "live" } }, required: ["consistency"] }] },
    } },
    { if: { properties: { consistency: { const: kind === "file" ? "snapshot" : "append" } }, required: ["consistency", "cursor"] }, then: { properties: { cursor } } },
  ] };
}

export const JOB_INPUT_REQUIREMENT = { anyOf: [{ required: ["data"] }, { properties: { close_stdin: { const: true } }, required: ["close_stdin"] }] };
export const EDIT_PREVIEW_REQUIREMENT = { not: { properties: { preview: { const: true } }, required: ["preview", "preview_id"] } };
export const CONTEXT_PRUNE_REQUIREMENT = {
  if: { properties: { apply: { const: true } }, required: ["apply"] },
  then: { required: ["expected_plan_hash"] }, else: { not: { required: ["expected_plan_hash"] } },
};
