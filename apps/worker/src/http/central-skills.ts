import type { WorkerEnv } from "../platform/env.js";
import { SKILL_LIMITS, type CentralSkills } from "../contracts/skills.js";
import { admitCentralAdmin, centralFailure, centralHeaders, cancelCentralBody } from "./central-boundary.js";
import { verifySkillBundle } from "../domain/skills/bundle.js";
import { parseSkillCommand, skillDigest, skillObject, type SkillCommand } from "../contracts/skill-values.js";
import { sha256Hex } from "../security.js";
import { isCapabilityIdentifier } from "../contracts/capabilities.js";
import { listSkillLibraryResponse } from "./central-skill-library.js";
import { matchIdentifierPath } from "./path-identifiers.js";

async function safeSkillResponse(raw: unknown, id: string, command: SkillCommand | undefined, requestedDigest: string | undefined): Promise<Record<string, unknown> | undefined> {
  const value = skillObject(raw); if (!value) return undefined;
  if (value.state === 'conflict') return command !== undefined && command.action !== 'preview' && Number.isSafeInteger(value.current_revision) && (value.current_revision as number) >= 0 ? { state: 'conflict', current_revision: value.current_revision } : undefined;
  if (typeof value.state === 'string' && ['invalid', 'missing', 'denied', 'unavailable', 'capacity', 'unknown'].includes(value.state)) return { state: value.state };
  const expectedState = command === undefined ? 'found' : command.action === 'preview' ? 'previewed' : 'written';
  if (value.state !== expectedState) return undefined;
  const result: Record<string, unknown> = { state: value.state };
  let selectedDigest = requestedDigest;
  if (value.state !== 'previewed') {
    const head = skillObject(value.head);
    if (!head || head.skill_id !== id || !Number.isSafeInteger(head.revision) || (head.revision as number) < 1 || typeof head.enabled !== 'boolean'
      || !skillDigest(head.staged_digest) || (head.active_digest !== null && !skillDigest(head.active_digest)) || (head.enabled && head.active_digest === null)) return undefined;
    if (command !== undefined && command.action !== 'preview') {
      if (head.revision !== command.expected_revision + 1) return undefined;
      if (command.action === 'disable' && head.enabled) return undefined;
      if (command.action === 'activate' && (!head.enabled || head.active_digest !== command.digest)) return undefined;
    }
    selectedDigest ??= head.staged_digest;
    result.head = { skill_id: id, revision: head.revision, staged_digest: head.staged_digest, active_digest: head.active_digest, enabled: head.enabled };
  }
  if (value.state !== 'written') {
    const bundle = await verifySkillBundle(value.bundle, sha256Hex), digest = skillObject(value.bundle)?.digest;
    if (!bundle || bundle.skill_id !== id || !skillDigest(digest) || value.state === 'found' && digest !== selectedDigest) return undefined;
    result.bundle = { ...bundle, digest };
  }
  return result;
}

export async function handleCentralSkills(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  if (env.CENTRAL_SKILLS_ENABLED !== "1") { cancelCentralBody(request); return centralFailure("central_skills_disabled", 404); }
  if (url.pathname === "/admin/central/skills") {
    if (request.method !== "GET" || [...url.searchParams.keys()].some(k => k !== "after")
      || url.searchParams.getAll("after").length > 1 || (url.searchParams.has("after") && !isCapabilityIdentifier(url.searchParams.get("after")))) {
      cancelCentralBody(request); return centralFailure("central_invalid_request", 400);
    }
    const admission = await admitCentralAdmin(request, env, SKILL_LIMITS.request_bytes);
    if (admission instanceof Response) return admission;
    return listSkillLibraryResponse(env, admission.session_hash, url.searchParams.get("after") ?? undefined);
  }
  const match = matchIdentifierPath(/^\/admin\/central\/skills\/([^/]+)$/u, url.pathname);
  if (match === null || [...url.searchParams.keys()].some(k => k !== "digest")
    || url.searchParams.getAll("digest").length > 1 || (request.method !== "GET" && url.search)) {
    cancelCentralBody(request); return centralFailure("central_invalid_request", 400);
  }
  const id = match[1]!;
  const admission = await admitCentralAdmin(request, env, SKILL_LIMITS.request_bytes);
  if (admission instanceof Response) return admission;
  if (Object.hasOwn(admission.body, "skill_id")) return centralFailure("central_invalid_request", 400);
  const command = request.method === "POST" ? parseSkillCommand({ ...admission.body, skill_id: id }) : undefined;
  if (request.method === "POST" && command === undefined) return Response.json({ state: "invalid" }, { status: 400, headers: centralHeaders });
  const requestedDigest = url.searchParams.get("digest") ?? undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const owner = env.CAPABILITIES!.get(env.CAPABILITIES!.idFromName("central")) as unknown as CentralSkills;
    const result = await Promise.race([request.method === "GET"
      ? owner.inspectSkill(admission.session_hash, id, requestedDigest)
      : owner.mutateSkill(admission.session_hash, { ...admission.body, skill_id: id }),
    new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), SKILL_LIMITS.operation_ms + 1_000); })]);
    const safe = await safeSkillResponse(result, id, command, requestedDigest);
    if (!result || !safe) return centralFailure("central_result_unconfirmed", 503, "unknown");
    const status = ["found", "written", "previewed"].includes(result.state) ? 200 : result.state === "conflict" ? 409
      : result.state === "invalid" ? 400 : result.state === "denied" ? 403 : result.state === "missing" ? 404 : result.state === "capacity" ? 429 : 503;
    return Response.json(safe, { status, headers: centralHeaders });
  } catch { return centralFailure("central_result_unconfirmed", 503, "unknown"); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
