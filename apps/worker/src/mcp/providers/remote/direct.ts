import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { CentralDirectory, RemoteToolDefinition } from "../../../contracts/catalog.js";
import { catalogJson, catalogObject } from "../../../contracts/catalog-json.js";
import { catalogPublicName, parseRemoteTool } from "../../../contracts/catalog-values.js";
import { invokeRemote, type RemoteToolPort } from "../remote.js";

/** Publish the reviewed schema without translating it into a lossy Zod shape.
 * The application validates the complete frozen schema before upstream I/O. */
const schema = (value: Record<string, unknown>) => ({ '~standard': { version: 1 as const, vendor: 'runmesh-reviewed-catalog',
  validate: (input: unknown) => catalogObject(input) === undefined ? { issues: [{ message: 'Expected object' }] } : { value: input as Record<string, unknown> },
  jsonSchema: { input: () => value, output: () => value },
} });
export function registerDirectRemoteTools(server: McpServer, port: RemoteToolPort, directory: CentralDirectory | undefined): void {
  let state = directory === undefined ? 'not_requested' : ['listed', 'denied', 'unavailable', 'capacity'].includes(directory?.state) ? directory.state : 'unavailable';
  const ready: { name: string; config: { description?: string; inputSchema: ReturnType<typeof schema>; outputSchema?: ReturnType<typeof schema>;
    annotations?: NonNullable<RemoteToolDefinition['annotations']>; _meta: Record<string, unknown> }; command: { profile_id: string; tool_id: string; version: string } }[] = [];
  if (directory?.state === 'listed') {
    const names = new Set<string>();
    if (!/^[a-f0-9]{64}$/u.test(directory.view_version) || !Array.isArray(directory.tools) || directory.tools.length > 32 || catalogJson(directory, 524_288) === undefined) state = 'unavailable';
    else for (const entry of directory.tools) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { state = 'unavailable'; break; }
      const definition = parseRemoteTool(entry.definition);
      if (!definition || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(entry.profile_id) || !/^mcp[.][a-f0-9]{64}$/u.test(entry.tool_id)
        || !/^[a-f0-9]{64}$/u.test(entry.version) || entry.public_name !== catalogPublicName(entry.profile_id, definition.name, entry.tool_id.slice(4)) || names.has(entry.public_name)) { state = 'unavailable'; break; }
      names.add(entry.public_name);
      ready.push({ name: entry.public_name, command: { profile_id: entry.profile_id, tool_id: entry.tool_id, version: entry.version }, config: {
        ...(definition.description === undefined ? {} : { description: definition.description }), inputSchema: schema(definition.inputSchema),
        ...(definition.outputSchema === undefined ? {} : { outputSchema: schema(definition.outputSchema) }),
        ...(definition.annotations === undefined ? {} : { annotations: definition.annotations }),
        _meta: { 'runmesh/central_contract': 1, 'runmesh/view_version': directory.view_version },
      } });
    }
  }
  if (state === 'listed') {
    const published: ReturnType<McpServer['registerTool']>[] = [];
    try { for (const entry of ready) published.push(server.registerTool(entry.name, entry.config, args => invokeRemote(port, { ...entry.command, arguments: args }))); }
    catch { for (const tool of published) tool.remove(); state = 'unavailable'; }
  }
  server.registerTool('remote_status', { description: 'Report the current direct central directory status. Capacity or unavailable means use remote_profiles and remote_tools to discover shared services; native tools are independent.',
    inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true } },
    async () => ({ content: [{ type: 'text' as const, text: JSON.stringify({ state, direct_tools: state === 'listed' ? ready.length : 0 }) }] }));
}
