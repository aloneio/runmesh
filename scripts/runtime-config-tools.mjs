import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

export const REQUIRED_SECRET_NAMES = Object.freeze(["INTERNAL_CONTROL_SECRET", "RUNNER_TOKEN_PEPPER"]);
export const CENTRAL_VAULT_SECRET = "CENTRAL_VAULT_KEYRING";

export function reviewedReleaseSource(version, state) {
  assert.equal(state?.version, version, "Runtime defaults must match the release lifecycle version");
  assert.ok(state.state === "candidate" || state.state === "released", "Unknown release lifecycle");
  if (state.state === "released") {
    assert.match(state.release_commit ?? "", /^[a-f0-9]{40}$/, "Published source identity is required");
    assert.match(state.manifest_sha256 ?? "", /^[a-f0-9]{64}$/, "Independent manifest verification is required");
  }
  return `// Generated from reviewed release/release-state.json; activation is never inferred from a version number.\nexport const REVIEWED_RELEASE_VERSION = ${JSON.stringify(state.state === "released" ? version : "")};\n`;
}

export function missingSecretNames(list, required = REQUIRED_SECRET_NAMES) {
  assert.ok(Array.isArray(list), "Cloudflare secret inventory is unavailable; refusing changes");
  const names = new Set();
  for (const item of list) {
    assert.ok(item !== null && typeof item === "object" && typeof item.name === "string" && item.name.length > 0, "Invalid secret inventory entry");
    assert.ok(!names.has(item.name), "Duplicate secret inventory entry");
    names.add(item.name);
  }
  return required.filter((name) => !names.has(name));
}

export function generateMissingSecrets(names) {
  assert.ok(Array.isArray(names) && new Set(names).size === names.length);
  assert.ok(names.every((name) => REQUIRED_SECRET_NAMES.includes(name) || name === CENTRAL_VAULT_SECRET), "Only missing required secrets may be generated");
  return Object.fromEntries(names.map((name) => [name, name === CENTRAL_VAULT_SECRET
    ? JSON.stringify({ schema_version: 1, active_key_id: "initial", keys: { initial: randomBytes(32).toString("base64url") } })
    : randomBytes(48).toString("base64url")]));
}
