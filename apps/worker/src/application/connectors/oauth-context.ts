import { OAUTH_LIMITS, OAuthFault, type OAuthLink, type OAuthPorts, type OAuthResult, type OAuthTokens } from "../../contracts/oauth.js";
import { oauthLinkKey, oauthTokenContext } from "../../contracts/oauth-values.js";
import { catalogDigest, catalogJson } from "../../contracts/catalog-json.js";
import { parseClientIdentity, type CapturedIdentity } from "../../contracts/identity.js";
import { parseProfile } from "../../contracts/connector-values.js";
import { withinDeadline } from "./deadline.js";

export const sameOAuthBinding = (a: OAuthLink["binding"], b: OAuthLink["binding"]) => catalogJson(a, 4096) === catalogJson(b, 4096);
export const checkOAuthAbort = (signal: AbortSignal, expired: () => boolean) => { if (signal.aborted || expired()) throw new OAuthFault("unavailable"); };

/** Owner-local orchestration support, not a second identity authority. */
export class OAuthContext {
  readonly flights = new Map<string, Promise<void>>();
  private active = 0;
  constructor(readonly ports: OAuthPorts) {}
  enter() { if (this.active >= OAUTH_LIMITS.active) throw new OAuthFault("capacity"); this.active++; }
  leave() { this.active--; }
  async admin(session: string, signal: AbortSignal) {
    if (!catalogDigest(session)) throw new OAuthFault("denied");
    const decision = await this.ports.admin(session, signal);
    if (decision !== "allowed") throw new OAuthFault(decision === "denied" ? "denied" : "unavailable");
  }
  async identify(principal: CapturedIdentity, signal: AbortSignal) {
    const result = await this.ports.identity(principal, signal);
    if (result.state !== "allowed") throw new OAuthFault(result.state === "denied" ? "denied" : "unavailable");
    const current = parseClientIdentity(result.identity);
    if (current === undefined) throw new OAuthFault("unavailable");
    if (current.client_id !== principal.client_id || current.secret_version !== principal.secret_version) throw new OAuthFault("denied");
  }
  async capture(profileId: string, principal: CapturedIdentity, signal: AbortSignal, expired: () => boolean) {
    const profile = parseProfile(this.ports.profile(profileId)), policy = this.ports.policy(profileId), redirect = this.ports.redirect();
    if (policy === undefined || redirect === undefined) throw new OAuthFault("disabled");
    if (profile === undefined || profile.profile_id !== profileId || profile.credential !== null || policy.profile_id !== profileId || policy.resource !== profile.endpoint) throw new OAuthFault("denied");
    const canonical = catalogJson([policy, redirect], 8192);
    if (canonical === undefined) throw new OAuthFault("invalid_request");
    const digest = await this.ports.hash(canonical), linkId = await this.ports.hash(oauthLinkKey(profileId, principal.client_id));
    if (!catalogDigest(digest) || !catalogDigest(linkId)) throw new OAuthFault("unavailable");
    const fence = async () => {
      await this.identify(principal, signal); checkOAuthAbort(signal, expired);
      const latest = parseProfile(this.ports.profile(profileId));
      if (latest?.revision !== profile.revision || latest.endpoint !== profile.endpoint || latest.credential !== null
        || catalogJson([this.ports.policy(profileId), this.ports.redirect()], 8192) !== canonical) throw new OAuthFault("denied");
    };
    await fence();
    return { profile, policy, redirect, linkId, canonical, fence,
      binding: { profile_id: profileId, client_id: principal.client_id, secret_version: principal.secret_version, endpoint: profile.endpoint, policy_digest: digest } };
  }
  retire(link: OAuthLink) {
    try {
      this.ports.repository.transition({ ...link, revision: link.revision + 1, state: "reauthorize", envelope: null, expires_at_ms: 0 }, link.revision, link.state);
    } catch { /* A concurrent revoke/new authorization wins; never overwrite it. */ }
  }
  async ready(link: OAuthLink, tokens: OAuthTokens, fence: () => Promise<void>): Promise<OAuthLink> {
    const next: OAuthLink = { ...link, revision: link.revision + 1, state: "ready", expires_at_ms: tokens.expires_at_ms, envelope: null };
    const envelope = await this.ports.cipher.seal(oauthTokenContext(next), tokens);
    await fence();
    const stored = { ...next, envelope };
    this.ports.repository.transition(stored, link.revision, link.state);
    return stored;
  }
  async bounded(action: (signal: AbortSignal, expired: () => boolean, changed: () => void) => Promise<OAuthResult>, parent: AbortSignal): Promise<OAuthResult> {
    const failure = (error: unknown, changed = false): OAuthResult => ({ state: "failed",
      code: error instanceof OAuthFault ? error.code : "unavailable", operation_state: changed ? "unknown" : "not_started" });
    try { this.enter(); } catch (error) { return failure(error); }
    let mutated = false;
    try {
      return await withinDeadline<OAuthResult>(parent, () => failure(new OAuthFault("unavailable"), mutated), async (signal, expired) => {
        try { return await action(signal, expired, () => { mutated = true; }); } catch (error) { return failure(error, mutated); }
      });
    } finally { this.leave(); }
  }
}
