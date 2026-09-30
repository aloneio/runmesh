import { expect, it, vi } from "vitest";
import { z } from "zod";
import { publishSchema } from "../src/mcp/providers/schema-publication.js";
import { TOOL_SPECS } from "../src/mcp/catalog.js";

it("reuses static JSON publication without re-running its converter per request", () => {
  const schema = z.object({ name: z.string() }).strict();
  const original = schema["~standard"], input = vi.fn(original.jsonSchema.input);
  const published = publishSchema({ "~standard": { ...original, jsonSchema: { ...original.jsonSchema, input } } }, "input");
  const first = published["~standard"].jsonSchema.input({ target: "draft-2020-12" });
  for (let i = 0; i < 100; i++) expect(published["~standard"].jsonSchema.input({ target: "draft-2020-12" })).toBe(first);
  expect(input).toHaveBeenCalledTimes(1);
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(first.properties)).toBe(true);
});

it("retains fresh validation, defaults, strict fields and asynchronous refinements", async () => {
  let allowed = true;
  const schema = z.object({ name: z.string().default("default").refine(async () => allowed) }).strict();
  const published = publishSchema(schema, "input")["~standard"];
  expect(await published.validate({})).toEqual({ value: { name: "default" } });
  expect((await published.validate({ unexpected: true })).issues).toBeDefined();
  allowed = false;
  expect((await published.validate({})).issues).toBeDefined();
});

it("keeps non-default dialects and vendor conversion options separate", () => {
  const schema = z.object({ name: z.string().default("default") }).strict();
  const original = schema["~standard"], input = vi.fn(original.jsonSchema.input);
  const published = publishSchema({ "~standard": { ...original, jsonSchema: { ...original.jsonSchema, input } } }, "input")["~standard"].jsonSchema;
  expect(published.input({ target: "draft-07" })).toEqual(original.jsonSchema.input({ target: "draft-07" }));
  expect(published.input({ target: "draft-2020-12", libraryOptions: {} })).toEqual(original.jsonSchema.input({ target: "draft-2020-12", libraryOptions: {} }));
  expect(input).toHaveBeenCalledTimes(3);
  expect(published.output({ target: "draft-2020-12" })).toEqual(original.jsonSchema.output({ target: "draft-2020-12" }));
});

it.each(Object.entries(TOOL_SPECS))("preserves the published input and output contract for %s", (_name, spec) => {
  for (const io of ["input", "output"] as const) {
    const schema = io === "input" ? spec.inputSchema : spec.outputSchema;
    expect(publishSchema<unknown, unknown>(schema, io)["~standard"].jsonSchema[io]({ target: "draft-2020-12" }))
      .toEqual(schema["~standard"].jsonSchema[io]({ target: "draft-2020-12" }));
  }
});
