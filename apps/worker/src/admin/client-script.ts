import { ADMIN_CLIENT_SOURCE } from "../generated-admin-client.js";

/** Browser code is independently authored and syntax-checked at build time. */
export function adminScript(nonce?: string): string {
  return `<script${nonce === undefined ? "" : ` nonce="${nonce}"`}>${ADMIN_CLIENT_SOURCE}  </script>`;
}
