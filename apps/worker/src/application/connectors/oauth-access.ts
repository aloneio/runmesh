import { OAUTH_LIMITS, OAuthFault, type CredentialLease, type OAuthLink } from "../../contracts/oauth.js";
import { oauthTokenContext, parseOAuthTokenResponse, parseStoredOAuthTokens } from "../../contracts/oauth-values.js";
import type { CapturedIdentity } from "../../contracts/identity.js";
import { catalogJson } from "../../contracts/catalog-json.js";
import { parseProfile } from "../../contracts/connector-values.js";
import type { ConnectionProfile } from "../../contracts/connectors.js";
import { withinDeadline } from "./deadline.js";
import { checkOAuthAbort, OAuthContext, sameOAuthBinding } from "./oauth-context.js";

/** Demand-driven refresh only. The persisted claim prevents rotating-token
 * replay on crash; a merged flight never suppresses each waiter's own fences. */
export function createOAuthAccess(ctx: OAuthContext) {
  const ports = ctx.ports;
  async function refresh(link: OAuthLink, observed: Awaited<ReturnType<OAuthContext["capture"]>>, signal: AbortSignal, expired: () => boolean, authorize: () => Promise<void>) {
    let claimed: OAuthLink | undefined;
    try {
      if (link.envelope === null) throw new OAuthFault("reauthorization_required");
      const tokens = parseStoredOAuthTokens(await ports.cipher.open(oauthTokenContext(link), link.envelope));
      if (tokens?.refresh_token === undefined) { ctx.retire(link); throw new OAuthFault("reauthorization_required"); }
      await observed.fence(); await authorize(); checkOAuthAbort(signal, expired);
      claimed = { ...link, revision: link.revision + 1, state: "refreshing" };
      ports.repository.transition(claimed, link.revision, "ready");
      const fence = async () => {
        await observed.fence(); await authorize(); checkOAuthAbort(signal, expired);
        const current = ports.repository.read(link.link_id);
        if (current?.revision !== claimed!.revision || current.state !== "refreshing") throw new OAuthFault("denied");
      };
      const raw = await ports.transport.refresh(observed.policy, tokens.refresh_token, signal, fence);
      checkOAuthAbort(signal, expired);
      const next = parseOAuthTokenResponse(raw, tokens.scopes, ports.now(), tokens.refresh_token);
      if (next === undefined) throw new OAuthFault("provider_unsupported");
      await ctx.ready(claimed, next, fence);
    } catch (error) { if (claimed) ctx.retire(claimed); throw error; }
  }
  return async (profile: ConnectionProfile, principal: CapturedIdentity, parent: AbortSignal, authorize: () => Promise<void>): Promise<CredentialLease> => {
    ctx.enter();
    try {
      const result = await withinDeadline<CredentialLease | undefined>(parent, () => undefined, async (signal, expired) => {
        await authorize(); checkOAuthAbort(signal, expired);
        let observed = await ctx.capture(profile.profile_id, principal, signal, expired);
        if (!observed.profile.enabled || observed.profile.revision !== profile.revision) throw new OAuthFault("denied");
        let link = ports.repository.read(observed.linkId);
        if (link === undefined || !sameOAuthBinding(link.binding, observed.binding)) throw new OAuthFault("reauthorization_required");
        if (link.state === "refreshing" || (link.state === "ready" && link.expires_at_ms <= ports.now() + OAUTH_LIMITS.refresh_margin_ms)) {
          let flight = ctx.flights.get(link.link_id);
          if (flight === undefined) {
            if (link.state !== "ready") throw new OAuthFault("reauthorization_required");
            const id = link.link_id;
            flight = refresh(link, observed, signal, expired, authorize).finally(() => { ctx.flights.delete(id); });
            ctx.flights.set(id, flight);
          }
          await flight; checkOAuthAbort(signal, expired);
          observed = await ctx.capture(profile.profile_id, principal, signal, expired); link = ports.repository.read(observed.linkId);
        }
        if (link?.state !== "ready" || link.envelope === null || !sameOAuthBinding(link.binding, observed.binding)) throw new OAuthFault("reauthorization_required");
        const tokens = parseStoredOAuthTokens(await ports.cipher.open(oauthTokenContext(link), link.envelope));
        await observed.fence(); await authorize(); checkOAuthAbort(signal, expired);
        if (tokens === undefined || tokens.expires_at_ms !== link.expires_at_ms || tokens.scopes.some(s => !observed.policy.scopes.includes(s))) throw new OAuthFault("unavailable");
        const selected = link;
        const current = (): boolean => {
          try {
            const value = ports.repository.read(selected.link_id), p = parseProfile(ports.profile(profile.profile_id));
            return value?.state === "ready" && value.revision === selected.revision && value.expires_at_ms > ports.now()
              && sameOAuthBinding(value.binding, observed.binding) && p?.revision === profile.revision && p.enabled
              && catalogJson([ports.policy(profile.profile_id), ports.redirect()], 8192) === observed.canonical;
          } catch { return false; }
        };
        if (!current()) throw new OAuthFault("reauthorization_required");
        return { credential: { kind: "bearer", token: tokens.access_token }, current };
      });
      if (result === undefined) throw new OAuthFault("unavailable");
      return result;
    } finally { ctx.leave(); }
  };
}
