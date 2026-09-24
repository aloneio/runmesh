import { expect, it, vi } from "vitest";
import { createOAuthManager } from "../../apps/worker/src/application/connectors/oauth.js";
import { OAuthFault } from "../../apps/worker/src/contracts/oauth.js";
import { adminHash, oauthFixture, oauthPrincipal, oauthProfile } from "./oauth-fixtures.js";

it("W06 callbacks are single-use even when two requests race", async () => {
  const f = oauthFixture(), { callback } = await f.begin();
  const results = await Promise.all([f.manager.complete(adminHash, callback, f.signal()), f.manager.complete(adminHash, callback, f.signal())]);
  expect(results.filter(r => r.state === "linked")).toHaveLength(1);
  expect(results.filter(r => r.state === "failed")).toHaveLength(1);
  expect(f.exchange).toHaveBeenCalledOnce(); expect(f.flows.size).toBe(0);
  expect(await f.manager.complete(adminHash, callback, f.signal())).toMatchObject({ state: "failed", code: "invalid_callback" });
});
it.each(["session", "issuer", "expired", "identity", "policy"])("W06 rejects %s before exchanging a code", async kind => {
  const f = oauthFixture(), { callback } = await f.begin();
  if (kind === "expired") f.advance(300_001);
  if (kind === "identity") f.revokeIdentity();
  if (kind === "policy") f.changePolicy();
  const result = await f.manager.complete(kind === "session" ? "b".repeat(64) : adminHash,
    kind === "issuer" ? { ...callback, iss: "https://other.example.com" } : callback, f.signal());
  expect(result.state).toBe("failed"); expect(f.exchange).not.toHaveBeenCalled();
});
it("W06 cancellation error consumes state without sending the code", async () => {
  const f = oauthFixture(), { callback } = await f.begin(); const { code, ...rest } = callback;
  expect(await f.manager.complete(adminHash, { ...rest, error: "access_denied" }, f.signal())).toMatchObject({ state: "failed" });
  expect(f.exchange).not.toHaveBeenCalled(); expect(f.flows.size).toBe(0);
  expect([...f.links.values()][0]?.state).toBe("reauthorize");
});
it("W06 revocation during token exchange cannot resurrect a link", async () => {
  const f = oauthFixture(), start = await f.begin();
  f.exchange.mockImplementation(async () => {
    expect(await f.manager.revoke(adminHash, f.selection(undefined, start.result.link.revision), f.signal())).toMatchObject({ state: "revoked" });
    return { access_token: "access-first", refresh_token: "refresh-first", expires_in: 60, token_type: "Bearer", scope: "read" };
  });
  expect(await f.manager.complete(adminHash, start.callback, f.signal())).toMatchObject({ state: "failed" });
  expect([...f.links.values()][0]?.state).toBe("revoked"); expect([...f.links.values()][0]?.envelope).toBeNull();
});
it("W06 no code retry occurs after a lost token endpoint response", async () => {
  const f = oauthFixture(), { callback } = await f.begin(); f.exchange.mockRejectedValue(new Error("private failure"));
  expect(await f.manager.complete(adminHash, callback, f.signal())).toMatchObject({ state: "failed", operation_state: "unknown" });
  expect(await f.manager.complete(adminHash, callback, f.signal())).toMatchObject({ state: "failed", code: "invalid_callback" });
  expect(f.exchange).toHaveBeenCalledOnce(); expect([...f.links.values()][0]?.state).toBe("reauthorize");
});
it("W06 two MCP identities have independent links and token generations", async () => {
  const f = oauthFixture(); await f.linked();
  f.exchange.mockResolvedValue({ access_token: "access-other", refresh_token: "refresh-other", expires_in: 60, token_type: "Bearer", scope: "read" });
  await f.linked("client-b");
  expect((await f.credential()).credential.token).toBe("access-first");
  expect((await f.credential("client-b")).credential.token).toBe("access-other");
  await expect(f.credential("unknown-client")).rejects.toMatchObject({ code: "reauthorization_required" });
  expect(f.links.size).toBe(2);
});
it("W06 concurrent refreshes merge into one rotating-token request", async () => {
  const f = oauthFixture(); await f.linked(); f.advance(31_000);
  const [a, b] = await Promise.all([f.credential(), f.credential()]);
  expect(f.refresh).toHaveBeenCalledOnce(); expect(a.credential.token).toBe("access-next"); expect(b.credential).toEqual(a.credential);
  expect(a.current()).toBe(true);
});

