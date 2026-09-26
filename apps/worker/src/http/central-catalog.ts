import { CATALOG_LIMITS, type CatalogAdministration, type CatalogCommand, type CatalogDelta } from "../contracts/catalog.js";
import { catalogDigest, catalogObject, catalogRevision, toolName } from "../contracts/catalog-json.js";
import { parseCatalogCommand, parseCatalogHead, parseCatalogSnapshot } from "../contracts/catalog-values.js";
import type { WorkerEnv } from "../platform/env.js";
import { admitCentralAdmin, cancelCentralBody, centralFailure as fail, centralHeaders as headers } from "./central-boundary.js";

/** Bounded manual capture/review entry. Approval publishes the selected tools
 * to the shared library; invocation still validates live identity and schemas. */
export async function handleCentralCatalogAdmin(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  if (env.CAPABILITIES === undefined) { cancelCentralBody(request); return fail("central_disabled", 404); }
  const match = /^\/admin\/central\/catalogs\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/u.exec(url.pathname);
  const requestedDigest = url.searchParams.get("snapshot") ?? undefined;
  if (match === null || [...url.searchParams.keys()].some(key => key !== "snapshot") || url.searchParams.getAll("snapshot").length > 1
    || (requestedDigest !== undefined && (!catalogDigest(requestedDigest) || request.method !== "GET"))) {
    cancelCentralBody(request); return fail("central_not_found", 404);
  }
  const admission = await admitCentralAdmin(request, env, CATALOG_LIMITS.request_bytes);
  if (admission instanceof Response) return admission;
  const profileId = match[1]!;
  let command: CatalogCommand | undefined;
  if (request.method === "POST") {
    if (Object.hasOwn(admission.body, "profile_id")) return fail("central_invalid_request", 400);
    command = parseCatalogCommand({ ...admission.body, profile_id: profileId });
    if (command === undefined) return fail("central_invalid_request", 400);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const owner = env.CAPABILITIES.get(env.CAPABILITIES.idFromName("central")) as unknown as CatalogAdministration;
    const response = await Promise.race([
      command === undefined ? owner.getCatalog(admission.session_hash, profileId, requestedDigest) : owner.mutateCatalog(admission.session_hash, command),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 6000); }),
    ]);
    const result = catalogObject(response);
    if (result === undefined) return fail("central_result_unconfirmed", 503, "unknown");
    if (result.state === "written" || result.state === "found") {
      const head = parseCatalogHead(result.head);
      if (head === undefined || head.profile_id !== profileId || (result.state === "written") !== (command !== undefined)) return fail("central_result_unconfirmed", 503, "unknown");
      if (command !== undefined) {
        if (head.revision !== command.expected_revision + 1) return fail("central_result_unconfirmed", 503, "unknown");
        if (command.action === "approve" && (head.approved_digest !== command.digest || head.observed_digest !== command.digest
          || JSON.stringify(head.approved_names) !== JSON.stringify(command.tool_names))) return fail("central_result_unconfirmed", 503, "unknown");
        if (command.action === "disable" && (head.approved_digest !== null || head.approved_names.length !== 0)) return fail("central_result_unconfirmed", 503, "unknown");
        return Response.json({ state: "written", head }, { headers });
      }
      const snapshot = parseCatalogSnapshot(result.snapshot);
      if (snapshot === undefined || snapshot.profile_id !== profileId || snapshot.digest !== (requestedDigest ?? head.observed_digest)
        || !Array.isArray(result.changes) || result.changes.length > CATALOG_LIMITS.tools * 2) return fail("central_result_unconfirmed", 503, "unknown");
      const changes: CatalogDelta[] = [], seen = new Set<string>();
      for (const raw of result.changes) {
        const change = catalogObject(raw);
        if (change === undefined || !toolName(change.name) || seen.has(change.name)
          || !["added", "changed", "removed", "unchanged"].includes(change.state as string)) return fail("central_result_unconfirmed", 503, "unknown");
        seen.add(change.name); changes.push({ name: change.name, state: change.state as CatalogDelta["state"] });
      }
      return Response.json({ state: "found", head, snapshot, changes }, { headers });
    }
    if (result.state === "conflict") {
      if (command === undefined || !catalogRevision(result.current_revision, true)) return fail("central_result_unconfirmed", 503, "unknown");
      return Response.json({ error: { code: "central_revision_conflict", operation_state: "not_started", current_revision: result.current_revision } }, { status: 409, headers });
    }
    const states = command === undefined ? ["invalid", "missing", "denied", "unavailable"] : ["invalid", "missing", "denied", "unavailable", "unknown", "capacity", "stale_profile"];
    if (!states.includes(result.state as string)) return fail("central_result_unconfirmed", 503, "unknown");
    const status = result.state === "invalid" ? 400 : result.state === "missing" ? 404 : result.state === "denied" ? 403
      : result.state === "capacity" ? 429 : result.state === "stale_profile" ? 409 : 503;
    return fail(`central_${result.state}`, status, result.state === "unknown" ? "unknown" : "not_started");
  } catch { return fail("central_result_unconfirmed", 503, "unknown"); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
