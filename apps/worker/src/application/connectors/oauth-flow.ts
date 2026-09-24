import { OAUTH_LIMITS, OAuthFault, type OAuthLink, type OAuthResult } from "../../contracts/oauth.js";
import { oauthFlowContext, oauthLinkKey, oauthMetadata, oauthState, parseOAuthCallback, parseOAuthSelection, parseOAuthTokenResponse } from "../../contracts/oauth-values.js";
import { catalogDigest, catalogObject } from "../../contracts/catalog-json.js";
import { checkOAuthAbort, OAuthContext, sameOAuthBinding } from "./oauth-context.js";

/** One-use authorization-code flow. MCP credentials are not browser sessions. */
export function createOAuthFlow(ctx: OAuthContext) {
  const ports = ctx.ports;
  return {
    begin(session: string, input: unknown, parent: AbortSignal): Promise<OAuthResult> {
      return ctx.bounded(async (signal, expired, changed) => {
        const command = parseOAuthSelection(input);
        if (command === undefined) throw new OAuthFault("invalid_request");
        await ctx.admin(session, signal); checkOAuthAbort(signal, expired);
        const observed = await ctx.capture(command.profile_id, command.principal, signal, expired);
        const fence = async () => { await ctx.admin(session, signal); await observed.fence(); checkOAuthAbort(signal, expired); };
        if ((ports.repository.read(observed.linkId)?.revision ?? 0) !== command.expected_revision) throw new OAuthFault("conflict");
        await ports.transport.verify(observed.policy, signal, fence); checkOAuthAbort(signal, expired);
        const state = ports.random(), verifier = ports.random();
        if (!oauthState(state) || !oauthState(verifier) || state === verifier) throw new OAuthFault("unavailable");
        const hash = await ports.hash(state), challenge = await ports.challenge(verifier);
        if (!catalogDigest(hash) || !oauthState(challenge)) throw new OAuthFault("unavailable");
        const sealed = await ports.cipher.seal(oauthFlowContext(hash, session), { verifier });
        const link: OAuthLink = { schema_version: 1, link_id: observed.linkId, binding: observed.binding,
          revision: command.expected_revision + 1, state: "pending", expires_at_ms: 0, envelope: null };
        await fence();
        const now = ports.now(); changed();
        ports.repository.begin(link, { state_hash: hash, link_id: link.link_id, revision: link.revision,
          session_hash: session, expires_at_ms: now + OAUTH_LIMITS.flow_ttl_ms, verifier: sealed }, command.expected_revision, now);
        const url = new URL(observed.policy.authorization_endpoint);
        for (const [key, value] of Object.entries({ response_type: "code", client_id: observed.policy.oauth_client_id,
          redirect_uri: observed.redirect, resource: observed.policy.resource, scope: observed.policy.scopes.join(" "),
          code_challenge_method: "S256", code_challenge: challenge, state })) url.searchParams.set(key, value);
        return { state: "started", authorization_url: url.href, link: oauthMetadata(link) };
      }, parent);
    },
    complete(session: string, input: unknown, parent: AbortSignal): Promise<OAuthResult> {
      return ctx.bounded(async (signal, expired, changed) => {
        const command = parseOAuthCallback(input);
        if (command === undefined) throw new OAuthFault("invalid_callback");
        await ctx.admin(session, signal); checkOAuthAbort(signal, expired);
        const hash = await ports.hash(command.state), flow = ports.repository.flow(hash);
        if (flow === undefined || flow.session_hash !== session || flow.expires_at_ms <= ports.now()) throw new OAuthFault("invalid_callback");
        const old = ports.repository.read(flow.link_id);
        if (old === undefined) throw new OAuthFault("invalid_callback");
        const observed = await ctx.capture(old.binding.profile_id, old.binding, signal, expired);
        if (!sameOAuthBinding(old.binding, observed.binding) || command.iss !== observed.policy.issuer) throw new OAuthFault("invalid_callback");
        const fence = async () => { await ctx.admin(session, signal); await observed.fence(); checkOAuthAbort(signal, expired); };
        const decoded = catalogObject(await ports.cipher.open(oauthFlowContext(hash, session), flow.verifier));
        if (!oauthState(decoded?.verifier)) throw new OAuthFault("invalid_callback");
        await fence(); changed();
        const link = ports.repository.consume(hash, session, ports.now());
        const exchangeFence = async () => {
          await fence();
          const current = ports.repository.read(link.link_id);
          if (current?.revision !== link.revision || current.state !== "exchanging") throw new OAuthFault("denied");
        };
        try {
          if (command.code === undefined) { ctx.retire(link); throw new OAuthFault("denied"); }
          const raw = await ports.transport.exchange(observed.policy, observed.redirect, command.code, decoded.verifier, signal, exchangeFence);
          checkOAuthAbort(signal, expired);
          const tokens = parseOAuthTokenResponse(raw, observed.policy.scopes, ports.now());
          if (tokens === undefined) throw new OAuthFault("provider_unsupported");
          return { state: "linked", link: oauthMetadata(await ctx.ready(link, tokens, exchangeFence)) };
        } catch (error) { ctx.retire(link); throw error; }
      }, parent);
    },
    inspect(session: string, input: unknown, parent: AbortSignal): Promise<OAuthResult> {
      return ctx.bounded(async (signal, expired) => {
        const command = parseOAuthSelection(input);
        if (command === undefined) throw new OAuthFault("invalid_request");
        await ctx.admin(session, signal); checkOAuthAbort(signal, expired);
        const id = await ports.hash(oauthLinkKey(command.profile_id, command.principal.client_id));
        await ctx.admin(session, signal); checkOAuthAbort(signal, expired);
        const link = ports.repository.read(id);
        if (link === undefined) throw new OAuthFault("missing");
        return { state: "found", link: oauthMetadata(link) };
      }, parent);
    },
    revoke(session: string, input: unknown, parent: AbortSignal): Promise<OAuthResult> {
      return ctx.bounded(async (signal, expired, changed) => {
        const command = parseOAuthSelection(input);
        if (command === undefined) throw new OAuthFault("invalid_request");
        await ctx.admin(session, signal); checkOAuthAbort(signal, expired);
        const id = await ports.hash(oauthLinkKey(command.profile_id, command.principal.client_id));
        await ctx.admin(session, signal); checkOAuthAbort(signal, expired);
        const link = ports.repository.read(id);
        if (link === undefined) throw new OAuthFault("missing");
        if (link.revision !== command.expected_revision || link.binding.secret_version !== command.principal.secret_version) throw new OAuthFault("conflict");
        const next: OAuthLink = { ...link, revision: link.revision + 1, state: "revoked", expires_at_ms: 0, envelope: null };
        changed(); ports.repository.transition(next, link.revision, link.state);
        return { state: "revoked", link: oauthMetadata(next) };
      }, parent);
    },
  };
}
