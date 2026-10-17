import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { createSecretStorage } from "../src/platform/secret-storage.js";
import type { CapabilitiesDOv1 } from "../src/capabilities-do.js";
import type { EncryptedSecret } from "../src/contracts/secret-storage.js";

const key = "synthetic-recovery-key-not-for-production-0123456789";
const context = "connection:synthetic:state:tokens";
const value = { access_token: "synthetic-recovery-token", token_type: "Bearer" };
afterEach(() => vi.restoreAllMocks());

it("reconstructs the cipher from retained object identity and key without a network side effect", async () => {
  const namespace = `fixture-${crypto.randomUUID()}`, cipher = createSecretStorage(namespace, () => key);
  const sealed = await cipher.seal(context, value), snapshot = JSON.parse(JSON.stringify(sealed));
  expect(JSON.stringify(snapshot)).not.toContain(value.access_token);
  const network = vi.spyOn(globalThis, "fetch");
  expect(await createSecretStorage(namespace, () => key).open(context, snapshot)).toEqual(value);
  expect(network).not.toHaveBeenCalled();
});

it.each(["identity", "key", "context", "ciphertext"] as const)("refuses a recovery with mismatched %s without weakening the original envelope", async change => {
  const namespace = `fixture-${crypto.randomUUID()}`, cipher = createSecretStorage(namespace, () => key);
  const sealed = await cipher.seal(context, value);
  const restored = change === "ciphertext" ? { ...sealed, ciphertext: (sealed.ciphertext[0] === "A" ? "B" : "A") + sealed.ciphertext.slice(1) } : sealed;
  const target = createSecretStorage(change === "identity" ? namespace + "-other" : namespace, () => change === "key" ? key + "-other" : key);
  await expect(target.open(change === "context" ? context + "-other" : context, restored)).rejects.toThrow("secret_storage_unavailable");
  expect(await cipher.open(context, sealed)).toEqual(value);
});

it("restores serialized local DO credential data only inside the original object identity", async () => {
  const binding = (env as unknown as { CAPABILITIES: DurableObjectNamespace<CapabilitiesDOv1> }).CAPABILITIES;
  const original = binding.get(binding.idFromName(`recovery-original-${crypto.randomUUID()}`));
  const different = binding.get(binding.idFromName(`recovery-other-${crypto.randomUUID()}`));
  await runInDurableObject(original, async (_instance, state) => {
    const cipher = createSecretStorage(state.id.toString(), () => key);
    await state.storage.put("synthetic-recovery-envelope", await cipher.seal(context, value));
  });
  const envelope = await runInDurableObject(original, async (_instance, state) => {
    const retained = await state.storage.get<EncryptedSecret>("synthetic-recovery-envelope");
    expect(await createSecretStorage(state.id.toString(), () => key).open(context, retained)).toEqual(value);
    return retained;
  });
  await runInDurableObject(different, async (_instance, state) => {
    await state.storage.put("synthetic-recovery-envelope", envelope);
    await expect(createSecretStorage(state.id.toString(), () => key).open(context, await state.storage.get("synthetic-recovery-envelope"))).rejects.toThrow("secret_storage_unavailable");
  });
});
