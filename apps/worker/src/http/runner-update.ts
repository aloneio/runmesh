import { RunnerUpdateClaimSchema, RunnerUpdateDrainProofSchema, RunnerUpdateResponseSchema, RunnerUpdateStatusSchema, isTerminalRunnerUpdate } from "@aloneio/runmesh-protocol";
import { bearerToken, isSafeIdentifier } from "../security.js";
import { readCappedText } from "../body.js";
import { registryGet, registryPost, signedInternalHeaders } from "../platform/control-plane.js";
import type { WorkerEnv } from "../platform/env.js";

export async function handleRunnerUpdate(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const match = /^\/runner\/([^/]+)\/update(?:\/(claim|status|drain-proof))?$/.exec(url.pathname);
  if (match === null) return new Response("not found", { status: 404 });
  let runnerId: string; try { runnerId = decodeURIComponent(match[1]!); } catch { return new Response("not found", { status: 404 }); }
  if (!isSafeIdentifier(runnerId)) return new Response("not found", { status: 404 });
  const encodedId = encodeURIComponent(runnerId); const action = match[2];
  if (request.method !== (action === undefined ? "GET" : "POST")) return new Response("method not allowed", { status: 405 });
  const token = bearerToken(request);
  if (token === undefined) return new Response("unauthorized", { status: 401 });
  const auth = await registryPost(env, `/runners/${encodedId}/auth`, { token });
  if (!auth.ok) return auth;
  const identity = await auth.json() as { credential_version: number; lifecycle_id: string };
  let input: Record<string, unknown> = {};
  if (action !== undefined) {
    const raw = await readCappedText(request, 4096);
    let value: unknown; try { value = raw === undefined ? undefined : JSON.parse(raw); } catch { value = undefined; }
    const parsed = action === "claim" ? RunnerUpdateClaimSchema.safeParse(value) : action === "drain-proof" ? RunnerUpdateDrainProofSchema.safeParse(value) : RunnerUpdateStatusSchema.safeParse(value);
    if (!parsed.success) return new Response("invalid update request", { status: 400 });
    input = parsed.data;
  }
  const path = `/runners/${encodedId}/update`;
  const result = action === undefined
    ? await registryGet(env, `${path}?lifecycle_id=${encodeURIComponent(identity.lifecycle_id)}&credential_version=${identity.credential_version}`)
    : await registryPost(env, `${path}/${action}`, { ...input, auth_lifecycle_id: identity.lifecycle_id, auth_credential_version: identity.credential_version });
  if (!result.ok) return result;
  const parsed = RunnerUpdateResponseSchema.safeParse(await result.json());
  if (!parsed.success) return new Response("update state unavailable", { status: 503 });
  const response = parsed.data; const operation = response.operation;
  // Idle and terminal polling never finalize maintenance. The manager persists its
  // terminal journal before reporting, so a failed finalization is retried by POST.
  if (operation !== null && operation.manager_id !== null && (action !== undefined || !isTerminalRunnerUpdate(operation.state))) {
    const terminal = isTerminalRunnerUpdate(operation.state) && operation.error_code !== "rollback_failed";
    const maintenanceAction = terminal ? "finish" : action === "claim" ? "begin" : action === "drain-proof" ? "drain-proof" : "read";
    const payload = { runner_id: runnerId, operation_id: operation.operation_id, lifecycle_id: operation.lifecycle_id, manager_id: operation.manager_id, credential_version: identity.credential_version, ...(action === "drain-proof" ? { old_process_stopped: true } : {}) };
    const method = maintenanceAction === "read" ? "GET" : "POST";
    const target = `/update-maintenance/${maintenanceAction}${method === "GET" ? `?operation_id=${encodeURIComponent(operation.operation_id)}&lifecycle_id=${encodeURIComponent(operation.lifecycle_id)}` : ""}`;
    const body = method === "GET" ? "" : JSON.stringify(payload);
    const headers = await signedInternalHeaders(env, method, target, body);
    if (headers === undefined) return new Response("update control unavailable", { status: 503 });
    const maintenance = await env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request(`https://runner.internal${target}`, { method, headers, ...(method === "GET" ? {} : { body }) }));
    if (!maintenance.ok) return maintenance;
    const state = await maintenance.json() as { cloud_drained?: boolean; cloud_uncertain?: boolean };
    response.cloud_drained = state.cloud_drained === true;
    response.cloud_uncertain = state.cloud_uncertain === true;
  }
  return Response.json(response, { headers: { "cache-control": "no-store" } });
}
