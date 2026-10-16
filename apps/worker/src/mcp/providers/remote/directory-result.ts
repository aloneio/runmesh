/** Shared backwards-compatible envelope for bounded MCP directory responses.
 * Keep the legacy text block byte-for-byte JSON compatible with clients that
 * do not consume structuredContent. Input is already validated at the provider. */
export function directoryResult<T extends object>(value: T): {
  content: [{ type: "text"; text: string }];
  structuredContent: T;
} {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}
