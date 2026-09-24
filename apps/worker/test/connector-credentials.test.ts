import { expect, it, vi } from "vitest";
import { createCredentialCipher } from "../src/platform/connectors/cipher.js";
import { encodeBytes, loadCipherKey } from "../src/platform/connectors/keyring.js";
import { parseCredential, parseProfileCommand } from "../src/contracts/connector-values.js";
import type { ConnectionProfile } from "../src/contracts/connectors.js";

const keyA = encodeBytes(new Uint8Array(32).fill(1)), keyB = encodeBytes(new Uint8Array(32).fill(2));
const ring = (active = "key-a", keys: Record<string, string> = { "key-a": keyA }) => JSON.stringify({ schema_version: 1, active_key_id: active, keys });
const profile: ConnectionProfile = { schema_version: 1, profile_id: "docs-account", connector_id: "docs",
  endpoint: "https://docs.example/mcp", owner: { kind: "instance_admin" }, revision: 1, enabled: false,
  credential: { secret_id: "docs-account", secret_version: 1 } };
const credential = { kind: "bearer" as const, token: "synthetic-test-token" };

it("W03 cipher construction is inert and encryption round-trips without plaintext in its envelope", async () => {
  const load = vi.fn(() => ring()), cipher = createCredentialCipher("namespace-a", load);
  expect(load).not.toHaveBeenCalled();
  const sealed = await cipher.seal(profile, credential), again = await cipher.seal(profile, credential);
  expect(sealed.iv).not.toBe(again.iv);
  expect(JSON.stringify(sealed)).not.toContain(credential.token);
  expect(await cipher.open(profile, sealed)).toEqual(credential);
  expect((await loadCipherKey(ring(), undefined, [])).key.extractable).toBe(false);
});

it.each(["profile", "connector", "endpoint", "generation", "namespace", "ciphertext", "key"])("W03 rejects tampered credential binding: %s", async field => {
  const cipher = createCredentialCipher("namespace-a", () => ring());
  const sealed = { ...await cipher.seal(profile, credential) };
  const changed = { ...profile };
  if (field === "profile") { changed.profile_id = "other"; changed.credential = { secret_id: "other", secret_version: 1 }; }
  if (field === "connector") changed.connector_id = "other";
  if (field === "endpoint") changed.endpoint = "https://other.example/mcp";
  if (field === "generation") changed.credential = { secret_id: profile.profile_id, secret_version: 2 };
  if (field === "ciphertext") sealed.ciphertext = (sealed.ciphertext[0] === "A" ? "B" : "A") + sealed.ciphertext.slice(1);
  if (field === "key") sealed.key_id = "missing";
  const reader = field === "namespace" ? createCredentialCipher("namespace-b", () => ring()) : cipher;
  await expect(reader.open(changed, sealed)).rejects.toThrow(/^central_credential_unavailable$/u);
});

it("W03 key rotation keeps old reads only while their key remains configured", async () => {
  let keys = ring();
  const cipher = createCredentialCipher("namespace-a", () => keys);
  const old = await cipher.seal(profile, credential);
  keys = ring("key-b", { "key-a": keyA, "key-b": keyB });
  expect(await cipher.open(profile, old)).toEqual(credential);
  const next = await cipher.seal(profile, await cipher.open(profile, old));
  expect(next.key_id).toBe("key-b");
  keys = ring("key-b", { "key-b": keyB });
  expect(await cipher.open(profile, next)).toEqual(credential);
  await expect(cipher.open(profile, old)).rejects.toThrow("central_credential_unavailable");
});

it.each([undefined, "null", "{}", "not-json", ring("missing"), ring("key-a", { "key-a": "invalid" }),
  ring("key-a", { "key-a": keyA, "duplicate": keyA })])("W03 malformed key configuration fails with a fixed message", async raw => {
  await expect(createCredentialCipher("namespace-a", () => raw).seal(profile, credential)).rejects.toThrow(/^central_credential_unavailable$/u);
});

it("W03 refuses reuse of reserved control credentials as an encryption key", async () => {
  await expect(createCredentialCipher("namespace-a", () => ring(), () => [keyA]).seal(profile, credential)).rejects.toThrow("central_credential_unavailable");
});

it("W03 supports the exact token bound and rejects injection, oversize and mixed commands", async () => {
  const cipher = createCredentialCipher("namespace-a", () => ring());
  const maximum = { kind: "bearer" as const, token: "a".repeat(4096) };
  expect(await cipher.open(profile, await cipher.seal(profile, maximum))).toEqual(maximum);
  for (const token of ["a".repeat(4097), "a\r\nb", "a b", "\"quoted\"", "a\\b", ""]) expect(parseCredential({ kind: "bearer", token })).toBeUndefined();
  expect(parseProfileCommand({ action: "create", profile_id: "p", connector_id: "c", endpoint: "https://user:pass@example.com/mcp", credential })).toBeUndefined();
  expect(parseProfileCommand({ action: "rotate", profile_id: "p", expected_revision: 1, credential, owner: "other" })).toBeUndefined();
});
