import { Client, StreamableHTTPClientTransport, type FetchLike } from "@modelcontextprotocol/client";
import { CATALOG_LIMITS, type RemoteToolDefinition } from "../../contracts/catalog.js";
import type { ConnectionProfile, CredentialInput } from "../../contracts/connectors.js";
import type { CredentialLease } from "../../contracts/oauth.js";
import { parseCredential, parseProfile } from "../../contracts/connector-values.js";
import { catalogJson, catalogObject } from "../../contracts/catalog-json.js";
import { parseRemoteTool } from "../../contracts/catalog-values.js";
import { REMOTE_LIMITS, RemoteFault, type RemoteConnector, type RemoteEgressRule } from "../../contracts/remote.js";
import { parseRemoteResult, publicMcpEndpoint } from "../../contracts/remote-values.js";
import { guardedRemoteResponse, boundedWireJson } from "./remote-response.js";
import { BoundedRemoteValidator } from "./remote-validation.js";
import { createRemoteSessionState } from "./remote-session.js";

export interface HttpRemotePorts {
  readonly rules: (profile: ConnectionProfile) => readonly RemoteEgressRule[] | undefined;
  readonly credential: (profile: ConnectionProfile, signal: AbortSignal, authorize: () => Promise<void>) => Promise<CredentialInput | CredentialLease | null>;
  readonly fetch?: FetchLike;
  readonly selfOrigin?: string;
}

/** One client/credential per operation. No pooled sessions, automatic OAuth,
 * reconnect, resumption, implicit capability upgrade or tool replay. */
