import type { CapabilityAccess, CapabilityAccessDecision, CapabilityAccessPorts } from "../../contracts/capabilities.js";
import { CAPABILITY_LIMITS, parseCapabilityGrant, parseCapabilityTarget } from "../../contracts/capabilities.js";
import { parseClientIdentity } from "../../contracts/identity.js";
import { grantAllows } from "../../domain/capabilities/grants.js";

/** Construction is inert. Disabled mode must not even resolve a binding or port.
 * The decision is an observation, not a reusable grant or an execution receipt.
 * The eventual dispatch use case must recheck after queue/connection waits. */
export function createCapabilityAccess(enabled: boolean, resolvePorts: () => CapabilityAccessPorts): CapabilityAccess {
  return {
    async check(principal, input, parentSignal) {
      if (!enabled) return { state: "disabled" };
      const target = parseCapabilityTarget(input);
      if (target === undefined) return { state: "denied" };
      if (parentSignal.aborted) return { state: "unavailable" };
      const controller = new AbortController(), signal = controller.signal;
      const deadline = performance.now() + CAPABILITY_LIMITS.access_timeout_ms;
      const expired = (): boolean => signal.aborted || performance.now() >= deadline;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: () => void = () => undefined;
      const stopped = new Promise<CapabilityAccessDecision>(resolve => {
        abort = () => { controller.abort(); resolve({ state: "unavailable" }); };
        parentSignal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(abort, CAPABILITY_LIMITS.access_timeout_ms);
      });
      const observe = async (): Promise<CapabilityAccessDecision> => {
        try {
          const ports = resolvePorts();
          const first = await ports.identity.revalidate(principal, signal);
          if (expired()) return { state: "unavailable" };
          if (first.state !== "allowed") return { state: first.state };
          const identity = parseClientIdentity(first.identity);
          if (identity === undefined) return { state: "malformed" };
          if (identity.client_id !== principal.client_id || identity.secret_version !== principal.secret_version) return { state: "denied" };
          const raw = await ports.grants.readGrant(principal.client_id, signal);
          if (expired()) return { state: "unavailable" };
          if (raw === undefined) return { state: "denied" };
          const grant = parseCapabilityGrant(raw);
          if (grant === undefined) return { state: "malformed" };
          if (!grantAllows(grant, principal.client_id, target)) return { state: "denied" };
          // Registry identity can be revoked while the independent grant owner is read.
          const final = await ports.identity.revalidate(principal, signal);
          if (expired()) return { state: "unavailable" };
          if (final.state !== "allowed") return { state: final.state };
          const current = parseClientIdentity(final.identity);
          if (current === undefined) return { state: "malformed" };
          if (current.client_id !== principal.client_id || current.secret_version !== principal.secret_version) return { state: "denied" };
          return { state: "allowed", identity: current, grant_revision: grant.revision };
        } catch { return { state: "unavailable" }; }
      };
      try { return await Promise.race([observe(), stopped]); }
      finally {
        if (timer !== undefined) clearTimeout(timer);
        parentSignal.removeEventListener("abort", abort);
        controller.abort();
      }
    },
  };
}
