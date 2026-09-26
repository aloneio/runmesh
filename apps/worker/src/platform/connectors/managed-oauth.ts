import { auth, refreshAuthorization, type FetchLike, type OAuthClientProvider, type OAuthDiscoveryState, type StoredOAuthClientInformation, type StoredOAuthTokens } from '@modelcontextprotocol/client';
import { connectionClientMetadata } from '../../contracts/managed-connections.js';
import type { ManagedOAuthDocument, ManagedOAuthProtocol } from '../../contracts/managed-oauth.js';
import { catalogObject } from '../../contracts/catalog-json.js';
import { OAuthFault } from '../../contracts/oauth.js';
import { managedOAuthFetch, publicOAuthUrl, validDiscovery } from './managed-oauth-http.js';

const fault = (code: ConstructorParameters<typeof OAuthFault>[0]): never => { throw new OAuthFault(code); };

/** Owns SDK/provider formats only. Authorization and synchronous state claims
 * are supplied by the application; this adapter has no database or cipher. */
export function createManagedOAuthProtocol(send?: FetchLike): ManagedOAuthProtocol {
  function discoveryDocument(value: ManagedOAuthDocument, origin: string): OAuthDiscoveryState {
    const discovery = value as unknown as OAuthDiscoveryState;
    if (!catalogObject(value.authorizationServerMetadata) || !validDiscovery(discovery, origin)) return fault('provider_unsupported');
    return discovery;
  }
  function clientDocument(value: unknown): StoredOAuthClientInformation {
    const client = catalogObject(value);
    if (!client || typeof client.client_id !== 'string' || !client.client_id) return fault('invalid_callback');
    return client as unknown as StoredOAuthClientInformation;
  }
  function provider(base: string, state?: string, saved?: { discovery: OAuthDiscoveryState; client: StoredOAuthClientInformation; verifier: string }) {
    let discovery = saved?.discovery, client = saved?.client;
    let verifier = saved?.verifier;
    let tokens: StoredOAuthTokens | undefined, redirect: string | undefined;
    const value: OAuthClientProvider = {
      redirectUrl: connectionClientMetadata(base).redirect_uris[0]!, clientMetadata: connectionClientMetadata(base),
      clientMetadataUrl: base + "/admin/central/connections/client-metadata",
      state: () => state ?? fault("invalid_callback"), clientInformation: () => client, tokens: () => undefined,
      saveClientInformation: value => { client = value; },
      saveTokens: value => { tokens = value; },
      saveCodeVerifier: value => { verifier = value; }, codeVerifier: () => verifier ?? fault("invalid_callback"),
      discoveryState: () => discovery, saveDiscoveryState: value => {
        if (!validDiscovery(value, base)) return fault("provider_unsupported"); discovery = value;
      },
      redirectToAuthorization: url => {
        if (!discovery || !validDiscovery(discovery, base) || publicOAuthUrl(url.href, base) === undefined
          || url.searchParams.get("state") !== state || url.searchParams.get("code_challenge_method") !== "S256") return fault("provider_unsupported");
        redirect = url.href;
      },
      // Prevent the SDK's invalid-client / invalid-grant retry from replaying a
      // one-use code or rotating refresh token. Reconnection is explicit.
      invalidateCredentials: () => fault("reauthorization_required"),
    };
    return { value, discovery: () => discovery, client: () => client, verifier: () => verifier, tokens: () => tokens, redirect: () => redirect };
  }

  return {
    async begin(input) {
      const p = provider(input.origin, input.state);
      const result = await auth(p.value, { serverUrl: input.endpoint, forceReauthorization: true,
        fetchFn: managedOAuthFetch({ signal: input.signal, authorize: input.authorize, origin: input.origin,
          discovery: p.discovery, phase: 'begin', ...(send ? { send } : {}) }) });
      if (result !== 'REDIRECT' || !p.redirect() || !p.client() || !p.verifier() || !p.discovery()) return fault('provider_unsupported');
      return { authorization_url: p.redirect()!, discovery: { ...p.discovery()! }, client: p.client()!, verifier: p.verifier()! };
    },
    async complete(input) {
      if (typeof input.verifier !== 'string' || !input.verifier) return fault('invalid_callback');
      const discovery = discoveryDocument(input.discovery, input.origin), client = clientDocument(input.client);
      const p = provider(input.origin, undefined, { discovery, client, verifier: input.verifier });
      const result = await auth(p.value, { serverUrl: input.endpoint, authorizationCode: input.code,
        ...(input.issuer === undefined ? {} : { iss: input.issuer }),
        fetchFn: managedOAuthFetch({ signal: input.signal, authorize: input.authorize, origin: input.origin,
          discovery: p.discovery, phase: 'complete', ...(send ? { send } : {}) }) });
      if (result !== 'AUTHORIZED' || !p.tokens()) return fault('unavailable');
      return p.tokens()!;
    },
    async refresh(input) {
      const discovery = discoveryDocument(input.discovery, input.origin), client = clientDocument(input.client);
      return refreshAuthorization(discovery.authorizationServerUrl, { metadata: discovery.authorizationServerMetadata!,
        clientInformation: client, refreshToken: input.refresh_token,
        resource: new URL(discovery.resourceMetadata?.resource ?? input.endpoint),
        fetchFn: managedOAuthFetch({ signal: input.signal, authorize: input.authorize, origin: input.origin,
          discovery: () => discovery, phase: 'refresh', ...(send ? { send } : {}) }) });
    },
  };
}
