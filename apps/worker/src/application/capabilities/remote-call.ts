import { RemoteFault, type RemoteCallPorts, type RemoteOutcome, type RemoteSession } from "../../contracts/remote.js";
import { parseRemoteCall, parseRemoteResult } from "../../contracts/remote-values.js";
import { parseClientIdentity, type CapturedIdentity } from "../../contracts/identity.js";
import { parseProfile } from "../../contracts/connector-values.js";
import { catalogJson } from "../../contracts/catalog-json.js";
import { parseCatalogHead } from "../../contracts/catalog-values.js";
import { compatibleApprovedTools, verifiedCatalogSnapshot } from "../../domain/capabilities/catalog.js";
import { remoteDeadline } from "./remote-deadline.js";

/** Execution has its own admission, independent of a previous directory read.
 * Caller identity, exact reviewed definition and credential generations are
 * fenced again after each awaited dependency, not cached by the MCP connection. */
export function createRemoteCaller(ports: RemoteCallPorts) {
  return async (principal: CapturedIdentity, input: unknown, parent: AbortSignal): Promise<RemoteOutcome> => {
    const command = parseRemoteCall(input);
    if (command === undefined) return { state: "failed", code: "invalid_request", operation_state: "not_started" };
    let sent = false, received = false, admitted = false;
    const operationState = () => received ? "completed" as const : sent ? "unknown" as const : "not_started" as const;
    const outcome = await remoteDeadline<RemoteOutcome>(parent, () => ({ state: "failed", code: "operation_timed_out", operation_state: operationState() }), async (signal, expired) => {
      let session: RemoteSession | undefined;
      const liveIdentity = async () => {
        const state = await ports.identity(principal, signal);
        if (expired()) throw new RemoteFault("operation_timed_out");
        if (state.state !== "allowed") throw new RemoteFault(state.state === "denied" ? "permission_denied" : "dependency_unavailable");
        const identity = parseClientIdentity(state.identity);
        if (identity === undefined) throw new RemoteFault("dependency_unavailable");
        if (identity.client_id !== principal.client_id || identity.secret_version !== principal.secret_version) throw new RemoteFault("permission_denied");
      };
      try {
        await liveIdentity();
        const profile = parseProfile(ports.profile(command.profile_id));
        if (profile === undefined || profile.profile_id !== command.profile_id || !profile.enabled) throw new RemoteFault("permission_denied");
        const head = parseCatalogHead(ports.repository.readHead(profile.profile_id));
        if (head === undefined || head.profile_id !== profile.profile_id || head.approved_digest === null) throw new RemoteFault("stale_catalog");
        const observed = ports.repository.readSnapshot(profile.profile_id, head.observed_digest);
        const approved = head.approved_digest === head.observed_digest ? observed : ports.repository.readSnapshot(profile.profile_id, head.approved_digest);
        if (observed === undefined || approved === undefined || !await verifiedCatalogSnapshot(observed, profile, head.observed_digest, ports.digest)
          || (approved !== observed && !await verifiedCatalogSnapshot(approved, profile, head.approved_digest, ports.digest))) throw new RemoteFault("dependency_unavailable");
        if (expired()) throw new RemoteFault("operation_timed_out");
        const tool = compatibleApprovedTools(observed, approved, head.approved_names).find(tool => tool.tool_id === command.tool_id && tool.version === command.version);
        if (tool === undefined) throw new RemoteFault("stale_catalog");
        if (!ports.connector.validate(tool.definition.inputSchema, command.arguments)) throw new RemoteFault("invalid_arguments");
        const fence = async () => {
          await liveIdentity();
          const latestProfile = parseProfile(ports.profile(profile.profile_id));
          if (latestProfile === undefined || !latestProfile.enabled) throw new RemoteFault("permission_denied");
          if (latestProfile.revision !== profile.revision
            || latestProfile.endpoint !== profile.endpoint || latestProfile.connector_id !== profile.connector_id
            || ports.repository.readHead(profile.profile_id)?.revision !== head.revision) throw new RemoteFault("stale_catalog");
          if (expired()) throw new RemoteFault("operation_timed_out");
        };
        await fence();
        if (ports.observation && !ports.observation.admit(principal, command)) throw new RemoteFault("busy");
        admitted = true;
        session = await ports.connector.open(profile, signal, () => { sent = true; }, fence);
        if (expired()) throw new RemoteFault("operation_timed_out");
        const definitions = await session.listTools();
        if (expired()) throw new RemoteFault("operation_timed_out");
        const liveTool = definitions.find(definition => definition.name === tool.definition.name);
        if (liveTool === undefined || catalogJson(liveTool, 32_768) !== catalogJson(tool.definition, 32_768)) throw new RemoteFault("stale_catalog");
        const raw = await session.callTool(tool.definition, command.arguments, fence);
        const result = parseRemoteResult(raw);
        if (result === undefined || (!result.isError && tool.definition.outputSchema !== undefined
          && !ports.connector.validate(tool.definition.outputSchema, result.structuredContent))) throw new RemoteFault("result_invalid");
        received = true;
        // Revoked readers cannot receive data after an in-flight call. The effect
        // is still completed; withholding output never claims it was rolled back.
        try { await fence(); } catch { throw new RemoteFault("result_withheld"); }
        return { state: "completed", operation_state: "completed", result };
      } catch (error) {
        return { state: "failed", code: error instanceof RemoteFault ? error.code : "dependency_unavailable", operation_state: operationState() };
      } finally { await session?.close().catch(() => undefined); }
    });
    if (!admitted || !ports.observation) return outcome;
    // History is optional. Never reinterpret a known result or replay an effect.
    try { return { ...outcome, receipt: ports.observation.record(principal, command, outcome) }; }
    catch { return outcome; }
  };
}
