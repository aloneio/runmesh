import { registerRunnerFromControlPlane, revokeRunnerFromControlPlane } from "./runner-administration.js";
import { matchIdentifierPath } from "./path-identifiers.js";
import { deleteRunnerFromControlPlane } from "./runner-deletion.js";
import { consumeInternalNonce } from "../platform/control-plane.js";
import { containsControlCharacter } from "../security.js";
import { credentialHeaders } from "./html-response.js";
import { discardBody } from "./request.js";
import { generateRunnerToken } from "../security.js";
import { isConfiguredSecret } from "../security.js";
import { isRunnerAdminRequest } from "./session.js";
import { isSafeIdentifier } from "../security.js";
import { MAX_INTERNAL_RPC_BODY_BYTES } from "./constants.js";
import { notFound } from "./responses.js";
import { readAdminBody } from "./request.js";
import { readCappedText as readBodyText } from "../body.js";
import { signedInternalHeaders } from "../platform/control-plane.js";
import { verifyInternalRequest } from "../security.js";
import type { WorkerEnv } from "../platform/env.js";

export async function forwardRunnerRpc(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const route = matchIdentifierPath(/^\/internal\/runners\/([^/]+)\/rpc$/, url.pathname);
  if (request.method !== "POST" || route === null) return notFound();
  const runnerId = route[1]!;
  // This route is reachable before authentication. Cap the stream before
  // buffering it for HMAC verification so an unauthenticated large request
  // cannot exhaust Worker memory.
  const body = await readBodyText(request, MAX_INTERNAL_RPC_BODY_BYTES);
  let verified = false;
  try { verified = body !== undefined && await verifyInternalRequest(request, env.INTERNAL_CONTROL_SECRET, body, consumeInternalNonce.bind(undefined, env)); } catch { verified = false; }
  if (!verified || body === undefined) return notFound();
  const headers = await signedInternalHeaders(env, "POST", "/rpc", body);
  if (headers === undefined) return notFound();
  try { return await env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/rpc", { method: "POST", headers, body })); }
  catch { return new Response("runner unavailable", { status: 503 }); }
}

export async function handleRunnerAdmin(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  if (!isRunnerAdminRequest(request, env)) { await discardBody(request); return new Response("unauthorized", { status: 401 }); }
  if (!isConfiguredSecret(env.INTERNAL_CONTROL_SECRET) || !isConfiguredSecret(env.RUNNER_TOKEN_PEPPER)) { await discardBody(request); return new Response("admin control plane is not configured", { status: 503 }); }
  if (url.pathname === "/admin/runners" && request.method === "POST") {
    const input = await readAdminBody(request); const id = typeof input?.runner_id === "string" && isSafeIdentifier(input.runner_id) ? input.runner_id : undefined;
    if (id === undefined) return Response.json({ error: "runner_id must be a safe identifier" }, { status: 400 });
    return registerRunner(env, id, input);
  }
  const route = matchIdentifierPath(/^\/admin\/runners\/([^/]+)\/(rotate|revoke|delete)$/, url.pathname);
  if (route === null || request.method !== "POST") { await discardBody(request); return notFound(); }
  const runnerId = route[1]!, action = route[2]!;
  if (action === "rotate") return registerRunner(env, runnerId, await readAdminBody(request));
  if (action === "delete") return deleteRunnerWithAdminToken(env, runnerId, await readAdminBody(request));
  if (action === "revoke") {
    const input = await readAdminBody(request);
    if (input === undefined || input.confirmation !== runnerId) return Response.json({ error: "confirmation must equal runner_id" }, { status: 400 });
    const result = await revokeRunnerFromControlPlane(env, runnerId);
    if (result.state === "completed") return new Response(null, { status: 204 });
    if (result.reason === "fence") return new Response("runner unavailable", { status: 503 });
    if (result.reason === "write") return new Response("runner revoke failed", { status: result.cause === "missing" ? 404 : result.cause === "conflict" ? 409 : 400 });
    if (result.reason === "commit") return new Response("registry mutation outcome is uncertain; Runner remains safely fenced", { status: 503 });
    if (result.reason === "finalize") return new Response("runner revocation cleanup is uncertain; Runner remains safely fenced", { status: 503 });
    return new Response("Runner remains safely fenced", { status: 503 });
  }
  return notFound();
}

async function deleteRunnerWithAdminToken(env: WorkerEnv, runnerId: string, input: Record<string, unknown> | undefined): Promise<Response> {
  const result = await deleteRunnerFromControlPlane(env, runnerId, input?.confirmation);
  if (result.state === "deleted") return new Response(null, { status: 204 });
  if (result.state === "rejected") return result.reason === "confirmation"
    ? Response.json({ error: "confirmation must equal runner_id" }, { status: 400 })
    : new Response("runner delete failed", { status: result.status });
  if (result.state === "unavailable") return new Response("runner unavailable", { status: 503 });
  if (result.reason === "commit") return new Response("registry mutation outcome is uncertain; Runner remains safely fenced", { status: 503 });
  if (result.reason === "finalize") return new Response("runner deletion outcome is uncertain; Runner remains safely fenced", { status: 503 });
  return new Response("Runner remains safely fenced", { status: 503 });
}

async function registerRunner(env: WorkerEnv, runnerId: string, input: Record<string, unknown> | undefined): Promise<Response> {
  const supplied = input?.token;
  if (supplied !== undefined && (typeof supplied !== "string" || supplied.length < 32 || supplied.length > 512 || /\s/.test(supplied) || containsControlCharacter(supplied))) return Response.json({ error: "token must be 32-512 non-whitespace characters" }, { status: 400 });
  const requestedMode = input?.execution_mode;
  if (requestedMode !== undefined && requestedMode !== "dedicated_user" && requestedMode !== "privileged_host") return Response.json({ error: "execution_mode must be dedicated_user or privileged_host" }, { status: 400 });
  if (requestedMode === "privileged_host" && input?.confirm_privileged_host !== true) return Response.json({ error: "privileged_host requires confirmation" }, { status: 400 });
  const token = typeof supplied === "string" ? supplied : generateRunnerToken(); const pepper = env.RUNNER_TOKEN_PEPPER;
  if (!isConfiguredSecret(pepper) || !isConfiguredSecret(env.INTERNAL_CONTROL_SECRET)) return new Response("admin control plane is not configured", { status: 503 });
  const result = await registerRunnerFromControlPlane(env, runnerId, token, pepper, requestedMode);
  if (result.state === "failed") {
    if (result.reason === "mode_required") return Response.json({ error: "execution_mode is required when creating a Runner" }, { status: 400 });
    if (result.reason === "read") return new Response("registry unavailable", { status: 503 });
    if (result.reason === "fence") return new Response("runner unavailable", { status: 503 });
    if (result.reason === "write") return new Response("runner registration failed", { status: result.cause === "invalid" ? 400 : result.cause === "missing" ? 404 : 409 });
    if (result.reason === "post_commit") return new Response("registry mutation failed after commit", { status: 503 });
    if (result.reason === "recovery") return new Response("Runner remains safely fenced", { status: 503 });
    if (result.reason === "finalize") return new Response("runner credential cleanup is uncertain; Runner remains safely fenced", { status: 503 });
    return new Response("registry mutation outcome is uncertain; Runner remains safely fenced", { status: 503 });
  }
  return Response.json({ runner_id: runnerId, token }, { headers: credentialHeaders("application/json; charset=utf-8") });
}
