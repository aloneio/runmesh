import { deleteRunnerFromControlPlane } from "./runner-deletion.js";
import { cancelRunnerPolicyMutation } from "../application/runner-policy.js";
import { consumeInternalNonce } from "../platform/control-plane.js";
import { containsControlCharacter } from "../security.js";
import { credentialHeaders } from "./html-response.js";
import { discardBody } from "./request.js";
import { fenceRunnerTransport } from "../application/runner-lifecycle.js";
import { generateRunnerToken } from "../security.js";
import { isConfiguredSecret } from "../security.js";
import { isRunnerAdminRequest } from "./session.js";
import { isSafeIdentifier } from "../security.js";
import { MAX_INTERNAL_RPC_BODY_BYTES } from "./constants.js";
import { notFound } from "./responses.js";
import { readAdminBody } from "./request.js";
import { readCappedText as readBodyText } from "../body.js";
import { revokeRunnerTransport } from "../application/runner-lifecycle.js";
import { runnerMutationState } from "../application/runner-lifecycle.js";
import { runnerRegistryRequest } from "../platform/control-plane.js";
import { runnerTokenVerifier } from "../security.js";
import { signedInternalHeaders } from "../platform/control-plane.js";
import { verifyInternalRequest } from "../security.js";
import type { WorkerEnv } from "../platform/env.js";

