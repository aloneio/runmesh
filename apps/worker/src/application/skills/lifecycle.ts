import { isCapabilityIdentifier } from "../../contracts/capabilities.js";
import { SKILL_LIFECYCLE_LIMITS, type SkillLifecycleAction, type SkillLifecyclePorts, type SkillLifecycleResult } from "../../contracts/skill-lifecycle.js";
import { verifySkillBundle } from "../../domain/skills/bundle.js";
import { skillDigest } from "../../contracts/skill-values.js";
import { cleanupSelection, compareSkillVersions } from "../../domain/skills/lifecycle.js";
import { cleanupDigests, lifecycleInput, lifecycleRevision } from "../../contracts/skill-lifecycle-values.js";

/** Administrator maintenance shares the content owner and publication revision. */
export function createSkillLifecycle(ports: SkillLifecyclePorts) {
  return async (hash: string, id: string, action: SkillLifecycleAction, raw: unknown, signal: AbortSignal): Promise<SkillLifecycleResult> => {
    let mutationStarted = false;
    try {
      if (!isCapabilityIdentifier(id) || typeof hash !== "string" || !/^[a-f0-9]{64}$/u.test(hash)) return { state: "invalid" };
      const authorize = async () => {
        const decision = await ports.admin(hash, signal);
        return signal.aborted ? "unavailable" : decision;
      };
      const admission = await authorize(); if (admission !== "allowed") return { state: admission };
      const history = ports.repository.history(id);
      if (!history) return { state: "missing" };
      if (action === "versions") return lifecycleInput(raw, []) ? history : { state: "invalid" };
      if (action === "compare") {
        const input = lifecycleInput(raw, ["before", "after"]);
        if (!input || !skillDigest(input.before) || !skillDigest(input.after)) return { state: "invalid" };
        const old = ports.repository.bundle(id, input.before), next = ports.repository.bundle(id, input.after);
        if (!old || !next) return { state: "missing" };
        const before = await verifySkillBundle(old, ports.digest), after = await verifySkillBundle(next, ports.digest);
        if (!before || !after || before.skill_id !== id || after.skill_id !== id || before.digest !== input.before || after.digest !== input.after) return { state: "unavailable" };
        const result = compareSkillVersions(before, after, history.head.revision);
        const final = await authorize(); if (final !== "allowed") return { state: final };
        if (ports.repository.history(id)?.head.revision !== history.head.revision) return { state: "conflict" };
        return result;
      }
      if (action === "retention") {
        const input = lifecycleInput(raw, ["digest", "pinned", "expected_revision"]);
        if (!input || !skillDigest(input.digest) || typeof input.pinned !== "boolean" || !lifecycleRevision(input.expected_revision)) return { state: "invalid" };
        const final = await authorize(); if (final !== "allowed") return { state: final };
        mutationStarted = true;
        return ports.repository.retain(id, input.digest, input.pinned, input.expected_revision);
      }
      if (action === "cleanup-preview") {
        const input = lifecycleInput(raw, ["digests", "expected_revision"]), digests = cleanupDigests(input?.digests);
        if (!input || !digests || !lifecycleRevision(input.expected_revision)) return { state: "invalid" };
        if (input.expected_revision !== history.head.revision) return { state: "conflict", current_revision: history.head.revision };
        const selected = cleanupSelection(history.versions, digests); if (selected.state !== "selected") return selected;
        const expires = ports.now() + SKILL_LIFECYCLE_LIMITS.preview_ms;
        if (!Number.isSafeInteger(expires) || expires < 0) return { state: "unavailable" };
        const value = { skill_id: id, revision: history.head.revision, digests, bytes: selected.bytes, expires_at_ms: expires };
        const fingerprint = await ports.digest(JSON.stringify({ ...value, session_hash: hash }));
        if (!skillDigest(fingerprint)) return { state: "unavailable" };
        const final = await authorize(); if (final !== "allowed") return { state: final };
        return ports.repository.preview({ ...value, fingerprint }, hash);
      }
      if (action === "cleanup") {
        const input = lifecycleInput(raw, ["fingerprint", "expected_revision", "confirm"]);
        if (!input || !skillDigest(input.fingerprint) || !lifecycleRevision(input.expected_revision) || input.confirm !== true) return { state: "invalid" };
        const final = await authorize(); if (final !== "allowed") return { state: final };
        mutationStarted = true;
        return ports.repository.cleanup(id, input.fingerprint, input.expected_revision, hash, ports.now());
      }
      return { state: "invalid" };
    } catch { return { state: mutationStarted ? "unknown" : "unavailable" }; }
  };
}
