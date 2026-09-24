import type { OAuthPorts } from "../../contracts/oauth.js";
import { OAuthContext } from "./oauth-context.js";
import { createOAuthAccess } from "./oauth-access.js";
import { createOAuthFlow } from "./oauth-flow.js";

/** Construct once per central owner. Construction itself performs no I/O. */
export function createOAuthManager(ports: OAuthPorts) {
  const context = new OAuthContext(ports);
  return { ...createOAuthFlow(context), credential: createOAuthAccess(context) };
}
