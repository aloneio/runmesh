import { expect, it, vi } from "vitest";
import { createOAuthCipher } from "../src/platform/connectors/oauth-crypto.js";
import { encodeBytes, loadCipherKey } from "../src/platform/connectors/keyring.js";
import { parseCredential, parseProfileCommand } from "../src/contracts/connector-values.js";

const keyA = encodeBytes(new Uint8Array(32).fill(1)), keyB = encodeBytes(new Uint8Array(32).fill(2));
const ring = (active = "key-a", keys: Record<string, string> = { "key-a": keyA }) => JSON.stringify({ schema_version: 1, active_key_id: active, keys });
const context = JSON.stringify(["managed-oauth", "docs-account", "https://docs.example.com/mcp", 1]);
const credential = { kind: "bearer" as const, token: "synthetic-test-token" };

it("W03 cipher construction is inert and encryption round-trips without plaintext in its envelope", async () => {
  const load = vi.fn(() => ring()), cipher = createOAuthCipher("namespace-a", load, () => []);
  expect(load).not.toHaveBeenCalled();
  const sealed = await cipher.seal(context, credential), again = await cipher.seal(context, credential);
  expect(sealed.iv).not.toBe(again.iv);
  expect(JSON.stringify(sealed)).not.toContain(credential.token);
  expect(await cipher.open(context, sealed)).toEqual(credential);
  expect((await loadCipherKey(ring(), undefined, [])).key.extractable).toBe(false);
});

it.each(["profile", "connector", "endpoint", "generation", "namespace", "ciphertext", "key"])("W03 rejects tampered credential binding: %s", async field => {
  const cipher = createOAuthCipher("namespace-a", () => ring(), () => []);
  const sealed = { ...await cipher.seal(context, credential) };
  const changed = ["profile", "connector", "endpoint", "generation"].includes(field) ? context + ":" + field : context;
  if (field === "ciphertext") sealed.ciphertext = (sealed.ciphertext[0] === "A" ? "B" : "A") + sealed.ciphertext.slice(1);
  if (field === "key") sealed.key_id = "missing";
  const reader = field === "namespace" ? createOAuthCipher("namespace-b", () => ring(), () => []) : cipher;
  await expect(reader.open(changed, sealed)).rejects.toThrow(/^unavailable$/u);
});

it("W03 key rotation keeps old reads only while their key remains configured", async () => {
  let keys = ring();
  const cipher = createOAuthCipher("namespace-a", () => keys, () => []);
  const old = await cipher.seal(context, credential);
  keys = ring("key-b", { "key-a": keyA, "key-b": keyB });
  expect(await cipher.open(context, old)).toEqual(credential);
  const next = await cipher.seal(context, await cipher.open(context, old));
  expect(next.key_id).toBe("key-b");
  keys = ring("key-b", { "key-b": keyB });
  expect(await cipher.open(context, next)).toEqual(credential);
  await expect(cipher.open(context, old)).rejects.toThrow("unavailable");
});

it.each([undefined, "null", "{}", "not-json", ring("missing"), ring("key-a", { "key-a": "invalid" }),
  ring("key-a", { "key-a": keyA, "duplicate": keyA })])("W03 malformed key configuration fails with a fixed message", async raw => {
  await expect(createOAuthCipher("namespace-a", () => raw, () => []).seal(context, credential)).rejects.toThrow(/^unavailable$/u);
});

it("W03 refuses reuse of reserved control credentials as an encryption key", async () => {
  await expect(createOAuthCipher("namespace-a", () => ring(), () => [keyA]).seal(context, credential)).rejects.toThrow("unavailable");
});

it("W03 supports the exact token bound and rejects injection, oversize and mixed commands", async () => {
  const cipher = createOAuthCipher("namespace-a", () => ring(), () => []);
  const maximum = { kind: "bearer" as const, token: "a".repeat(4096) };
  expect(await cipher.open(context, await cipher.seal(context, maximum))).toEqual(maximum);
  for (const token of ["a".repeat(4097), "a\r\nb", "a b", "\"quoted\"", "a\\b", ""]) expect(parseCredential({ kind: "bearer", token })).toBeUndefined();
  expect(parseProfileCommand({ action: "create", profile_id: "p", connector_id: "c", endpoint: "https://user:pass@example.com/mcp", credential })).toBeUndefined();
  expect(parseProfileCommand({ action: "rotate", profile_id: "p", expected_revision: 1, credential, owner: "other" })).toBeUndefined();
});
