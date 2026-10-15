import { publicMcpEndpoint } from "../contracts/remote-values.js";
import { resolvePublicOrigin } from "../public-origin.js";

export const CENTRAL_OAUTH_CALLBACK_PATH = "/admin/central/connections/callback";

/** Resolve the canonical public origin used by both rendered OAuth guidance
 * and protocol redirect_uri values. */
export function centralOAuthOrigin(request: Request, configured?: string): string {
  const origin = configured ?? resolvePublicOrigin(request);
  if (publicMcpEndpoint(origin) === undefined || new URL(origin).origin !== origin) throw new Error("invalid OAuth origin");
  return origin;
}

export function centralOAuthCallbackUrl(request: Request, configured?: string): string {
  return centralOAuthOrigin(request, configured) + CENTRAL_OAUTH_CALLBACK_PATH;
}