it("W06 local revocation invalidates leases without decrypting", async () => {
  const f = oauthFixture(), { link } = await f.linked(), lease = await f.credential();
  const open = vi.spyOn(f.ports.cipher, "open").mockRejectedValue(new Error("key removed"));
  expect(await f.manager.revoke(adminHash, f.selection(undefined, link.revision), f.signal())).toMatchObject({ state: "revoked" });
  expect(open).not.toHaveBeenCalled(); expect(lease.current()).toBe(false);
});
it("W06 a failed refresh quarantines the generation instead of replaying it", async () => {
  const f = oauthFixture(); await f.linked(); f.advance(31_000); f.refresh.mockRejectedValue(new Error("unknown token exchange"));
  await expect(f.credential()).rejects.toBeDefined();
  await expect(f.credential()).rejects.toMatchObject({ code: "reauthorization_required" });
  expect(f.refresh).toHaveBeenCalledOnce(); expect([...f.links.values()][0]?.state).toBe("reauthorize");
});
it("W06 a restarted owner cannot replay an in-flight refresh claim", async () => {
  const f = oauthFixture(); await f.linked(); const current = [...f.links.values()][0]!;
  f.ports.repository.transition({ ...current, revision: current.revision + 1, state: "refreshing" }, current.revision, "ready");
  await expect(createOAuthManager(f.ports).credential(oauthProfile, oauthPrincipal, f.signal(), async () => undefined))
    .rejects.toMatchObject({ code: "reauthorization_required" });
  expect(f.refresh).not.toHaveBeenCalled();
});
it.each(["identity", "profile", "admin"])("W06 %s revocation during token exchange fences storage", async kind => {
  const f = oauthFixture(), { callback } = await f.begin();
  f.exchange.mockImplementation(async () => {
    if (kind === "identity") f.revokeIdentity();
    if (kind === "profile") f.changeProfile();
    if (kind === "admin") f.revokeAdmin();
    return { access_token: "access-first", refresh_token: "refresh-first", expires_in: 60, token_type: "Bearer", scope: "read" };
  });
  expect(await f.manager.complete(adminHash, callback, f.signal())).toMatchObject({ state: "failed" });
  expect([...f.links.values()][0]?.state).toBe("reauthorize");
});
it("W06 each refresh waiter rechecks its own grant before receiving a lease", async () => {
  const f = oauthFixture(); await f.linked(); f.advance(31_000); let checks = 0;
  const guard = async () => { if (++checks > 1) throw new OAuthFault("denied"); };
  const results = await Promise.allSettled([f.credential(), f.manager.credential(oauthProfile, oauthPrincipal, f.signal(), guard)]);
  expect(f.refresh).toHaveBeenCalledOnce(); expect(results[1]?.status).toBe("rejected");
});

it("W06 expired token responses cannot commit before a delayed timer callback", async () => {
  const f = oauthFixture(), { callback } = await f.begin(); let clock = 100;
  const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
  try {
    f.exchange.mockImplementation(async () => { clock += 5001;
      return { access_token: "late", refresh_token: "late-refresh", expires_in: 60, token_type: "Bearer", scope: "read" }; });
    expect(await f.manager.complete(adminHash, callback, f.signal())).toMatchObject({ state: "failed", operation_state: "unknown" });
    expect([...f.links.values()][0]?.state).toBe("reauthorize");
  } finally { now.mockRestore(); }
});
