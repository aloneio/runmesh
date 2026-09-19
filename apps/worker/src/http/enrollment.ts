import { cancelRunnerPolicyMutation } from "../application/runner-policy.js";
import { boundedJsonResponse } from "../platform/bounded-json.js";
import { configuredPublicOrigin } from "./origin.js";
import { credentialHeaders } from "./html-response.js";
import { discardBody } from "./request.js";
import { fenceRunnerTransport } from "../application/runner-lifecycle.js";
import { generateRunnerToken } from "../security.js";
import { installerOriginUnavailable } from "./distribution.js";
import { isConfiguredSecret } from "../security.js";
import { isSafeIdentifier } from "../security.js";
import { json } from "../platform/control-plane.js";
import { methodNotAllowed } from "./responses.js";
import { readCappedText as readBodyText } from "../body.js";
import { record } from "../values.js";
import { registryPost } from "../platform/control-plane.js";
import { registryRequest } from "../platform/control-plane.js";
import { resolveConnectionOrigin } from "./origin.js";
import { revokeRunnerTransport } from "../application/runner-lifecycle.js";
import { runnerMutationState } from "../application/runner-lifecycle.js";
import type { RunnerPublicInfo } from "../contracts/runner-metadata.js";
import { runnerTokenVerifier } from "../security.js";
import { sha256Hex } from "../security.js";
import type { WorkerEnv } from "../platform/env.js";

export async function handleRunnerEnrollment(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method !== "POST") { await discardBody(request); return methodNotAllowed("POST"); }
  const input = await readEnrollmentBody(request);
  const code = typeof input?.enrollment_code === "string" && /^[A-Za-z0-9_-]{43}$/.test(input.enrollment_code) ? input.enrollment_code : undefined;
  const publicInfo = runnerPublicInfo(input?.runner_public_info);
  if (code === undefined || publicInfo === undefined) return enrollmentError();
  if (!isConfiguredSecret(env.RUNNER_TOKEN_PEPPER) || !isConfiguredSecret(env.INTERNAL_CONTROL_SECRET)) return enrollmentUnavailable();
  // Resolve the endpoint that will be persisted before consuming the one-time
  // code. This prevents a successful enrollment from returning an attacker-
  // controlled or unusable reconnect URL when the request arrived through a
  // misconfigured proxy.
  let publicOrigin: string;
  try { publicOrigin = resolveConnectionOrigin(request, configuredPublicOrigin(env)); } catch { return installerOriginUnavailable(); }
  const verifier = await sha256Hex(code);
  // Resolve the target before redeeming so the RunnerDO can acquire its
  // mutation fence. A direct redeem fallback would let an old socket remain
  // authorized while Registry advances the credential/epoch.
  const targetResponse = await boundedJsonResponse(signal => registryRequest(env, "/enrollments/lookup", "POST", JSON.stringify({ verifier }), signal));
  if (targetResponse?.status !== 200) return targetResponse !== undefined && [401, 403, 404].includes(targetResponse.status) ? enrollmentError() : enrollmentUnavailable();
  const target = record(targetResponse.value);
  const runnerId = typeof target?.runner_id === "string" && isSafeIdentifier(target.runner_id) ? target.runner_id : undefined;
  if (runnerId === undefined) return enrollmentUnavailable();

  const mutationId = `credential-enrolled-${crypto.randomUUID()}`;
  let fenced: Response;
  try { fenced = await fenceRunnerTransport(env, runnerId, mutationId); } catch { return enrollmentUnavailable(); }
  if (!fenced.ok) return fenced.status === 409
    ? new Response("Runner credential mutation is already in progress", { status: 409, headers: credentialHeaders("text/plain; charset=utf-8") })
    : enrollmentUnavailable();

  const token = generateRunnerToken();
  let response: Response;
  try {
    response = await registryPost(env, "/enrollments/redeem", {
      verifier, token_verifier: await runnerTokenVerifier(token, env.RUNNER_TOKEN_PEPPER), runner_public_info: publicInfo, mutation_id: mutationId,
    });
  } catch {
    // A lost response may follow a committed Registry transaction. Consult the
    // durable mutation ledger; otherwise keep the Runner fenced and report
    // uncertainty rather than issuing an unverifiable credential.
    const state = await runnerMutationState(env, runnerId, mutationId).catch(() => undefined);
    if (state?.mutation_committed === true) { try { await revokeRunnerTransport(env, runnerId, mutationId, true); } catch { /* fail closed */ } }
    return enrollmentUnavailable();
  }
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => undefined);
    const state = await runnerMutationState(env, runnerId, mutationId).catch(() => undefined);
    if (state?.mutation_committed === true) {
      try { await revokeRunnerTransport(env, runnerId, mutationId, true); } catch { /* Registry credential is authoritative */ }
      return enrollmentUnavailable();
    }
    try {
      const cancelled = await cancelRunnerPolicyMutation(env, runnerId, mutationId);
      if (!cancelled.ok) return enrollmentUnavailable();
    } catch { return enrollmentUnavailable(); }
    return [400, 401, 403, 404, 409].includes(response.status) ? enrollmentError() : enrollmentUnavailable();
  }
  const body = record(await json(response));
  if (body?.runner_id !== runnerId) return enrollmentUnavailable();
  const committed = await runnerMutationState(env, runnerId, mutationId).catch(() => undefined);
  if (committed?.mutation_committed !== true) return enrollmentUnavailable();
  // Do not release a newly-issued credential while the RunnerDO cleanup is
  // uncertain.  Registry has committed the new generation, but an old
  // pre-hello socket may still be retained by this DO; returning the token
  // before revoke succeeds would hand out a credential while transport
  // admission is not known to be clean.  The mutation remains durably fenced
  // so a later retry/reconciliation can finish the cleanup.
  try { await revokeRunnerTransport(env, runnerId, mutationId, true); }
  catch { return enrollmentUnavailable(); }
  const connectUrl = new URL("/runner/connect", publicOrigin).toString();
  return Response.json({ runner_id: runnerId, server_url: connectUrl, token }, { headers: credentialHeaders("application/json; charset=utf-8") });
}

