import type { ConnectionProfile, CredentialEnvelope, ProfileResult, ProfileServicePorts } from "../../contracts/connectors.js";
import { validProfileEnvelope, parseProfile, parseProfileCommand } from "../../contracts/connector-values.js";
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
          if (current !== undefined && (parseProfile(current.profile) === undefined || !validProfileEnvelope(current.profile, current.envelope)
            || current.profile.profile_id !== command.profile_id)) return { state: "unavailable" };
          const expected = command.action === "create" || command.action === "create_oauth" ? 0 : command.expected_revision;
          if (current === undefined && command.action !== "create" && command.action !== "create_oauth") return { state: "missing" };
          if ((current?.profile.revision ?? 0) !== expected) return { state: "conflict", current_revision: current?.profile.revision ?? 0 };
          let profile: ConnectionProfile, envelope: CredentialEnvelope | null;
          if (command.action === "create" || command.action === "create_oauth") {
            profile = { schema_version: 1, profile_id: command.profile_id, connector_id: command.connector_id,
              ...(command.display_name === undefined ? {} : { display_name: command.display_name }), endpoint: command.endpoint, revision: 1, enabled: false, owner: { kind: "instance_admin" },
              credential: command.action === "create_oauth" ? null : { secret_id: command.profile_id, secret_version: 1 } };
            envelope = command.action === "create_oauth" ? null : await ports.cipher.seal(profile, command.credential);
          } else {
            const previous = parseProfile(current!.profile);
            if (previous === undefined) return { state: "unavailable" };
            profile = { ...previous, revision: expected + 1 };
            if (command.action === "enable" || command.action === "disable") {
              profile = { ...profile, enabled: command.action === "enable" }; envelope = current!.envelope;
            } else {
              if (previous.credential === null || current!.envelope === null) return { state: "invalid" };
              profile = { ...profile, credential: { ...previous.credential, secret_version: previous.credential.secret_version + 1 } };
              const credential = command.action === "rotate" ? command.credential : await ports.cipher.open(previous, current!.envelope!);
              if (expired()) return { state: "unavailable" };
              envelope = await ports.cipher.seal(profile, credential);
            }
          }
          if (expired() || parseProfile(profile) === undefined || !validProfileEnvelope(profile, envelope)) return { state: "unavailable" };
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
