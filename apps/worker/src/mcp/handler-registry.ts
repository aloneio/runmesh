import type { z } from "zod";
import { TOOL_SPECS, type ToolName } from "./catalog.js";

export type ToolHandlers = {
  readonly [Name in ToolName]: (input: z.output<(typeof TOOL_SPECS)[Name]["inputSchema"]>, scopes: readonly string[]) => Promise<unknown>;
};

/** Validate once when constructing a request-local server, before registering
 * any callback. This checks coverage, never grants permission or caches auth. */
export function defineToolHandlers(handlers: ToolHandlers): Readonly<ToolHandlers> {
  const expected = Object.keys(TOOL_SPECS);
  const supplied = Reflect.ownKeys(handlers);
  if (supplied.length !== expected.length || supplied.some(name => typeof name !== "string" || !Object.hasOwn(TOOL_SPECS, name))) {
    throw new Error("mcp_handler_contract_mismatch");
  }
  for (const name of expected) {
    const property = Object.getOwnPropertyDescriptor(handlers, name);
    if (property === undefined || !("value" in property) || typeof property.value !== "function") throw new Error("mcp_handler_contract_mismatch");
  }
  return Object.freeze(handlers);
}

export const REGISTERED_TOOL_NAMES = Object.freeze(Object.keys(TOOL_SPECS) as ToolName[]);
