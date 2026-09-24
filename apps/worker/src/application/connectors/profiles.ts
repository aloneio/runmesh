import type { ConnectionProfile, CredentialEnvelope, ProfileResult, ProfileServicePorts } from "../../contracts/connectors.js";
import { parseEnvelope, parseProfile, parseProfileCommand } from "../../contracts/connector-values.js";
import { withinDeadline } from "./deadline.js";

/** Admin use case; synchronous storage is injected rather than imported. */
export function createProfileManager(ports: ProfileServicePorts) {
  return {
    async mutate(value: unknown, parentSignal: AbortSignal): Promise<ProfileResult> {
      const command = parseProfileCommand(value);
      if (command === undefined) return { state: "invalid" };
      let writeAttempted = false;
      return withinDeadline<ProfileResult>(parentSignal, () => ({ state: writeAttempted ? "unknown" : "unavailable" }), async (signal, expired) => {
        try {
          const initial = await ports.authorize(signal);
          if (expired()) return { state: "unavailable" };
          if (initial !== "allowed") return { state: initial === "denied" ? "denied" : "unavailable" };
          const current = ports.repository.read(command.profile_id);
          if (current !== undefined && (parseProfile(current.profile) === undefined || parseEnvelope(current.envelope) === undefined
            || current.profile.profile_id !== command.profile_id)) return { state: "unavailable" };
          const expected = command.action === "create" ? 0 : command.expected_revision;
          if (current === undefined && command.action !== "create") return { state: "missing" };
          if ((current?.profile.revision ?? 0) !== expected) return { state: "conflict", current_revision: current?.profile.revision ?? 0 };
          let profile: ConnectionProfile, envelope: CredentialEnvelope;
          if (command.action === "create") {
            profile = { schema_version: 1, profile_id: command.profile_id, connector_id: command.connector_id,
              endpoint: command.endpoint, revision: 1, enabled: false, owner: { kind: "instance_admin" },
              credential: { secret_id: command.profile_id, secret_version: 1 } };
            envelope = await ports.cipher.seal(profile, command.credential);
          } else {
            const previous = parseProfile(current!.profile);
            if (previous === undefined || previous.credential === null) return { state: "unavailable" };
            profile = { ...previous, revision: expected + 1 };
            if (command.action === "enable" || command.action === "disable") {
              profile = { ...profile, enabled: command.action === "enable" }; envelope = current!.envelope;
            } else {
              profile = { ...profile, credential: { ...previous.credential, secret_version: previous.credential.secret_version + 1 } };
              const credential = command.action === "rotate" ? command.credential : await ports.cipher.open(previous, current!.envelope);
              if (expired()) return { state: "unavailable" };
              envelope = await ports.cipher.seal(profile, credential);
            }
          }
          if (expired() || parseProfile(profile) === undefined || parseEnvelope(envelope) === undefined) return { state: "unavailable" };
          const final = await ports.authorize(signal);
          if (expired()) return { state: "unavailable" };
          if (final !== "allowed") return { state: final === "denied" ? "denied" : "unavailable" };
          writeAttempted = true;
          // No await between final authorization and the atomic revision-checked write.
          return ports.repository.replace({ profile, envelope }, expected);
        } catch { return { state: writeAttempted ? "unknown" : "unavailable" }; }
      });
    },
  };
}
