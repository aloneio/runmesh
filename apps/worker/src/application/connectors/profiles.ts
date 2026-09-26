import type { ConnectionProfile, ProfileResult, ProfileServicePorts } from "../../contracts/connectors.js";
import { validProfileEnvelope, parseProfile, parseProfileCommand } from "../../contracts/connector-values.js";
import { publicMcpEndpoint } from "../../contracts/remote-values.js";
import { withinDeadline } from "./deadline.js";

/** Admin use case; synchronous storage is injected rather than imported. */
export function createProfileManager(ports: ProfileServicePorts) {
  return {
    async mutate(value: unknown, parentSignal: AbortSignal): Promise<ProfileResult> {
      const command = parseProfileCommand(value);
      if (command === undefined || (command.action === "connect" && publicMcpEndpoint(command.endpoint) === undefined)) return { state: "invalid" };
      let writeAttempted = false;
      return withinDeadline<ProfileResult>(parentSignal, () => ({ state: writeAttempted ? "unknown" : "unavailable" }), async (signal, expired) => {
        try {
          const initial = await ports.authorize(signal);
          if (expired()) return { state: "unavailable" };
          if (initial !== "allowed") return { state: initial === "denied" ? "denied" : "unavailable" };
          const current = ports.repository.read(command.profile_id);
          if (current !== undefined && (parseProfile(current.profile) === undefined || !validProfileEnvelope(current.profile, current.envelope)
            || current.profile.profile_id !== command.profile_id)) return { state: "unavailable" };
          const expected = command.action === "connect" ? 0 : command.expected_revision;
          if (current === undefined && command.action !== "connect") return { state: "missing" };
          if ((current?.profile.revision ?? 0) !== expected) return { state: "conflict", current_revision: current?.profile.revision ?? 0 };
          const profile: ConnectionProfile = command.action === "connect"
            ? { schema_version: 1, profile_id: command.profile_id, connector_id: command.connector_id,
              ...(command.display_name === undefined ? {} : { display_name: command.display_name }), endpoint: command.endpoint,
              revision: 1, enabled: false, owner: { kind: "instance_admin" }, authentication: command.authentication, credential: null }
            : { ...current!.profile, revision: expected + 1, enabled: command.action === "enable" };
          if (expired() || parseProfile(profile) === undefined) return { state: "unavailable" };
          const final = await ports.authorize(signal);
          if (expired()) return { state: "unavailable" };
          if (final !== "allowed") return { state: final === "denied" ? "denied" : "unavailable" };
          writeAttempted = true;
          // No await between final authorization and the atomic revision-checked write.
          return ports.repository.replace({ profile, envelope: null }, expected);
        } catch { return { state: writeAttempted ? "unknown" : "unavailable" }; }
      });
    },
  };
}