function runnerPublicInfo(value: unknown): RunnerPublicInfo | undefined {
  const item = record(value);
  if (item === undefined || !safeDisplayText(item.platform, 128) || !safeDisplayText(item.architecture, 128) || !safeDisplayText(item.hostname, 256) || !safeDisplayText(item.runner_version, 256) || typeof item.protocol_version !== "number") return undefined;
  const info: RunnerPublicInfo = {
    platform: item.platform,
    architecture: item.architecture,
    hostname: item.hostname,
    runner_version: item.runner_version,
    protocol_version: item.protocol_version,
    ...(item.execution_mode === "dedicated_user" || item.execution_mode === "privileged_host" ? { execution_mode: item.execution_mode } : {}),
    ...(typeof item.service_identity === "string" && safeDisplayText(item.service_identity, 512) ? { service_identity: item.service_identity } : {}),
    ...(item.privilege_state === "privileged" || item.privilege_state === "restricted" || item.privilege_state === "mismatch" || item.privilege_state === "unknown" ? { privilege_state: item.privilege_state } : {}),
  };
  return Number.isSafeInteger(info.protocol_version) && info.protocol_version > 0 && info.protocol_version <= 1_000 ? info : undefined;
}

function safeDisplayText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f<>]/.test(value);
}

async function readEnrollmentBody(request: Request): Promise<Record<string, unknown> | undefined> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 4_096)) { await discardBody(request); return undefined; }
  // Do not use request.text() here: when Content-Length is absent or forged it
  // buffers the entire stream before the size check, allowing an unauthenticated
  // enrollment request to consume unbounded Worker memory. The capped reader
  // enforces the limit while consuming the stream and cancels oversized bodies.
  const body = await readBodyText(request, 4_096);
  try { return record(body === undefined ? undefined : JSON.parse(body) as unknown); } catch { return undefined; }
}

function enrollmentError(): Response { return new Response("invalid enrollment", { status: 401, headers: credentialHeaders("text/plain; charset=utf-8") }); }

function enrollmentUnavailable(): Response { return new Response("enrollment service unavailable; Runner remains safely fenced", { status: 503, headers: credentialHeaders("text/plain; charset=utf-8") }); }