export function createHttpRemoteConnector(ports: HttpRemotePorts): RemoteConnector {
  const validator = new BoundedRemoteValidator();
  return {
    validate: (schema, value) => validator.validate(schema, value),
    async open(rawProfile, parent, dispatched, authorize) {
      const profile = parseProfile(rawProfile);
      const rules = profile === undefined ? undefined : ports.rules(profile);
      const rule = profile === undefined ? undefined : rules?.find(rule => rule.endpoint === profile.endpoint);
      if (profile === undefined || rule === undefined || !profile.enabled || publicMcpEndpoint(profile.endpoint) === undefined
        || (ports.selfOrigin !== undefined && new URL(profile.endpoint).origin === ports.selfOrigin)) throw new RemoteFault("egress_denied");
      if (parent.aborted) throw new RemoteFault("operation_timed_out");
      const egressCurrent = (): boolean => {
        const live = ports.rules(profile)?.find(value => value.endpoint === profile.endpoint);
        return live?.protocol === rule.protocol && live.session === rule.session && live.negotiate === rule.negotiate;
      };
      const admitCredential = async () => {
        await authorize();
        if (parent.aborted) throw new RemoteFault("operation_timed_out");
        if (!egressCurrent()) throw new RemoteFault("egress_denied");
      };
      await admitCredential();
      const supplied = await ports.credential(profile, parent, admitCredential);
      const leased = supplied !== null && "credential" in supplied;
      const credential = supplied === null && profile.authentication === "none" ? null : parseCredential(leased ? supplied.credential : supplied);
      const credentialCurrent = (): boolean => !leased || supplied.current();
      if (parent.aborted) throw new RemoteFault("operation_timed_out");
      if (credential === undefined) throw new RemoteFault("dependency_unavailable");
      let protocol: string = rule.protocol;
      const controller = new AbortController(), signal = controller.signal;
      const abort = () => controller.abort(); parent.addEventListener("abort", abort, { once: true });
      const sessionState = createRemoteSessionState(rule, { authorize, current: credentialCurrent,
        token: credential?.token, protocol: () => protocol, egressCurrent, signal, send: (url, init) => (ports.fetch ?? fetch)(url, init) });
      let requests = 0, totalBytes = 0, totalTools = 0, callSent = false, lastFault: RemoteFault | undefined;
      let beforeCall: (() => Promise<void>) | undefined;
      const ids = new Set<string | number>(), cursors = new Set<string>();
      const account = (bytes: number) => { if ((totalBytes += bytes) > REMOTE_LIMITS.aggregate_bytes) throw new RemoteFault("upstream_protocol_error"); };
      const guardedFetch: FetchLike = async (input, init) => {
        try {
          if (signal.aborted) throw new RemoteFault("operation_timed_out");
          // The SDK may attempt the legacy optional GET stream. Deny it locally.
          if (init?.method === "GET") return new Response(null, { status: 405 });
          if (String(input) !== profile.endpoint || init?.method !== "POST" || typeof init.body !== "string"
            || new TextEncoder().encode(init.body).byteLength > REMOTE_LIMITS.request_bytes || ++requests > REMOTE_LIMITS.requests)
            throw new RemoteFault("egress_denied");
          const message = boundedWireJson(init.body), method = message.method;
          if (message.jsonrpc !== "2.0" || typeof method !== "string") throw new RemoteFault("upstream_protocol_error");
          if (method === "notifications/cancelled") return new Response(null, { status: 202 });
          if (!["initialize", "notifications/initialized", "server/discover", "tools/list", "tools/call"].includes(method)) throw new RemoteFault("unsupported_interaction");
          if (!rule.negotiate && ((rule.protocol === "2026-07-28" && (method === "initialize" || method === "notifications/initialized"))
            || (rule.protocol === "2025-11-25" && method === "server/discover"))) throw new RemoteFault("upstream_protocol_error");
          if (method !== "notifications/initialized") {
            if ((typeof message.id !== "number" && typeof message.id !== "string") || ids.has(message.id)) throw new RemoteFault("upstream_protocol_error");
            ids.add(message.id);
          }
          if (rule.negotiate) {
            const selected = new Headers(init.headers).get("mcp-protocol-version");
            if (selected && !["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"].includes(selected)) throw new RemoteFault("upstream_protocol_error");
            protocol = selected ?? (method === "server/discover" ? "2026-07-28" : protocol);
          }
          const params = catalogObject(message.params), headers = new Headers({ "content-type": "application/json",
            accept: "application/json, text/event-stream", "mcp-protocol-version": protocol,
            "mcp-method": method, "x-runmesh-mcp-hop": "1" });
          if (credential !== null) headers.set("authorization", `Bearer ${credential.token}`);
          sessionState.headers(headers);
          if (method === "tools/list") {
            const cursor = params?.cursor ?? "";
            if (typeof cursor !== "string" || cursor.length > 2048 || cursors.has(cursor) || cursors.size >= REMOTE_LIMITS.pages)
              throw new RemoteFault("upstream_protocol_error");
            cursors.add(cursor);
          }
          if (method === "tools/call") {
            if (callSent || beforeCall === undefined || typeof params?.name !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/u.test(params.name))
              throw new RemoteFault("upstream_protocol_error");
            headers.set("mcp-name", params.name);
            // Final authorization after DNS-independent connect/list/schema waits.
            await beforeCall();
            if (signal.aborted) throw new RemoteFault("operation_timed_out");
            if (!credentialCurrent()) throw new RemoteFault("authorization_required");
            if (!egressCurrent()) throw new RemoteFault("egress_denied");
            callSent = true; dispatched();
          } else {
            await authorize();
            if (signal.aborted) throw new RemoteFault("operation_timed_out");
          }
          if (!credentialCurrent()) throw new RemoteFault("authorization_required");
          if (!egressCurrent()) throw new RemoteFault("egress_denied");
          // No caller headers/cookies, custom DNS overrides, redirects or auth provider.
          let response = await (ports.fetch ?? fetch)(profile.endpoint, { method: "POST", body: init.body,
            headers, redirect: "manual", credentials: "omit", cache: "no-store", signal });
          if (signal.aborted) { void response.body?.cancel().catch(() => undefined); throw new RemoteFault("operation_timed_out"); }
          if (response.status === 401 || response.status === 403) {
            void response.body?.cancel().catch(() => undefined); throw new RemoteFault("authorization_required");
          }
          if (response.status === 429 || response.status >= 500) {
            void response.body?.cancel().catch(() => undefined); throw new RemoteFault("upstream_unavailable");
          }
          response = sessionState.response(response, method);
          if (method === "notifications/initialized") {
            void response.body?.cancel().catch(() => undefined);
            if (response.status !== 202) throw new RemoteFault("upstream_protocol_error");
            return new Response(null, { status: 202 });
          }
          const guarded = await guardedRemoteResponse(response, message.id as string | number, signal, account);
          const text = await guarded.text();
          if (!credentialCurrent() || !egressCurrent()) throw new RemoteFault("result_withheld");
          // Detect direct reflection of our bearer; this is not a general DLP promise.
          if (credential !== null && credential.token.length >= 12 && text.includes(credential.token)) throw new RemoteFault("result_invalid");
          if (sessionState.reflected(text)) throw new RemoteFault("result_invalid");
          if (method === "tools/list") {
            const reply = boundedWireJson(text), result = catalogObject(reply.result);
            if (result !== undefined) {
              if (!Array.isArray(result.tools) || (totalTools += result.tools.length) > CATALOG_LIMITS.tools
                || result.tools.some(tool => parseRemoteTool(tool) === undefined)
                || (result.nextCursor !== undefined && (typeof result.nextCursor !== "string" || !result.nextCursor || result.nextCursor.length > 2048)))
                throw new RemoteFault("upstream_protocol_error");
            }
          }
          return new Response(text, { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
        } catch (error) {
          lastFault = error instanceof RemoteFault ? error : new RemoteFault(signal.aborted ? "operation_timed_out" : "upstream_unavailable");
          throw lastFault;
        }
      };
      const client = new Client({ name: "runmesh-central", version: "1" }, { capabilities: {}, enforceStrictCapabilities: true,
        jsonSchemaValidator: validator, defaultCacheTtlMs: 0, listMaxPages: REMOTE_LIMITS.pages,
        inputRequired: { autoFulfill: false, maxRounds: 0 }, supportedProtocolVersions: rule.negotiate ? ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] : [rule.protocol],
        versionNegotiation: { mode: rule.negotiate ? "auto" : rule.protocol === "2026-07-28" ? { pin: rule.protocol } : "legacy", probe: { maxRetries: 0 } } });
      const transport = new StreamableHTTPClientTransport(new URL(profile.endpoint), { fetch: guardedFetch, protocolVersion: rule.protocol,
        reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 0, maxReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 } });
      client.onerror = () => undefined;
      const close = async () => {
        await sessionState.close(); parent.removeEventListener("abort", abort); controller.abort(); await client.close().catch(() => undefined);
      };
      try {
        await client.connect(transport, { signal, timeout: REMOTE_LIMITS.operation_ms });
        if (signal.aborted || client.getServerCapabilities()?.tools === undefined) throw new RemoteFault("upstream_protocol_error");
      } catch (error) { await close(); throw lastFault ?? (error instanceof RemoteFault ? error : new RemoteFault("upstream_protocol_error")); }
      return {
        async listTools() {
          try {
            const response = await client.listTools({}, { signal, timeout: REMOTE_LIMITS.operation_ms });
            const tools: RemoteToolDefinition[] = [], names = new Set<string>();
            if (response.tools.length > CATALOG_LIMITS.tools) throw new RemoteFault("upstream_protocol_error");
            for (const value of response.tools) {
              const tool = parseRemoteTool(value);
              if (tool === undefined || names.has(tool.name)) throw new RemoteFault("upstream_protocol_error");
              names.add(tool.name); tools.push(tool);
            }
            if (catalogJson(tools, CATALOG_LIMITS.snapshot_bytes) === undefined) throw new RemoteFault("upstream_protocol_error");
            return tools;
          } catch (error) { throw lastFault ?? (error instanceof RemoteFault ? error : new RemoteFault("upstream_protocol_error")); }
        },
        async callTool(tool, args, beforeDispatch) {
          beforeCall = beforeDispatch;
          try {
            const value = await client.callTool({ name: tool.name, arguments: args }, { signal, timeout: REMOTE_LIMITS.operation_ms });
            const result = parseRemoteResult(value);
            if (result === undefined || (!result.isError && tool.outputSchema !== undefined && !validator.validate(tool.outputSchema, result.structuredContent)))
              throw new RemoteFault("result_invalid");
            return result;
          } catch (error) { throw lastFault ?? (error instanceof RemoteFault ? error : new RemoteFault("result_invalid")); }
          finally { beforeCall = undefined; }
        },
        close,
      };
    },
  };
}
