import { expect, it, vi } from "vitest";
import { createOAuthCipher } from "../src/platform/connectors/oauth-crypto.js";
import { deriveOAuthKey, OAUTH_KEY_ID } from "../src/platform/connectors/oauth-key.js";
import { parseCredential, parseProfileCommand } from "../src/contracts/connector-values.js";

const secretA = "a".repeat(32), secretB = "b".repeat(32);
const context = JSON.stringify(["managed-oauth", "docs-account", "https://docs.example.com/mcp", 1]);
const credential = { kind: "bearer" as const, token: "synthetic-test-token" };

it("W03 cipher uses the existing control secret and round-trips across restart without storing a key", async () => {
  const load = vi.fn(() => secretA), cipher = createOAuthCipher("namespace-a", load);
  expect(load).not.toHaveBeenCalled();
  const sealed = await cipher.seal(context, credential), again = await cipher.seal(context, credential);
  expect(sealed.iv).not.toBe(again.iv); expect(sealed.key_id).toBe(OAUTH_KEY_ID);
  expect(JSON.stringify(sealed)).not.toContain(credential.token);
  expect(JSON.stringify(sealed)).not.toContain(secretA);
  expect(await createOAuthCipher("namespace-a", () => secretA).open(context, sealed)).toEqual(credential);
  expect((await deriveOAuthKey("namespace-a", secretA)).extractable).toBe(false);
});

it.each(["profile", "connector", "endpoint", "generation", "namespace", "ciphertext", "key"])("W03 rejects tampered credential binding: %s", async field => {
  const cipher = createOAuthCipher("namespace-a", () => secretA);
  const sealed = { ...await cipher.seal(context, credential) };
  const changed = ["profile", "connector", "endpoint", "generation"].includes(field) ? context + ":" + field : context;
  if (field === "ciphertext") sealed.ciphertext = (sealed.ciphertext[0] === "A" ? "B" : "A") + sealed.ciphertext.slice(1);
  if (field === "key") sealed.key_id = "missing";
  const reader = field === "namespace" ? createOAuthCipher("namespace-b", () => secretA) : cipher;
  await expect(reader.open(changed, sealed)).rejects.toThrow(/^unavailable$/u);
});

it("W03 control-secret rotation requires reconnect and does not use a stale key cache", async () => {
  let secret = secretA;
  const cipher = createOAuthCipher("namespace-a", () => secret);
  const old = await cipher.seal(context, credential);
  secret = secretB;
  await expect(cipher.open(context, old)).rejects.toThrow("unavailable");
  const next = await cipher.seal(context, credential);
  expect(await cipher.open(context, next)).toEqual(credential);
  secret = secretA;
  expect(await cipher.open(context, old)).toEqual(credential);
  await expect(cipher.open(context, next)).rejects.toThrow("unavailable");
});

it.each([undefined, null, "", "short", "a".repeat(513), "a".repeat(31) + " ", "a".repeat(31) + String.fromCharCode(0)])("W03 invalid existing secret fails with a fixed message", async raw => {
  await expect(createOAuthCipher("namespace-a", () => raw).seal(context, credential)).rejects.toThrow(/^unavailable$/u);
});

it("W03 HKDF separates OAuth encryption from the raw control secret and other namespaces", async () => {
  const material = new TextEncoder().encode(secretA), iv = new Uint8Array(12).fill(7);
  const key = await deriveOAuthKey("namespace-a", secretA);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode("credential"));
  const raw = await crypto.subtle.importKey("raw", material, "AES-GCM", false, ["decrypt"]);
  await expect(crypto.subtle.decrypt({ name: "AES-GCM", iv }, raw, ciphertext)).rejects.toThrow();
  const otherNamespace = await deriveOAuthKey("namespace-b", secretA);
  await expect(crypto.subtle.decrypt({ name: "AES-GCM", iv }, otherNamespace, ciphertext)).rejects.toThrow();
});

it("W03 supports the exact token bound and rejects injection, oversize and mixed commands", async () => {
  const cipher = createOAuthCipher("namespace-a", () => secretA);
  const maximum = { kind: "bearer" as const, token: "a".repeat(4096) };
  expect(await cipher.open(context, await cipher.seal(context, maximum))).toEqual(maximum);
  for (const token of ["a".repeat(4097), "a\r\nb", "a b", "a\tb", String.fromCharCode(127), "令牌", ""]) expect(parseCredential({ kind: "bearer", token })).toBeUndefined();
  for (const token of ["user:grant:opaque-secret", "\"quoted\"", "a\\b"]) expect(parseCredential({ kind: "bearer", token })).toEqual({ kind: "bearer", token });
  expect(parseProfileCommand({ action: "create", profile_id: "p", connector_id: "c", endpoint: "https://user:pass@example.com/mcp", credential })).toBeUndefined();
  expect(parseProfileCommand({ action: "rotate", profile_id: "p", expected_revision: 1, credential, owner: "other" })).toBeUndefined();
});
