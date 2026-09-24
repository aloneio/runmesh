import { expect, it, vi } from "vitest";
import { createOAuthTransport } from "../src/platform/connectors/oauth-http.js";
import { createOAuthCipher } from "../src/platform/connectors/oauth-crypto.js";
import { oauthPolicy } from "../../../test/domain/oauth-fixtures.js";

it.each([302, 307, 401, 429, 500])("W06 token endpoint HTTP %s is never retried or redirected", async status => {
  const send = vi.fn(async () => new Response("private provider details", { status, headers: { location: "https://unapproved.example.com/token" } }));
  await expect(createOAuthTransport(send).exchange(oauthPolicy, "https://worker.test/admin/central/oauth/callback", "code", "verifier", new AbortController().signal, async () => undefined)).rejects.toBeDefined();
  expect(send).toHaveBeenCalledOnce();
});
it.each(["size", "length", "mime", "depth"])("W06 malformed %s token responses are bounded", async reason => {
  const body = reason === "size" ? " ".repeat(32769) : reason === "depth" ? "[".repeat(20) + "0" + "]".repeat(20) : "{}";
  const send = vi.fn(async () => new Response(body, { headers: { "content-type": reason === "mime" ? "text/html" : "application/json",
    ...(reason === "length" ? { "content-length": "invalid" } : {}) } }));
  await expect(createOAuthTransport(send).refresh(oauthPolicy, "refresh", new AbortController().signal, async () => undefined)).rejects.toBeDefined();
  expect(send).toHaveBeenCalledOnce();
});
it("W06 token requests stop before network when the authorization fence fails", async () => {
  const send = vi.fn(async () => Response.json({}));
  await expect(createOAuthTransport(send).refresh(oauthPolicy, "refresh", new AbortController().signal, async () => { throw new Error("denied"); })).rejects.toBeDefined();
  expect(send).not.toHaveBeenCalled();
});
it("W06 OAuth ciphertext is namespace-bound and detects altered bytes", async () => {
  const ring = JSON.stringify({ schema_version: 1, active_key_id: "one", keys: { one: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE" } });
  const a = createOAuthCipher("owner-a", () => ring, () => []), b = createOAuthCipher("owner-b", () => ring, () => []);
  const envelope = await a.seal("same-binding", { access_token: "test-token" });
  expect(await a.open("same-binding", envelope)).toEqual({ access_token: "test-token" });
  await expect(b.open("same-binding", envelope)).rejects.toBeDefined();
  await expect(a.open("other-binding", envelope)).rejects.toBeDefined();
  const changed = { ...envelope, ciphertext: (envelope.ciphertext[0] === "A" ? "B" : "A") + envelope.ciphertext.slice(1) };
  await expect(a.open("same-binding", changed)).rejects.toBeDefined();
});
