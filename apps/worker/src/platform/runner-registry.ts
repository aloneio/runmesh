import type { WorkerEnv } from "./env.js";
import { internalHeaders, isConfiguredSecret } from "../security.js";

export function requestRunnerRegistry(env: WorkerEnv, runnerId: string, action: string, init: RequestInit): Promise<Response> {
    if (!isConfiguredSecret(env.INTERNAL_CONTROL_SECRET)) return Promise.resolve(new Response("control plane is not configured", { status: 503 }));
    const id = env.REGISTRY.idFromName("registry");
    const path = `/runners/${encodeURIComponent(runnerId)}${action}`;
    const body = typeof init.body === "string" ? init.body : "";
    const headersPromise = internalHeaders(env.INTERNAL_CONTROL_SECRET, init.method ?? "GET", path, body);
    return headersPromise
      .then((headers) => env.REGISTRY.get(id).fetch(new Request(`https://registry.internal${path}`, { ...init, headers })))
      .catch(() => new Response("registry unavailable", { status: 503 }));
  }
