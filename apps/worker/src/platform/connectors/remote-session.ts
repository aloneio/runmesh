import { RemoteFault, type RemoteEgressRule } from "../../contracts/remote.js";
import { parseRemoteEgress } from "../../contracts/remote-values.js";

/** A legacy session belongs to exactly one operation/credential. No persistence,
 * session recovery, heartbeat or server-driven replacement is supported. */
export function createRemoteSessionState(rule: RemoteEgressRule, ports: {
  policy: () => unknown; authorize: () => Promise<void>; current: () => boolean; token: string;
  signal: AbortSignal; send: (url: string, init: RequestInit) => Promise<Response>;
}) {
  let id: string | undefined, closed = false;
  return {
    headers(headers: Headers) { if (id !== undefined) headers.set("mcp-session-id", id); },
    reflected(text: string) { return id !== undefined && id.length >= 12 && text.includes(id); },
    response(response: Response, method: string): Response {
      const next = response.headers.get("mcp-session-id");
      if (next === null && !(method === "initialize" && rule.session === "ephemeral")) return response;
      if (rule.session !== "ephemeral" || rule.protocol !== "2025-11-25" || next === null || !/^[\x21-\x7e]{1,128}$/u.test(next)
        || (id === undefined ? method !== "initialize" : next !== id)) {
        void response.body?.cancel().catch(() => undefined); throw new RemoteFault("upstream_protocol_error");
      }
      id = next;
      const headers = new Headers(response.headers); headers.delete("mcp-session-id");
      return new Response(response.body, { status: response.status, headers });
    },
    async close() {
      if (closed) return; closed = true;
      if (id === undefined || ports.signal.aborted || !ports.current()) { id = undefined; return; }
      const cleanup = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            await ports.authorize();
            if (cleanup.signal.aborted || ports.signal.aborted || !ports.current()) return;
            const current = parseRemoteEgress(ports.policy())?.find(r => r.endpoint === rule.endpoint);
            if (current?.session !== "ephemeral" || current.protocol !== rule.protocol) return;
            const response = await ports.send(rule.endpoint, { method: "DELETE", redirect: "manual", credentials: "omit",
              cache: "no-store", signal: cleanup.signal, headers: { authorization: `Bearer ${ports.token}`,
                "mcp-session-id": id!, "mcp-protocol-version": rule.protocol, "x-runmesh-mcp-hop": "1" } });
            void response.body?.cancel().catch(() => undefined);
          })(),
          new Promise<void>(resolve => { timer = setTimeout(() => { cleanup.abort(); resolve(); }, 1000); }),
        ]).catch(() => undefined);
      } finally { if (timer !== undefined) clearTimeout(timer); cleanup.abort(); id = undefined; }
    },
  };
}
