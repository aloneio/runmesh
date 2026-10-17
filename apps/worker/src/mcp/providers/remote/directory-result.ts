import { z } from "zod";
import { publishSchema } from "../schema-publication.js";

/** Shared backwards-compatible envelope for bounded MCP directory responses.
 * Keep the legacy text block byte-for-byte JSON compatible with clients that
 * do not consume structuredContent. Input is already validated at the provider. */
export function directoryResult<T extends object>(value: T): {
  content: [{ type: "text"; text: string }];
  structuredContent: T;
} {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

/** Output schema is intentionally bounded to the stable directory envelope.
 * Remote tool definitions remain opaque reviewed JSON and are validated by
 * the existing catalog reader before entering this envelope. */
export const remoteProfileOutputSchema = publishSchema(z.object({
  state: z.literal("listed"),
  profiles: z.array(z.object({ profile_id: z.string(), name: z.string() }).strict()),
}).strict(), "output");

export const remoteToolsOutputSchema = publishSchema(z.object({
  tools: z.array(z.object({ tool_id: z.string(), public_name: z.string(), version: z.string(),
    definition: z.object({ name: z.string(), inputSchema: z.record(z.string(), z.unknown()) }).passthrough() }).strict()),
  next_cursor: z.string().nullable(),
}).strict(), "output");

export const remoteSearchOutputSchema = publishSchema(z.object({
  state: z.literal("listed"),
  tools: z.array(z.object({ profile_id: z.string(), profile_name: z.string(), profile_revision: z.number(),
    catalog_revision: z.number(), tool_id: z.string(), version: z.string(), name: z.string(), description: z.string() }).strict()),
}).strict(), "output");