export async function forwardRunnerRpc(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (request.method !== "POST" || segments.length !== 4 || segments[0] !== "internal" || segments[1] !== "runners" || segments[3] !== "rpc" || !isSafeIdentifier(segments[2] ?? "")) return notFound();
  // This route is reachable before authentication. Cap the stream before
  // buffering it for HMAC verification so an unauthenticated large request
  // cannot exhaust Worker memory.
  const body = await readBodyText(request, MAX_INTERNAL_RPC_BODY_BYTES);
  let verified = false;
  try { verified = body !== undefined && await verifyInternalRequest(request, env.INTERNAL_CONTROL_SECRET, body, consumeInternalNonce.bind(undefined, env)); } catch { verified = false; }
  if (!verified || body === undefined) return notFound();
  const runnerId = segments[2] as string;
  const headers = await signedInternalHeaders(env, "POST", "/rpc", body);
  if (headers === undefined) return notFound();
  try { return await env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/rpc", { method: "POST", headers, body })); }
  catch { return new Response("runner unavailable", { status: 503 }); }
}

export async function handleRunnerAdmin(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  if (!isRunnerAdminRequest(request, env)) { await discardBody(request); return new Response("unauthorized", { status: 401 }); }
  if (!isConfiguredSecret(env.INTERNAL_CONTROL_SECRET) || !isConfiguredSecret(env.RUNNER_TOKEN_PEPPER)) { await discardBody(request); return new Response("admin control plane is not configured", { status: 503 }); }
  const segments = url.pathname.split("/").filter(Boolean); const runnerId = segments[2]; const action = segments[3];
  if (segments.length === 2 && request.method === "POST") {
    const input = await readAdminBody(request); const id = typeof input?.runner_id === "string" && isSafeIdentifier(input.runner_id) ? input.runner_id : undefined;
    if (id === undefined) return Response.json({ error: "runner_id must be a safe identifier" }, { status: 400 });
    return registerRunner(env, id, input);
  }
  if (runnerId === undefined || !isSafeIdentifier(runnerId) || action === undefined || segments.length !== 4 || request.method !== "POST") { await discardBody(request); return notFound(); }
  if (action === "rotate") return registerRunner(env, runnerId, await readAdminBody(request));
  if (action === "delete") return deleteRunnerWithAdminToken(env, runnerId, await readAdminBody(request));
  if (action === "revoke") {
    const input = await readAdminBody(request);
    if (input === undefined || input.confirmation !== runnerId) return Response.json({ error: "confirmation must equal runner_id" }, { status: 400 });
    const mutationId = `credential-revoked-${crypto.randomUUID()}`;
    const fenced = await fenceRunnerTransport(env, runnerId, mutationId);
    if (!fenced.ok) return new Response("runner unavailable", { status: 503 });
    let response: Response;
    try { response = await runnerRegistryRequest(env, runnerId, "/revoke", "POST", JSON.stringify({ confirmation: runnerId, mutation_id: mutationId })); } catch { return new Response("registry mutation outcome is uncertain; Runner remains safely fenced", { status: 503 }); }
    if (!response.ok) {
      if (![400, 404, 409].includes(response.status)) return new Response("registry mutation outcome is uncertain; Runner remains safely fenced", { status: 503 });
      try {
        const cancelled = await cancelRunnerPolicyMutation(env, runnerId, mutationId);
        if (!cancelled.ok) return new Response("Runner remains safely fenced", { status: 503 });
      } catch { return new Response("Runner remains safely fenced", { status: 503 }); }
      return new Response("runner revoke failed", { status: response.status });
    }
    try { await revokeRunnerTransport(env, runnerId, mutationId); }
    catch { return new Response("runner revocation cleanup is uncertain; Runner remains safely fenced", { status: 503 }); }
    return new Response(null, { status: 204 });
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
  const mutationId = `credential-rotated-${crypto.randomUUID()}`;
  let existingResponse: Response;
  try { existingResponse = await runnerRegistryRequest(env, runnerId, "", "GET", ""); } catch { return new Response("registry unavailable", { status: 503 }); }
  if (!existingResponse.ok && existingResponse.status !== 404) return new Response("registry unavailable", { status: 503 });
  if (existingResponse.status === 404 && requestedMode === undefined) return Response.json({ error: "execution_mode is required when creating a Runner" }, { status: 400 });
  // A missing Registry row does not prove that the corresponding RunnerDO is
  // empty: a prior delete may have committed in Registry while transport
  // cleanup failed, leaving an authenticated pre-hello socket behind. Always
  // acquire the DO fence before creating or replacing a credential.
  const fenced = await fenceRunnerTransport(env, runnerId, mutationId);
  if (!fenced.ok) return new Response("runner unavailable", { status: 503 });
  let response: Response;
  try {
    // Creation mutations are recorded with a synthetic pre-version in
    // Registry, making the same fenced cleanup/retry protocol work for both a
    // fresh row and an existing credential replacement.
    response = await runnerRegistryRequest(env, runnerId, "", "PUT", JSON.stringify({ token_verifier: await runnerTokenVerifier(token, pepper), mutation_id: mutationId, ...(requestedMode === undefined ? {} : { execution_mode: requestedMode }) }));
  } catch {
    const state = await runnerMutationState(env, runnerId, mutationId).catch(() => undefined);
    if (state?.mutation_committed === true) {
      // The Registry marker and the RunnerDO mutation owner jointly identify
      // this exact registration.  The row may have crossed a delete/recreate
      // lifecycle after the initial GET, so let the transport finalizer accept
      // the committed marker's new lifecycle; it still fails closed when the
      // marker is absent, stale, or owned by another mutation.
      try { await revokeRunnerTransport(env, runnerId, mutationId, true); } catch { /* remain fenced */ }
    } else {
      try { await cancelRunnerPolicyMutation(env, runnerId, mutationId); } catch { /* remain fenced */ }
    }
    return new Response("registry mutation outcome is uncertain; Runner remains safely fenced", { status: 503 });
  }
  if (!response.ok) {
    if (![400, 404, 409].includes(response.status)) return new Response("registry mutation outcome is uncertain; Runner remains safely fenced", { status: 503 });
    const state = await runnerMutationState(env, runnerId, mutationId).catch(() => undefined);
    if (state?.mutation_committed === true) {
      try { await revokeRunnerTransport(env, runnerId, mutationId, true); } catch { return new Response("Runner remains safely fenced", { status: 503 }); }
      return new Response("registry mutation failed after commit", { status: 503 });
    }
    try {
      const cancelled = await cancelRunnerPolicyMutation(env, runnerId, mutationId);
      if (!cancelled.ok) return new Response("Runner remains safely fenced", { status: 503 });
    } catch { return new Response("Runner remains safely fenced", { status: 503 }); }
    return new Response("runner registration failed", { status: response.status });
  }
  const committed = await runnerMutationState(env, runnerId, mutationId).catch(() => undefined);
  if (committed?.mutation_committed !== true) return new Response("registry mutation outcome is uncertain; Runner remains safely fenced", { status: 503 });
  // A concurrent delete/recreate can replace the lifecycle between the
  // pre-fence GET and this finalizer.  `allow_lifecycle_change` is safe here:
  // RunnerDO still requires ownership of this mutation ID and verifies that
  // Registry committed the matching marker before it closes any socket.
  try { await revokeRunnerTransport(env, runnerId, mutationId, true); }
  catch { return new Response("runner credential cleanup is uncertain; Runner remains safely fenced", { status: 503 }); }
  return Response.json({ runner_id: runnerId, token }, { headers: credentialHeaders("application/json; charset=utf-8") });
}
